# src/research_actions.py
"""Post-research actions for the side-effect research formats.

Deep research categories ``skill``, ``rag`` and ``memory`` don't just write
a report — after the research loop finishes they apply the result to the
workspace so it is usable immediately:

  skill  — pick the best matching skill found on GitHub, fetch its bundle,
           trim it to the essentials, and install it into the local skill
           library (published, so the agent sees it on the next turn).
  rag    — format the gathered findings as reference chunks and ingest
           them into the RAG vector store (live — searchable right away).
  memory — distill cheat-sheet facts / best practices backed by trusted
           sources into memory entries.

``run_category_action`` returns a markdown section that the research
handler appends to the saved report. Failures never destroy the report:
every path returns an explanatory note instead of raising.

Per-format configuration lives in settings.json under the
``research_format_*`` keys (editable in Brain → Settings → Research formats).
"""
import asyncio
import json
import logging
import re
from typing import Callable, Dict, List, Optional

from src.research_utils import strip_thinking, is_low_quality
from src.settings import get_setting

logger = logging.getLogger(__name__)

# Hard wall-clock cap for a whole action (LLM calls + network + ingestion).
ACTION_TIMEOUT_SECONDS = 600

ACTION_CATEGORIES = ("skill", "rag", "memory")

_REPORT_SNIPPET_CHARS = 9000
_SKILL_MD_SNIPPET_CHARS = 14000


def _clip(text: str, limit: int) -> str:
    text = text or ""
    return text if len(text) <= limit else text[:limit] + "\n…(truncated)"


def _strip_code_fence(text: str) -> str:
    text = (text or "").strip()
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z]*\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
    return text.strip()


def _parse_json_object(text: str) -> Optional[Dict]:
    text = _strip_code_fence(text)
    try:
        parsed = json.loads(text)
        return parsed if isinstance(parsed, dict) else None
    except json.JSONDecodeError:
        pass
    match = re.search(r"\{[\s\S]*\}", text)
    if match:
        try:
            parsed = json.loads(match.group())
            return parsed if isinstance(parsed, dict) else None
        except json.JSONDecodeError:
            pass
    return None


def _parse_json_list(text: str) -> List:
    text = _strip_code_fence(text)
    try:
        parsed = json.loads(text)
        if isinstance(parsed, list):
            return parsed
    except json.JSONDecodeError:
        pass
    match = re.search(r"\[[\s\S]*\]", text)
    if match:
        try:
            parsed = json.loads(match.group())
            if isinstance(parsed, list):
                return parsed
        except json.JSONDecodeError:
            pass
    return []


async def _llm(endpoint: str, model: str, headers: Optional[Dict],
               prompt: str, *, temperature: float = 0.2,
               max_tokens: int = 4096, timeout: int = 180) -> str:
    from src.llm_core import llm_call_async
    response = await llm_call_async(
        url=endpoint,
        model=model,
        messages=[{"role": "user", "content": prompt}],
        temperature=temperature,
        max_tokens=max_tokens,
        headers=headers,
        timeout=timeout,
    )
    return strip_thinking(response)


def _parse_config_list(raw: str) -> List[str]:
    """Split a settings textarea value (newlines and/or commas) into items."""
    if not raw or not isinstance(raw, str):
        return []
    return [p.strip() for p in re.split(r"[,\n]+", raw) if p.strip()]


# ---------------------------------------------------------------------------
# Dispatcher
# ---------------------------------------------------------------------------
async def run_category_action(
    category: str,
    *,
    question: str,
    report: str,
    findings: List[Dict],
    session_id: str,
    llm_endpoint: str,
    llm_model: str,
    llm_headers: Optional[Dict] = None,
    owner: str = "",
    progress_callback: Optional[Callable] = None,
    memory_manager=None,
    memory_vector=None,
    skills_manager=None,
) -> str:
    """Run the post-research action for a side-effect category.

    Returns a markdown section to append to the report (possibly an error
    note). Never raises.
    """
    def emit(message: str):
        if progress_callback:
            try:
                progress_callback({"phase": "action", "message": message})
            except Exception:
                pass

    try:
        if category == "skill":
            return await _skill_action(
                question=question, report=report, findings=findings,
                llm_endpoint=llm_endpoint, llm_model=llm_model,
                llm_headers=llm_headers, owner=owner, emit=emit,
                skills_manager=skills_manager,
            )
        if category == "rag":
            return await _rag_action(
                question=question, report=report, findings=findings,
                session_id=session_id, owner=owner, emit=emit,
            )
        if category == "memory":
            return await _memory_action(
                question=question, report=report, findings=findings,
                session_id=session_id,
                llm_endpoint=llm_endpoint, llm_model=llm_model,
                llm_headers=llm_headers, owner=owner, emit=emit,
                memory_manager=memory_manager, memory_vector=memory_vector,
            )
        return ""
    except Exception as e:
        logger.error("Research %s action failed: %s", category, e, exc_info=True)
        return (
            f"## {category.capitalize()} Action Failed\n\n"
            f"The research completed, but applying the result failed: {e}"
        )


# ---------------------------------------------------------------------------
# skill — find, fetch, trim, install
# ---------------------------------------------------------------------------
_SKILL_PICK_PROMPT = """\
You are selecting an existing agent skill to install into a local skill library.

**Research question:** {question}

**Research report (describes candidate skills that were found):**
{report}

**Candidate URLs collected during research:**
{urls}

**Preferred skill repositories:** {repos}

Pick the ONE GitHub URL that points at the best matching skill — a repository
folder containing a SKILL.md, or the SKILL.md file itself. Only github.com or
raw.githubusercontent.com URLs can be fetched.

Return ONLY a JSON object, nothing else:
{{"url": "https://github.com/...", "name": "short-skill-name", "reason": "one sentence"}}
If none of the candidates is a real fetchable skill on GitHub, return {{"url": null}}
"""

_SKILL_TRIM_PROMPT = """\
You are trimming an imported agent skill: keep the essentials, cut everything \
that is not needed in this workspace.

The local skill library uses exactly this SKILL.md shape:

---
name: <kebab-case-slug>
description: <one line — what the skill does>
category: <kebab-case category>
tags: [tag1, tag2]
status: {status}
---

## When to Use
<one short paragraph>

## Procedure
1. <concrete step>
2. <concrete step>

## Pitfalls
- <mistake to avoid>

## Verification
- <how to check it worked>

**The skill was researched for:** {question}

**Original SKILL.md (from {url}):**
{content}

Rules:
- Keep the procedure complete and concrete — the skill must work on its own
- Inline any essential content the original keeps in separate asset files; \
bundled asset files are NOT installed
- Drop platform-specific sections that don't apply, marketing prose, \
changelogs, and long example transcripts
- Keep frontmatter minimal: name, description, category, tags, status
{extra}
Return ONLY the trimmed SKILL.md file content, starting with `---`.
"""

_SKILL_AUTHOR_PROMPT = """\
No existing skill could be fetched from GitHub, so write a NEW agent skill \
distilled from research findings.

Use exactly this SKILL.md shape:

---
name: <kebab-case-slug>
description: <one line — what the skill does>
category: <kebab-case category>
tags: [tag1, tag2]
status: {status}
---

## When to Use
<one short paragraph>

## Procedure
1. <concrete step>
2. <concrete step>

## Pitfalls
- <mistake to avoid>

## Verification
- <how to check it worked>

**The skill should cover:** {question}

**Research findings to distill:**
{report}
{extra}
Return ONLY the SKILL.md file content, starting with `---`.
"""


def _github_urls_from(findings: List[Dict], report: str) -> List[str]:
    """Candidate skill URLs: every GitHub link seen in findings or the report."""
    urls: List[str] = []
    seen = set()
    for f in findings or []:
        u = (f.get("url") or "").strip() if isinstance(f, dict) else ""
        if u and ("github.com" in u or "raw.githubusercontent.com" in u) and u not in seen:
            seen.add(u)
            urls.append(u)
    for m in re.finditer(r"https?://(?:www\.)?(?:github\.com|raw\.githubusercontent\.com)/[^\s)\]\"'>]+", report or ""):
        u = m.group(0).rstrip(".,;")
        if u not in seen:
            seen.add(u)
            urls.append(u)
    return urls[:40]


async def _skill_action(*, question, report, findings, llm_endpoint, llm_model,
                        llm_headers, owner, emit, skills_manager) -> str:
    from services.memory.skills import SkillsManager
    from services.memory.skill_format import Skill
    from services.memory.skill_importer import fetch_skill_bundle, pick_skill_md, SkillImportError

    if skills_manager is None:
        from src.constants import DATA_DIR
        skills_manager = SkillsManager(DATA_DIR)

    repos = get_setting("research_format_skill_repos", "anthropics/skills") or ""
    auto_publish = bool(get_setting("research_format_skill_auto_publish", True))
    extra = (get_setting("research_format_skill_instructions", "") or "").strip()
    extra_block = f"- {extra}\n" if extra else ""
    status = "published" if auto_publish else "draft"

    candidates = _github_urls_from(findings, report)

    # 1) Pick the best skill source URL
    skill_url = None
    if candidates:
        emit("Selecting the best matching skill…")
        pick_raw = await _llm(
            llm_endpoint, llm_model, llm_headers,
            _SKILL_PICK_PROMPT.format(
                question=question,
                report=_clip(report, _REPORT_SNIPPET_CHARS),
                urls="\n".join(f"- {u}" for u in candidates),
                repos=repos or "(none configured)",
            ),
            temperature=0.1, max_tokens=512, timeout=120,
        )
        picked = _parse_json_object(pick_raw) or {}
        url_val = picked.get("url")
        if isinstance(url_val, str) and url_val.strip().lower() not in ("", "null", "none"):
            skill_url = url_val.strip()

    # 2) Fetch + trim, or author from findings
    original_md = ""
    bundle_assets = 0
    if skill_url:
        emit("Fetching skill bundle from GitHub…")
        try:
            files, _src = await asyncio.to_thread(fetch_skill_bundle, skill_url)
            _rel, original_md = pick_skill_md(files)
            bundle_assets = max(0, len(files) - 1)
        except SkillImportError as e:
            logger.warning("Skill fetch failed for %s: %s", skill_url, e)
            emit(f"Fetch failed ({e}) — authoring from findings instead")
            skill_url = None
        except Exception as e:
            logger.warning("Skill fetch failed for %s: %s", skill_url, e)
            skill_url = None

    if original_md:
        emit("Trimming skill to essentials…")
        trimmed = await _llm(
            llm_endpoint, llm_model, llm_headers,
            _SKILL_TRIM_PROMPT.format(
                status=status, question=question, url=skill_url,
                content=_clip(original_md, _SKILL_MD_SNIPPET_CHARS),
                extra=extra_block,
            ),
            temperature=0.2, max_tokens=4096, timeout=180,
        )
        trimmed = _strip_code_fence(trimmed)
        try:
            sk = Skill.from_markdown(trimmed)
            usable = bool(sk.procedure or sk.body_extra or sk.when_to_use)
        except Exception:
            sk, usable = None, False
        if not usable:
            # Trim pass produced junk — install the original untouched.
            logger.warning("Skill trim produced unusable output; installing original")
            sk = Skill.from_markdown(original_md)
            trimmed = original_md
        sk.status = status
        install_files = {"SKILL.md": sk.to_markdown()}
        emit("Installing skill…")
        installed = skills_manager.import_bundle_from_files(
            install_files, owner=owner or None, source_url=skill_url, category="",
        )
        name = installed.get("name", sk.name)
        trim_note = (
            f"trimmed SKILL.md from {len(original_md):,} to {len(trimmed):,} chars"
            + (f", dropped {bundle_assets} bundled asset file(s)" if bundle_assets else "")
        )
        how = (
            f"usable immediately — invoke with `/{name}` or let the agent pick it up"
            if status == "published"
            else "saved as a draft — review and publish it in Brain → Skills"
        )
        return (
            "## Skill Installed\n\n"
            f"- **Skill:** `{name}` — {installed.get('description', '')}\n"
            f"- **Source:** [{skill_url}]({skill_url})\n"
            f"- **Status:** {status} ({how})\n"
            f"- **Trimmed:** {trim_note}\n"
        )

    # 3) Fallback: author a new skill from the findings
    emit("No fetchable skill found — authoring one from findings…")
    authored = await _llm(
        llm_endpoint, llm_model, llm_headers,
        _SKILL_AUTHOR_PROMPT.format(
            status=status, question=question,
            report=_clip(report, _REPORT_SNIPPET_CHARS),
            extra=extra_block,
        ),
        temperature=0.3, max_tokens=4096, timeout=180,
    )
    try:
        sk = Skill.from_markdown(_strip_code_fence(authored))
    except Exception as e:
        return (
            "## Skill Action Failed\n\n"
            f"No fetchable skill was found on GitHub, and authoring one from the "
            f"findings failed: {e}"
        )
    if not (sk.procedure or sk.body_extra):
        return (
            "## Skill Action Failed\n\n"
            "No fetchable skill was found on GitHub, and the authored fallback "
            "had no usable procedure. Try re-running with a more specific query."
        )
    emit("Installing authored skill…")
    installed = skills_manager.add_skill(
        name=sk.name,
        description=sk.description,
        category=sk.category or "general",
        tags=sk.tags,
        when_to_use=sk.when_to_use,
        procedure=sk.procedure,
        pitfalls=sk.pitfalls,
        verification=sk.verification,
        status=status,
        source="learned",
        confidence=0.75,
        owner=owner or None,
    )
    name = installed.get("name", sk.name)
    if installed.get("_deduped"):
        return (
            "## Skill Already Present\n\n"
            f"A near-identical skill `{installed.get('_duplicate_of', name)}` "
            "already exists in the library, so nothing new was installed.\n"
        )
    how = (
        f"usable immediately — invoke with `/{name}` or let the agent pick it up"
        if status == "published"
        else "saved as a draft — review and publish it in Brain → Skills"
    )
    return (
        "## Skill Installed\n\n"
        f"- **Skill:** `{name}` — {installed.get('description', '')}\n"
        "- **Source:** authored from the research findings (no matching "
        "skill found in the repositories)\n"
        f"- **Status:** {status} ({how})\n"
    )


# ---------------------------------------------------------------------------
# rag — format findings and ingest into the vector store
# ---------------------------------------------------------------------------
async def _rag_action(*, question, report, findings, session_id, owner, emit) -> str:
    from src.rag_singleton import get_rag_manager

    rag = get_rag_manager()
    if rag is None or not getattr(rag, "healthy", False):
        return (
            "## RAG Ingestion Skipped\n\n"
            "The RAG vector store is unavailable (ChromaDB not reachable), so "
            "the collected data was NOT ingested. The report above still holds "
            "everything that was gathered — re-run the RAG format once ChromaDB "
            "is up."
        )

    try:
        max_chunks = int(get_setting("research_format_rag_max_chunks", 200))
    except (TypeError, ValueError):
        max_chunks = 200
    max_chunks = max(1, min(2000, max_chunks))

    emit("Formatting data for the RAG store…")
    docs = []
    filename = f"research-{session_id}"

    def _meta(source: str, chunk_id: int) -> Dict:
        return {
            "source": source,
            "filename": filename,
            "directory": "deep_research",
            "type": "research",
            "chunk_id": chunk_id,
            "owner": owner or "",
            "query": question[:300],
        }

    # The report for the rag format IS the formatted dataset — ingest it first.
    chunk_id = 0
    for chunk in rag._split_into_chunks(report or "", 1000):
        docs.append((chunk, _meta(f"research:{session_id}", chunk_id)))
        chunk_id += 1

    # Then the per-source raw findings, attributed to their origin URL.
    source_urls = set()
    for f in findings or []:
        if not isinstance(f, dict):
            continue
        url = (f.get("url") or "").strip()
        title = (f.get("title") or url or "Untitled").strip()
        summary = (f.get("summary") or "").strip()
        evidence = (f.get("evidence") or "").strip()
        body = "\n\n".join(p for p in (summary, evidence) if p)
        if not url or not body or is_low_quality(body):
            continue
        source_urls.add(url)
        text = f"# {title}\nSource: {url}\n\n{body}"
        for chunk in rag._split_into_chunks(text, 1000):
            docs.append((chunk, _meta(url, chunk_id)))
            chunk_id += 1

    if not docs:
        return (
            "## RAG Ingestion Skipped\n\n"
            "No usable data was gathered, so nothing was ingested."
        )

    dropped = max(0, len(docs) - max_chunks)
    docs = docs[:max_chunks]

    emit(f"Ingesting {len(docs)} chunks into RAG…")
    result = await asyncio.to_thread(rag.add_documents_batch, docs)
    if not result.get("success", False):
        return (
            "## RAG Ingestion Failed\n\n"
            f"Ingestion did not complete: {result.get('message', 'unknown error')}. "
            "The report above still holds everything that was gathered."
        )

    added = result.get("added_count", 0)
    dup_note = f" ({len(docs) - added} already present)" if added < len(docs) else ""
    note = f" ({dropped} chunk(s) dropped by the max-chunks limit — raise it in Brain → Settings)" if dropped else ""
    return (
        "## Added to RAG\n\n"
        f"- **Ingested:** {added} new chunk(s){dup_note} from {len(source_urls)} "
        f"web source(s) plus the compiled report{note}\n"
        f"- **Tagged as:** `{filename}` (type `research`)\n"
        "- **Usable immediately:** enable the RAG toggle in chat and ask about "
        "the topic — retrieval is live, no re-index needed\n"
    )


# ---------------------------------------------------------------------------
# memory — distill trusted facts / best practices into memories
# ---------------------------------------------------------------------------
_MEMORY_DISTILL_PROMPT = """\
Extract up to {max_items} concise memory entries from this research — the \
cheat-sheet facts, best practices, and pointers to training material worth \
remembering long-term.

**Research question:** {question}

**Research report:**
{report}

Rules for each entry:
- One atomic, self-contained statement (max ~2 sentences) that stands alone \
without the report
- ONLY include entries backed by a trusted source cited in the report \
(official documentation, vendor docs, standards bodies, well-established \
references){trusted_note}
- Skip opinions, speculation, and anything without a clear source
{extra}
Return ONLY a JSON array, nothing else:
[{{"text": "…", "category": "fact", "source_url": "https://…"}}]
"""


async def _memory_action(*, question, report, findings, session_id,
                         llm_endpoint, llm_model, llm_headers, owner, emit,
                         memory_manager, memory_vector) -> str:
    if memory_manager is None:
        from src.memory import MemoryManager
        from src.constants import DATA_DIR
        memory_manager = MemoryManager(DATA_DIR)

    try:
        max_items = int(get_setting("research_format_memory_max_items", 12))
    except (TypeError, ValueError):
        max_items = 12
    max_items = max(1, min(50, max_items))
    trusted_domains = _parse_config_list(
        get_setting("research_format_memory_trusted_domains", "")
    )
    trusted_note = (
        f"; treat these domains as the trusted allowlist: {', '.join(trusted_domains)}"
        if trusted_domains else ""
    )
    extra = (get_setting("research_format_memory_instructions", "") or "").strip()
    extra_block = f"- {extra}\n" if extra else ""

    emit("Distilling memories from findings…")
    raw = await _llm(
        llm_endpoint, llm_model, llm_headers,
        _MEMORY_DISTILL_PROMPT.format(
            max_items=max_items,
            question=question,
            report=_clip(report, _REPORT_SNIPPET_CHARS),
            trusted_note=trusted_note,
            extra=extra_block,
        ),
        temperature=0.2, max_tokens=4096, timeout=180,
    )
    items = _parse_json_list(raw)

    entries = []
    for item in items[:max_items]:
        if not isinstance(item, dict):
            continue
        text = (item.get("text") or "").strip()
        if not text or len(text) < 8:
            continue
        category = (item.get("category") or "fact").strip().lower()
        if not re.fullmatch(r"[a-z][a-z0-9_-]{0,30}", category):
            category = "fact"
        entry = memory_manager.add_entry(
            text, source="research", category=category, owner=owner or None,
        )
        src_url = (item.get("source_url") or "").strip()
        metadata = {"research_id": session_id}
        if src_url:
            metadata["url"] = src_url
        entry["metadata"] = metadata
        entries.append(entry)

    if not entries:
        return (
            "## Memory Distillation Skipped\n\n"
            "No trustworthy, self-contained facts could be distilled from the "
            "findings — nothing was saved to memory."
        )

    emit(f"Saving {len(entries)} memories…")
    memories = memory_manager.load_all()
    memories.extend(entries)
    memory_manager.save(memories)

    indexed = 0
    if memory_vector is not None and getattr(memory_vector, "healthy", False):
        for e in entries:
            try:
                memory_vector.add(e["id"], e["text"])
                indexed += 1
            except Exception:
                pass

    lines = "\n".join(f"- {e['text']}" for e in entries)
    vec_note = "" if indexed == len(entries) else (
        " (vector index unavailable — entries are keyword-searchable and will "
        "be vector-indexed on the next rebuild)"
    )
    return (
        "## Saved to Memory\n\n"
        f"{len(entries)} memories saved{vec_note} — curate them in Brain → Memories:\n\n"
        f"{lines}\n"
    )
