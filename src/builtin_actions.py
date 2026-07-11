"""
builtin_actions.py

Registry of built-in automation actions that can be executed by the task
scheduler without needing an LLM call.
"""

import logging
import os
import json
from datetime import datetime
from typing import Tuple

from src.auth_helpers import owner_filter
from core.platform_compat import IS_WINDOWS, find_bash
from core.constants import internal_api_base
from src.constants import DATA_DIR, DEEP_RESEARCH_DIR, COOKBOOK_STATE_FILE
from src.interactive_gate import wait_for_interactive_quiet

logger = logging.getLogger(__name__)


class TaskNoop(BaseException):
    """Raised by an action when it determined there's nothing to do.

    Inherits from BaseException (not Exception) so the standard
    `except Exception` wrappers each action uses for real error handling
    don't accidentally catch it. The scheduler explicitly catches TaskNoop,
    drops the queued TaskRun row, advances last_run / next_run, and exits
    silently. Nothing appears in the Activity log; the message is logged
    server-side only.
    """


class TaskDeferred(BaseException):
    """Raised when a task should run later without recording a skipped run."""

    def __init__(self, reason: str, delay_seconds: int = 20 * 60):
        super().__init__(reason)
        self.reason = reason
        self.delay_seconds = delay_seconds


async def action_tidy_sessions(owner: str, **kwargs) -> Tuple[str, bool]:
    """Delete empty sessions for the owner. Pure heuristic —
    the LLM folder-sort phase is skipped (user opted to keep this task
    LLM-free; sorting can be triggered manually via the Chats UI)."""
    try:
        import asyncio
        from src.session_actions import run_auto_sort
        result = await asyncio.wait_for(
            run_auto_sort(owner, skip_llm=True, delete_throwaway=False),
            timeout=60,
        )
        return result, True
    except asyncio.TimeoutError:
        logger.error("tidy_sessions action timed out")
        return "Chat session tidy timed out", False
    except Exception as e:
        logger.error(f"tidy_sessions action failed: {e}")
        return str(e), False


async def action_tidy_documents(owner: str, **kwargs) -> Tuple[str, bool]:
    """Run tidy on documents for the owner."""
    try:
        from src.document_actions import run_document_tidy
        result = await run_document_tidy(owner)
        return result, True
    except Exception as e:
        logger.error(f"tidy_documents action failed: {e}")
        return str(e), False


async def action_consolidate_memory(owner: str, **kwargs) -> Tuple[str, bool]:
    """Consolidate/deduplicate memories for the owner."""
    try:
        import json
        import re
        from src.constants import DATA_DIR
        from src.llm_core import llm_call_async_with_fallback
        from src.memory import MemoryManager

        manager = MemoryManager(DATA_DIR)
        all_memories = manager.load_all()

        _owner_clean = (owner or "").strip()
        text_limit = 2000

        def _memory_owner(mem: dict) -> str:
            return (mem.get("owner") or "").strip()

        # Built-in housekeeping can run without an owner. In that case scan all
        # memories, but keep every AI prompt/apply step owner-local.
        if _owner_clean:
            memory_groups = {
                _owner_clean: [m for m in all_memories if _memory_owner(m) == _owner_clean]
            }
        else:
            memory_groups = {}
            for mem in all_memories:
                memory_groups.setdefault(_memory_owner(mem), []).append(mem)

        memory_groups = {group_owner: group for group_owner, group in memory_groups.items() if group}
        if not memory_groups:
            raise TaskNoop("no memories to consolidate")

        total_removed = 0
        total_cleaned = 0
        total_scanned = 0
        removed_examples = []
        ai_reasons = []
        ai_used = False

        async def _try_ai_tidy_group(group_owner: str, group_memories: list) -> bool:
            nonlocal all_memories, total_removed, total_cleaned, total_scanned, ai_used
            if len(group_memories) < 2:
                return False

            from src.task_endpoint import resolve_task_candidates
            candidates = resolve_task_candidates(owner=group_owner or None)
            if not candidates:
                return False

            try:
                items = [
                    {
                        "id": m.get("id"),
                        "category": m.get("category", "fact"),
                        "text": (m.get("text") or "").strip()[:text_limit],
                        "truncated": len((m.get("text") or "").strip()) > text_limit,
                    }
                    for m in group_memories
                    if m.get("id") and (m.get("text") or "").strip()
                ]
                if len(items) < 2:
                    return False
                truncated_ids = {item["id"] for item in items if item.get("truncated")}
                prompt = (
                    "You are tidying a user's saved personal memories. Return ONLY raw JSON, no markdown.\n"
                    "Remove memories that are empty, broken, trivial conversation filler, duplicates, or obsolete "
                    "because a clearer newer memory replaces them. Preserve useful personal facts, preferences, "
                    "contacts, project context, and instructions. If memories conflict, keep the clearest/latest "
                    "one and drop the obsolete one.\n\n"
                    "JSON shape:\n"
                    "{\"keep\":[{\"id\":\"existing id\",\"text\":\"cleaned text\",\"category\":\"fact|preference|identity|event|contact|project|instruction\"}],"
                    "\"drop\":[{\"id\":\"existing id\",\"reason\":\"short reason\"}]}\n\n"
                    f"MEMORIES:\n{json.dumps(items, ensure_ascii=False)}"
                )
                await wait_for_interactive_quiet("memory consolidation action")
                raw = await llm_call_async_with_fallback(
                    candidates,
                    messages=[{"role": "user", "content": prompt}],
                    temperature=0.0,
                    max_tokens=4096,
                    timeout=120,
                )
                from src.text_helpers import strip_think

                raw = strip_think(raw or "", prose=False, prompt_echo=False).strip()
                raw = re.sub(r"^```(?:json)?\s*|\s*```$", "", raw, flags=re.MULTILINE).strip()
                start = raw.find("{")
                end = raw.rfind("}")
                if start != -1 and end != -1 and end > start:
                    decision = json.loads(raw[start:end + 1])
                    keep_items = decision.get("keep") if isinstance(decision, dict) else None
                    drop_items = decision.get("drop") if isinstance(decision, dict) else None
                    if isinstance(keep_items, list) and isinstance(drop_items, list):
                        by_id = {m.get("id"): m for m in group_memories if m.get("id")}
                        cleaned_by_id = {}
                        for item in keep_items:
                            if not isinstance(item, dict):
                                continue
                            mid = item.get("id")
                            if mid not in by_id:
                                continue
                            text = (item.get("text") or "").strip()
                            if not text:
                                continue
                            cleaned = {
                                "category": (item.get("category") or by_id[mid].get("category") or "fact").strip(),
                            }
                            original_text = (by_id[mid].get("text") or "").strip()
                            if len(original_text) <= text_limit:
                                cleaned["text"] = text
                            cleaned_by_id[mid] = cleaned

                        # Delete only memories the model EXPLICITLY dropped, never
                        # ones it merely omitted from `keep`. Treating the
                        # complement of `keep` as deletions meant a model that
                        # forgot to re-list an id (common) silently destroyed that
                        # memory. Honor the explicit `drop` set instead.
                        drop_ids = {
                            d.get("id")
                            for d in drop_items
                            if isinstance(d, dict) and d.get("id") in by_id
                        }
                        # Never delete a memory the model only saw truncated.
                        drop_ids -= truncated_ids

                        if drop_ids or cleaned_by_id:
                            changed_text = 0
                            group_ref_ids = {id(m) for m in group_memories}
                            kept_all = []
                            for mem in all_memories:
                                if id(mem) not in group_ref_ids:
                                    kept_all.append(mem)
                                    continue
                                mid = mem.get("id")
                                if mid in drop_ids:
                                    continue
                                cleaned = cleaned_by_id.get(mid) or {}
                                if mid in truncated_ids:
                                    cleaned.pop("text", None)
                                if cleaned.get("text") and cleaned["text"] != mem.get("text"):
                                    mem["text"] = cleaned["text"]
                                    changed_text += 1
                                if cleaned.get("category"):
                                    mem["category"] = cleaned["category"]
                                kept_all.append(mem)

                            removed = sum(1 for m in group_memories if m.get("id") in drop_ids)
                            total_scanned += len(group_memories)
                            if removed or changed_text:
                                all_memories = kept_all
                                total_removed += removed
                                total_cleaned += changed_text
                                ai_used = True
                                ai_reasons.extend([
                                    (d.get("reason") or "").strip()
                                    for d in drop_items
                                    if isinstance(d, dict) and (d.get("reason") or "").strip()
                                ])
                            return True
            except Exception as ai_err:
                logger.warning("AI memory tidy failed; falling back to duplicate cleanup: %s", ai_err)
            return False

        for group_owner, group_memories in memory_groups.items():
            if await _try_ai_tidy_group(group_owner, group_memories):
                continue

            seen = {}
            keep_refs = set()
            total_scanned += len(group_memories)
            for mem in group_memories:
                text = (mem.get("text") or "").strip()
                key = " ".join(text.lower().split())
                if not key:
                    if len(removed_examples) < 3:
                        removed_examples.append("(empty)")
                    continue
                if key in seen:
                    if len(removed_examples) < 3:
                        removed_examples.append(text[:60] + ("..." if len(text) > 60 else ""))
                    continue
                seen[key] = mem
                keep_refs.add(id(mem))

            group_removed = len(group_memories) - len(keep_refs)
            if group_removed == 0:
                continue

            group_ref_ids = {id(m) for m in group_memories}
            all_memories = [
                m for m in all_memories
                if id(m) not in group_ref_ids or id(m) in keep_refs
            ]
            total_removed += group_removed

        if total_removed or total_cleaned:
            manager.save(all_memories)
            if ai_used:
                reasons = ai_reasons[:3]
                reason_text = f": {'; '.join(reasons)}" if reasons else ""
                return (
                    f"AI tidied {total_scanned} memories: "
                    f"removed {total_removed}, cleaned {total_cleaned}{reason_text}",
                    True,
                )
            preview = "; ".join(removed_examples)
            extra = f" (+{total_removed - len(removed_examples)} more)" if total_removed > len(removed_examples) else ""
            return f"Removed {total_removed} duplicate(s) of {total_scanned}: {preview}{extra}", True

        raise TaskNoop(f"scanned {total_scanned} memories, no duplicates")
    except Exception as e:
        logger.error(f"consolidate_memory action failed: {e}")
        return str(e), False


# Registry: action name -> async function(owner, **kwargs) -> (result_str, success_bool)


async def _run_subprocess(argv, *, shell: bool = False, timeout: int = 120, label: str = "Command") -> Tuple[str, bool]:
    """Shared subprocess runner. Wraps the blocking subprocess.run in
    asyncio.to_thread so the event loop stays responsive."""
    import asyncio
    import subprocess
    try:
        result = await asyncio.to_thread(
            subprocess.run, argv, shell=shell, capture_output=True, text=True, timeout=timeout,
        )
        output = (result.stdout or "").strip()
        if result.returncode != 0 and result.stderr:
            output += "\nSTDERR: " + result.stderr.strip()
        return output or "(no output)", result.returncode == 0
    except subprocess.TimeoutExpired:
        return f"{label} timed out ({timeout}s)", False
    except Exception as e:
        return str(e), False


async def action_ssh_command(owner: str, command: str = "", host: str = "localhost", **kwargs) -> Tuple[str, bool]:
    """Run a shell command locally or on a remote host via SSH."""
    if not command:
        return "No command specified", False
    if host in ("localhost", "127.0.0.1", "local"):
        if IS_WINDOWS:
            bash = find_bash()
            if bash:
                return await _run_subprocess([bash, "-c", command], timeout=120, label="Command")
            return await _run_subprocess(command, shell=True, timeout=120, label="Command")
        return await _run_subprocess(["bash", "-c", command], timeout=120, label="Command")
    return await _run_subprocess(
        ["ssh", "-o", "ConnectTimeout=10", host, command], timeout=120, label="Command",
    )


async def action_run_script(owner: str, script: str = "", host: str = "", **kwargs) -> Tuple[str, bool]:
    """Run a script locally, or via SSH when a host is configured."""
    if not script:
        return "No script specified", False
    target_host = (host or os.getenv("X9_SCRIPT_HOST", "localhost")).strip()
    if target_host in ("", "localhost", "127.0.0.1", "local"):
        if IS_WINDOWS and find_bash():
            return await _run_subprocess([find_bash(), "-c", script], timeout=300, label="Script")
        return await _run_subprocess(script, shell=True, timeout=300, label="Script")
    return await _run_subprocess(["ssh", target_host, script], timeout=300, label="Script")


async def action_run_local(owner: str, script: str = "", **kwargs) -> Tuple[str, bool]:
    """Run a script locally (no SSH)."""
    if not script:
        return "No script specified", False
    if IS_WINDOWS and find_bash():
        return await _run_subprocess([find_bash(), "-c", script], timeout=300, label="Script")
    return await _run_subprocess(script, shell=True, timeout=300, label="Script")


async def action_tidy_research(owner: str, **kwargs) -> Tuple[str, bool]:
    """Remove only broken research files (empty or unparseable JSON).

    Research history lives entirely in data/deep_research/<id>.json and is NOT
    backed by chat-session rows — so a file must never be deleted just because
    no chat session matches its id. Only prune files that fail to load."""
    try:
        from pathlib import Path
        import json as _json
        research_dir = Path(DEEP_RESEARCH_DIR)
        if not research_dir.exists():
            raise TaskNoop("no research directory")
        files = list(research_dir.glob("*.json"))
        removed = []
        for p in files:
            try:
                txt = p.read_text(encoding="utf-8").strip()
                if not txt:
                    raise ValueError("empty file")
                _json.loads(txt)  # valid JSON → keep
            except Exception:
                p.unlink(missing_ok=True)
                removed.append(p.stem[:8])
        if not removed:
            raise TaskNoop(f"scanned {len(files)} research file(s), none broken")
        return f"Removed {len(removed)} broken research file(s) of {len(files)}", True
    except Exception as e:
        logger.error(f"tidy_research action failed: {e}")
        return str(e), False


async def action_daily_brief(owner: str, **kwargs) -> Tuple[str, bool]:
    """Build a short morning digest: active todos and pinned notes."""
    try:
        from datetime import datetime as _dt
        import json as _json

        from core.database import SessionLocal, Note

        today = _dt.now().replace(hour=0, minute=0, second=0, microsecond=0)
        # Single-user deploy: owner=None rows belong to the one user, so
        # including them in the brief is safe.
        _allow_null = True
        db = SessionLocal()
        try:
            # ----- Notes: pinned + non-archived todos with at least one undone item -----
            n_q = db.query(Note).filter(Note.archived == False)  # noqa: E712
            if owner:
                n_q = owner_filter(n_q, Note, owner, include_shared=_allow_null)
            notes = n_q.all()
        finally:
            db.close()

        # Pull active todo items from notes
        todo_lines: list[str] = []
        for n in notes:
            if n.note_type == "checklist" and n.items:
                try:
                    items = _json.loads(n.items)
                    pending = [it.get("text", "") for it in items if not it.get("done")]
                    for t in pending[:3]:
                        if t:
                            todo_lines.append(f"{n.title or 'Checklist'}: {t}")
                except Exception:
                    continue
            elif n.pinned and n.title:
                todo_lines.append(n.title)

        # ----- Compose -----
        # %-d is GNU-only; format the day with str() so the brief works on
        # Windows / non-glibc Python builds too.
        date_label = today.strftime(f"%A, %B {today.day}, %Y")

        plain = [f"Daily brief — {date_label}", ""]
        if todo_lines:
            plain.append("Todos:")
            for t in todo_lines[:10]:
                plain.append(f"  · {t}")
        else:
            plain.append("Todos: none active.")

        plain_body = "\n".join(plain)

        return plain_body, True
    except Exception as e:
        logger.error(f"daily_brief action failed: {e}")
        return str(e), False


async def action_test_skills(owner: str, **kwargs) -> Tuple[str, bool]:
    """Run the per-skill Test on every skill: agent runs the procedure in a
    sandbox, LLM judges the transcript, verdict is recorded on the skill.
    ADVISORY ONLY — only writes set_audit (never rewrites SKILL.md, never
    demotes status, never overrides confidence)."""
    try:
        from services.memory.skills import SkillsManager
        from src.constants import DATA_DIR
        from routes.skills_routes import _run_skill_test_once, _skill_test_task

        # #3 SCOPE GUARD: refuse to run on a None/empty owner — otherwise
        # `sm.load(owner=None)` returns every user's skills and we'd cross-
        # test (and write audit verdicts to) other users' data in a
        # multi-user deployment.
        if not owner:
            return "test_skills requires an owner on the task — refusing to run without scope.", False

        sm = SkillsManager(DATA_DIR)
        skills = sm.load(owner=owner)
        names = [s.get("name") for s in skills if s.get("name")]
        if not names:
            raise TaskNoop("no skills to test")

        from src.task_endpoint import resolve_task_candidates
        candidates = resolve_task_candidates(owner=owner)
        if not candidates:
            return "No Default/Utility model configured — set one in Settings.", False

        # #2 NO SILENT MODEL SWAP: if the configured model isn't served by the
        # endpoint, try a basename match — but fail loudly instead of grabbing
        # `avail[0]` which could be an embedding-only model and produce 36
        # garbage transcripts → 36 'unknown' verdicts with no hint why.
        url, model, headers = candidates[0]
        try:
            from src.llm_core import list_model_ids
            import os as _os

            selected = None
            mismatch_notes = []
            for cand_url, cand_model, cand_headers in candidates:
                avail = list_model_ids(cand_url, headers=cand_headers)
                if not avail or cand_model in avail:
                    selected = (cand_url, cand_model, cand_headers)
                    break
                base = _os.path.basename((cand_model or "").rstrip("/"))
                matched = next((a for a in avail if _os.path.basename(a.rstrip("/")) == base), None)
                if matched:
                    selected = (cand_url, matched, cand_headers)
                    break
                mismatch_notes.append(
                    f"{cand_model} not served by {cand_url}; available: "
                    f"{', '.join(avail[:8])}{'...' if len(avail) > 8 else ''}"
                )
            if selected:
                url, model, headers = selected
            elif mismatch_notes:
                return "No configured task fallback model is served. " + " | ".join(mismatch_notes[:3]), False
        except Exception as _e:
            logger.warning(f"test_skills model resolve check failed (continuing): {_e}")

        logger.info(f"test_skills: starting on {len(names)} skills, model={model}, owner={owner!r}")

        from collections import Counter
        tally = Counter()
        per_skill_log = []
        for skill in skills:
            name = skill.get("name")
            if not name:
                continue
            md = sm.read_skill_md(name, owner=owner) or ""
            if not md:
                tally["skipped"] += 1
                per_skill_log.append(f"{name}: skipped (no SKILL.md)")
                continue
            task = _skill_test_task(skill)
            try:
                transcript, verdict = await _run_skill_test_once(md, task, url, model, headers, owner)
                v = (verdict or {}).get("verdict") or "unknown"
                tally[v] += 1
                summary = (verdict or {}).get("summary") or ""
                tlen = len(transcript or "")
                detail = ""
                if v in ("unknown", "inconclusive", "fail", "needs_work"):
                    bits = []
                    if summary: bits.append(summary[:160])
                    if tlen < 200: bits.append(f"transcript {tlen}b")
                    if bits: detail = " — " + "; ".join(bits)
                per_skill_log.append(f"{name}: {v}{detail}")
                # #4 + #8 + #12: ONLY persist a real verdict (pass / needs_work /
                # fail / inconclusive). Skip 'unknown' — that's the judge's
                # "couldn't parse" sentinel, not a real result, and persisting
                # it pollutes the verified-badge UI. Also skip the confidence
                # rewrite entirely — update_skill() re-serialises SKILL.md
                # (contradicts "advisory only" docstring) and overwriting a
                # user-set value (e.g. 1.0 → 0.95) is destructive.
                if v in ("pass", "needs_work", "fail", "inconclusive"):
                    try:
                        sm.set_audit(name, v, by_teacher=False, worker_model=model, owner=owner)
                    except Exception as _e:
                        logger.warning(f"test_skills set_audit({name}) failed: {_e}")
                if v == "unknown":
                    logger.warning(f"test_skills: {name} → unknown — {summary[:200]}; transcript_len={tlen}")
            except Exception as e:
                logger.exception(f"test_skills: {name} errored")
                tally["error"] += 1
                per_skill_log.append(f"{name}: error — {str(e)[:200]}")

        parts = []
        for k in ("pass", "needs_work", "fail", "inconclusive", "unknown", "skipped", "error"):
            if tally.get(k):
                parts.append(f"{tally[k]} {k}")
        header = f"Tested {len(names)} skill(s): " + (" · ".join(parts) or "0")
        # Multi-line result: summary first, then per-skill detail. The Tasks
        # Activity feed renders this verbatim, so the user can see per-skill
        # outcomes + the judge's "why" without checking uvicorn stdout.
        body = "\n".join(per_skill_log)
        return f"{header}\nmodel={model}\n\n{body}", True
    except TaskNoop:
        raise
    except Exception as e:
        logger.error(f"test_skills action failed: {e}")
        return str(e), False


async def action_audit_skills(owner: str, **kwargs) -> Tuple[str, bool]:
    """Run the real skills audit pipeline for skills that have not been audited.

    Unlike test_skills, this uses the same audit logic as the UI Audit all flow:
    metadata narrowing, self-edit/retry, optional teacher rewrite, necessity
    tagging, and publish/draft finalization from the user's confidence threshold.
    """
    try:
        from services.memory.skills import SkillsManager
        from src.constants import DATA_DIR
        from routes.skills_routes import (
            _resolve_audit_models, _run_audit_all_job, _skill_audit_jobs,
        )

        if not owner:
            return "audit_skills requires an owner — refusing to run without scope.", False

        key = (owner or "",)
        existing = _skill_audit_jobs.get(key)
        if existing and existing.get("status") == "running":
            raise TaskNoop("skill audit already running")

        sm = SkillsManager(DATA_DIR)
        skills = sm.load(owner=owner)
        names = [
            s.get("name") for s in skills
            if s.get("name") and not s.get("audit_verdict")
        ]
        if not names:
            raise TaskNoop("no unaudited skills")

        url, model, headers, teacher = _resolve_audit_models()
        try:
            from src.llm_core import seconds_since_model_activity
            recent = seconds_since_model_activity(url, model)
        except Exception:
            recent = None
        if recent is not None and recent < (20 * 60):
            raise TaskDeferred(
                f"audit model {model} was used {int(recent)}s ago; waiting for quiet window",
                delay_seconds=20 * 60,
            )

        import time as _time
        _skill_audit_jobs[key] = {
            "status": "running", "scope": "scheduled-unchecked", "model": model,
            "teacher": teacher[1] if teacher else None,
            "total": len(names), "done": 0, "current": None,
            "results": [], "log": [
                f"Scheduled audit of {len(names)} unaudited skill(s) with {model}"
                + (f"; teacher {teacher[1]}" if teacher else "")
            ],
            "started": _time.time(), "cancel": False,
        }
        await _run_audit_all_job(key, sm, names, url, model, headers, teacher, owner)
        job = _skill_audit_jobs.get(key, {})
        counts = {}
        for r in job.get("results", []):
            k = r.get("result") or "unknown"
            counts[k] = counts.get(k, 0) + 1
        summary = " · ".join(f"{v} {k}" for k, v in sorted(counts.items())) or "0 results"
        return f"Audited {job.get('done', 0)}/{len(names)} unaudited skill(s): {summary}", True
    except TaskNoop:
        raise
    except Exception as e:
        logger.error(f"audit_skills action failed: {e}")
        return str(e), False


async def action_ping_notes(owner: str, **kwargs) -> Tuple[str, bool]:
    """Background note-due scanner. Fires a reminder for any note whose
    `due_date` falls in the current ±5-minute window and hasn't been pinged
    within the last 25 minutes.

    State (`data/note_pings.json`): {note_id: iso_ts_of_last_ping}. Pruned
    on each run by dropping entries for notes that are gone/archived/replied.
    """
    try:
        import json as _json
        import time as _time
        from datetime import datetime as _dt, timezone as _tz, timedelta as _td
        from pathlib import Path as _P
        from core.database import SessionLocal as _SL, Note as _N

        # Per-owner state file so cache-pruning doesn't cross-delete other
        # users' entries (review C4). Legacy path kept as fallback so a
        # single-user install (empty owner) doesn't lose its history.
        _owner_slug = "".join(c if (c.isalnum() or c in "-_.@") else "_" for c in (owner or "default"))
        STATE = _P(DATA_DIR) / f"note_pings_{_owner_slug}.json"
        STATE.parent.mkdir(parents=True, exist_ok=True)
        # One-time migration: if legacy global file exists and per-owner file
        # doesn't, seed from global (entries for OTHER owners still get pruned
        # on their first run — acceptable, prevents silent loss).
        _legacy = _P(DATA_DIR) / "note_pings.json"
        if _legacy.exists() and not STATE.exists():
            try:
                STATE.write_text(_legacy.read_text(encoding="utf-8"), encoding="utf-8")
            except Exception:
                pass
        # Scanner ticks every 60s in _note_pings_loop. 90s window guarantees
        # every note's due time lands inside at least one tick's window.
        WINDOW_SEC = 90
        REPING_MIN = 25     # don't re-ping same note more often than this

        def _parse_due(s: str):
            """Accept '2026-05-29T16:31' (local) or '...Z' (UTC). Returns UTC datetime."""
            if not s:
                return None
            try:
                # Handle the JS-style 'Z' suffix.
                if s.endswith("Z"):
                    return _dt.fromisoformat(s[:-1]).replace(tzinfo=_tz.utc)
                # Naive → assume local server time.
                d = _dt.fromisoformat(s)
                if d.tzinfo is None:
                    d = d.astimezone().astimezone(_tz.utc)
                return d.astimezone(_tz.utc)
            except Exception:
                return None

        try:
            cache = _json.loads(STATE.read_text(encoding="utf-8")) if STATE.exists() else {}
        except Exception:
            cache = {}

        db = _SL()
        try:
            q = db.query(_N).filter(_N.archived == False)  # noqa: E712
            q = q.filter(_N.due_date.isnot(None), _N.due_date != "")
            if owner:
                # Match owner OR legacy null-owner notes (single-user installs).
                q = owner_filter(q, _N, owner)
            notes = q.all()
            if not notes:
                raise TaskNoop("no notes with due dates")

            now = _dt.now(_tz.utc)
            window = _td(seconds=WINDOW_SEC)
            reping_cutoff = now - _td(minutes=REPING_MIN)
            seen_ids = set()
            sent = []

            for n in notes:
                seen_ids.add(n.id)
                due = _parse_due(n.due_date)
                if not due:
                    continue
                # Inside the ±5min window?
                if abs((due - now).total_seconds()) > window.total_seconds():
                    continue
                # Recently pinged? Skip.
                last = cache.get(n.id)
                if last:
                    try:
                        if isinstance(last, dict):
                            last = last.get("at")
                        last_dt = _dt.fromisoformat(str(last))
                        if last_dt.tzinfo is None:
                            last_dt = last_dt.replace(tzinfo=_tz.utc)
                        if last_dt >= reping_cutoff:
                            continue
                    except Exception:
                        pass
                # Compose + dispatch.
                title = (n.title or "Reminder").strip() or "Reminder"
                body_parts = []
                if n.content:
                    body_parts.append(n.content[:400])
                # Items: list pending checklist entries inline.
                if n.items:
                    try:
                        items = _json.loads(n.items)
                        pending = [
                            it.get("text", "")
                            for it in items
                            if not it.get("done") and not it.get("checked")
                        ]
                        if pending:
                            body_parts.append("Pending:\n" + "\n".join(f"- {t}" for t in pending[:8]))
                    except Exception:
                        pass
                body = "\n\n".join(p for p in body_parts if p) or title
                try:
                    from routes.note_routes import dispatch_reminder
                    await dispatch_reminder(
                        title=title, note_body=body, note_id=n.id,
                        owner=n.owner or owner or "",
                    )
                    cache[n.id] = now.isoformat()
                    sent.append(title)
                except Exception as e:
                    logger.warning(f"ping_notes: dispatch failed for {n.id}: {e}")

            # Prune cache entries for notes that no longer exist.
            for stale in [k for k in cache if k not in seen_ids]:
                cache.pop(stale, None)

            try:
                STATE.write_text(_json.dumps(cache), encoding="utf-8")
            except Exception as e:
                logger.warning(f"ping_notes: cache write failed: {e}")

            if not sent:
                raise TaskNoop(f"scanned {len(notes)} note(s), none due in ±{WINDOW_SEC}s")
            preview = "; ".join(sent[:3])
            extra = f" (+{len(sent) - 3} more)" if len(sent) > 3 else ""
            return f"Pinged {len(sent)} note(s): {preview}{extra}", True
        finally:
            db.close()
    except TaskNoop:
        raise
    except Exception as e:
        logger.exception("ping_notes action failed")
        return str(e), False


async def action_cookbook_serve(
    owner: str,
    task_name: str = "",
    progress_cb=None,
    command: str = "",
    **kwargs,
) -> Tuple[str, bool]:
    """Launch a Cookbook model serve as a scheduled task.

    `command` is the JSON config string the task carries in `prompt`,
    of shape: {"preset": "name"} OR {"repo_id": "...", "cmd": "...", "host": "..."}.
    Optional `end_after_min: N` schedules a hard-stop N minutes after launch
    (handled by cookbook_serve_lifecycle_loop in src/cookbook_serve_lifecycle.py).
    """
    import json
    import time as _time
    import httpx
    from pathlib import Path
    from core.middleware import INTERNAL_TOOL_HEADER, INTERNAL_TOOL_TOKEN
    from core.atomic_io import atomic_write_json

    headers = {INTERNAL_TOOL_HEADER: INTERNAL_TOOL_TOKEN}
    try:
        cfg = json.loads(command or "{}")
    except Exception:
        return f"Invalid JSON config: {command!r}", False
    if not isinstance(cfg, dict):
        return "Config must be a JSON object", False

    # Resolve the preset (if named) OR fall through with explicit fields.
    preset_name = (cfg.get("preset") or "").strip()
    repo_id = (cfg.get("repo_id") or "").strip()
    cmd = (cfg.get("cmd") or "").strip()
    host = (cfg.get("host") or cfg.get("remote_host") or "").strip()
    try:
        end_after_min = int(cfg.get("end_after_min") or 0)
    except Exception:
        end_after_min = 0
    set_default = bool(cfg.get("set_default", True))

    state_path = Path(COOKBOOK_STATE_FILE)
    try:
        state = json.loads(state_path.read_text(encoding="utf-8")) if state_path.exists() else {}
    except Exception:
        state = {}

    # Preset lookup. Try three matching strategies in order so the
    # schedule still works even when the user's preset is named
    # differently from the model's short name:
    #
    #   1. Exact preset.name == preset_name (case-insensitive)
    #   2. preset.model / preset.modelId == repo_id  (caller knows the repo)
    #   3. preset.model's short name (after final /) == preset_name
    #
    # Without #2 and #3, scheduling "Qwen3.5-397B-A17B-AWQ" failed when
    # the saved preset was named "vllm-qwen-397b" or had the model field
    # populated with the full HF repo path. Either should resolve.
    def _short(name: str) -> str:
        return (name or "").rsplit("/", 1)[-1].lower()

    if not cmd or not repo_id:
        presets = state.get("presets") or []
        chosen = None
        # Strategy 1: exact name match.
        if preset_name:
            chosen = next(
                (p for p in presets if isinstance(p, dict)
                 and (p.get("name") or "").lower() == preset_name.lower()),
                None,
            )
        # Strategy 2: repo_id matches the preset's model field.
        if chosen is None and repo_id:
            chosen = next(
                (p for p in presets if isinstance(p, dict)
                 and (p.get("model") or p.get("modelId") or "").lower() == repo_id.lower()),
                None,
            )
        # Strategy 3: model's short name matches the preset_name.
        if chosen is None and preset_name:
            chosen = next(
                (p for p in presets if isinstance(p, dict)
                 and _short(p.get("model") or p.get("modelId") or "") == preset_name.lower()),
                None,
            )
        if chosen is not None:
            repo_id = repo_id or chosen.get("model") or chosen.get("modelId") or ""
            cmd = cmd or (chosen.get("cmd") or "").strip()
            host = host or chosen.get("host") or chosen.get("remoteHost") or ""
    if not repo_id or not cmd or cmd.startswith("(adopted"):
        # Surface what we tried so the user can name their preset to match.
        preset_names = [(p.get("name") or "") for p in (state.get("presets") or []) if isinstance(p, dict)]
        hint = f" Saved presets: {preset_names!r}" if preset_names else ""
        return (f"No launchable config for {preset_name!r} (repo_id={repo_id!r}). "
                f"Check Cookbook → Presets has a real cmd, not 'adopted'.{hint}", False)

    # Resolve env_prefix etc. from the host's saved cookbook server entry,
    # matching the chat agent's serve_model path.
    body = {"repo_id": repo_id, "cmd": cmd}
    if host:
        body["remote_host"] = host
    env = (state.get("env") or {})
    srv = next(
        (s for s in (env.get("servers") or [])
         if isinstance(s, dict) and (s.get("host") == host or s.get("name") == host)),
        {},
    )
    if srv.get("env") == "venv" and srv.get("envPath"):
        body["env_prefix"] = f"source {srv['envPath']}/bin/activate"
    elif srv.get("env") == "conda" and srv.get("envPath"):
        body["env_prefix"] = f"conda activate {srv['envPath']}"
    if srv.get("hfToken"): body["hf_token"] = srv["hfToken"]
    if srv.get("port"): body["ssh_port"] = str(srv["port"])
    if srv.get("platform"): body["platform"] = srv["platform"]

    try:
        async with httpx.AsyncClient(timeout=30) as client:
            r = await client.post(f"{internal_api_base()}/api/model/serve",
                                  json=body, headers=headers)
            data = r.json() if r.content else {}
    except Exception as e:
        return f"Launch HTTP failed: {e}", False
    if not data.get("ok"):
        return f"Launch rejected: {data.get('error') or data.get('detail') or 'unknown'}", False

    sid = data.get("session_id") or ""
    endpoint_id = data.get("endpoint_id") or ""
    # Scheduled serves are usually meant to become the active local model for
    # chat/tools while their time window is open. Persist both endpoint and
    # model so task/utility/default resolution does not keep routing to a stale
    # API fallback. Allow explicit opt-out with {"set_default": false}.
    if endpoint_id and set_default:
        try:
            selected_model = repo_id
            try:
                from core.database import SessionLocal as _SL, ModelEndpoint as _ME
                _db = _SL()
                try:
                    _ep = _db.query(_ME).filter(_ME.id == endpoint_id).first()
                    if _ep and _ep.cached_models:
                        _models = json.loads(_ep.cached_models or "[]")
                        if isinstance(_models, list) and _models:
                            selected_model = str(_models[0])
                finally:
                    _db.close()
            except Exception:
                pass
            from src.settings import load_settings as _load_settings, save_settings as _save_settings
            _settings = _load_settings()
            _settings["default_endpoint_id"] = endpoint_id
            _settings["default_model"] = selected_model
            # Keep background tasks aligned unless the user explicitly chose a
            # separate task model.
            if not (_settings.get("task_endpoint_id") or "").strip():
                _settings["task_endpoint_id"] = endpoint_id
                _settings["task_model"] = selected_model
            if not (_settings.get("utility_endpoint_id") or "").strip():
                _settings["utility_endpoint_id"] = endpoint_id
                _settings["utility_model"] = selected_model
            _save_settings(_settings)
            if owner:
                from routes.prefs_routes import _load_for_user, _save_for_user
                _prefs = _load_for_user(owner)
                _prefs["default_endpoint_id"] = endpoint_id
                _prefs["default_model"] = selected_model
                if not (_prefs.get("utility_endpoint_id") or "").strip():
                    _prefs["utility_endpoint_id"] = endpoint_id
                    _prefs["utility_model"] = selected_model
                _save_for_user(owner, _prefs)
        except Exception as e:
            logger.warning(f"cookbook_serve: default endpoint update failed: {e}")
    # Register the new task in cookbook_state.json + stamp it with our
    # scheduler-owner markers. /api/model/serve spawns the tmux session
    # but leaves the state-write to the UI — when a scheduled action
    # launches a serve from server-side, NOBODY writes the task into
    # state, so the Cookbook tab never shows it. We do the write here.
    if sid:
        try:
            # Re-read fresh (the route may have updated state already).
            try:
                fresh = json.loads(state_path.read_text(encoding="utf-8"))
            except Exception:
                fresh = {}
            if not isinstance(fresh, dict):
                fresh = {}
            tasks = fresh.get("tasks") if isinstance(fresh.get("tasks"), list) else []
            existing = next(
                (t for t in tasks if isinstance(t, dict) and t.get("sessionId") == sid),
                None,
            )
            if existing is None:
                display_name = repo_id.split("/")[-1] if "/" in repo_id else repo_id
                ssh_port = str(srv.get("port") or cfg.get("ssh_port") or "")
                platform = str(srv.get("platform") or cfg.get("platform") or "linux")
                placeholder = (
                    f"Launched by scheduled task {task_name!r} — waiting for tmux output…\n"
                    f"  session: {sid}\n"
                    f"  target:  {host or 'local'}\n"
                    f"  cmd:     {cmd[:200]}{'…' if len(cmd) > 200 else ''}"
                )
                existing = {
                    "id": sid,
                    "sessionId": sid,
                    "name": display_name,
                    "modelId": repo_id,
                    "type": "serve",
                    "status": "running",
                    "output": placeholder,
                    "ts": int(_time.time() * 1000),
                    "payload": {"repo_id": repo_id, "remote_host": host or "", "_cmd": cmd},
                    "remoteHost": host or "",
                    "sshPort": ssh_port or "",
                    "platform": platform or "linux",
                    "_serveReady": False,
                    "_endpointAdded": bool(endpoint_id),
                }
                tasks.append(existing)
            # Stamp ownership + end-at on the task entry.
            existing["_scheduledByTask"] = task_name or ""
            existing["_scheduledByOwner"] = owner or ""
            if endpoint_id:
                existing["_endpointId"] = endpoint_id
                existing["endpointId"] = endpoint_id
                existing["_endpointAdded"] = True
            if end_after_min > 0:
                existing["_scheduledStopAtMs"] = int(_time.time() * 1000) + end_after_min * 60 * 1000
            fresh["tasks"] = tasks
            atomic_write_json(state_path, fresh)
        except Exception as e:
            logger.warning(f"cookbook_serve: state register/stamp failed: {e}")
    # Don't try to render absolute clock time in the message — the
    # server's clock may run in UTC, the user reads it as local,
    # and the offset depends on the user's TZ which the action doesn't
    # have a reliable handle on. The Tasks UI already shows the RUN
    # timestamp in the user's local time right above this message, so
    # "stops 8 min after that" gives the user everything they need.
    if end_after_min:
        return (
            f"Launched {repo_id} (session {sid}); stops {end_after_min} min after this ran",
            True,
        )
    return f"Launched {repo_id} (session {sid})", True


BUILTIN_ACTIONS = {
    "tidy_sessions": action_tidy_sessions,
    "tidy_documents": action_tidy_documents,
    "consolidate_memory": action_consolidate_memory,
    "tidy_research": action_tidy_research,
    "daily_brief": action_daily_brief,
    "ssh_command": action_ssh_command,
    "run_script": action_run_script,
    "run_local": action_run_local,
    "test_skills": action_test_skills,
    "audit_skills": action_audit_skills,
    "cookbook_serve": action_cookbook_serve,
    # ping_notes removed from the registry — runs only inside `_note_pings_loop`.
}

# Descriptions for the UI/API
BUILTIN_ACTION_INFO = {
    "tidy_sessions": "Clean up empty chat sessions and auto-sort into folders",
    "tidy_documents": "Remove junk/empty documents",
    "consolidate_memory": "Remove duplicate memories",
    "tidy_research": "Remove orphaned research files (sessions that were deleted)",
    "daily_brief": "Build a morning digest: active todos and pinned notes",
    "ssh_command": "Run a shell command on a local or remote host",
    "run_script": "Run a script locally or on X9_SCRIPT_HOST",
    "test_skills": "Run the per-skill Test on every skill: agent run + LLM judge → records verdict on the skill (pass/needs_work/fail/inconclusive). Advisory only — never rewrites or demotes anything.",
    "audit_skills": "Audit unaudited skills after enough new skills are added: test, narrow metadata, self-edit/retry, optional teacher rewrite, tag duplicates/trivial skills, and publish/draft using the auto-approve threshold.",
}
