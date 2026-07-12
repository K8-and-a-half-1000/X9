"""Improvement queue — planned skill / RAG / memory / test improvements.

A persistent, ordered list of improvement items ("cover X in the RAG
store", "add a test proving feature Y works") that the user or the model
appends to from the Queue page or chat. Items run one at a time, top-down,
through the SAME pipeline deep research uses (ResearchHandler with an
action category), so each run produces a research report whose action step
applies the improvement to the workspace. Pressing play on item N
processes every runnable item above it first and pauses after N completes.

Types map to research action categories: skill/rag/memory run as-is.
`test` runs as a `skill` action constrained to a `test-` prefixed skill
name, then ORCHESTRATES the created test through the agent loop and has an
LLM judge grade the run into a success-confidence % (0-100). If the
orchestration itself breaks (no test- skill produced, agent/judge
unreachable), the item errors — the "failure" outcome the test- rule
prescribes.

Single instance per process (get_improvement_queue()); app.py injects the
research handler + skills manager at startup, and the agent's manage_queue
tool talks to the same instance directly.
"""
import asyncio
import json
import logging
import re
import time
import uuid
from pathlib import Path
from typing import Dict, List, Optional

from src.constants import DATA_DIR
from core.atomic_io import atomic_write_json

logger = logging.getLogger(__name__)

QUEUE_FILE = str(Path(DATA_DIR) / "improvement_queue.json")

VALID_TYPES = ("skill", "rag", "memory", "test")
# Statuses: queued (runnable), running, done, skipped, error (runnable again).
_RUNNABLE = ("queued", "error")

# Per-item wall clock cap. Research itself gets max_time=600 but extraction /
# action phases run past it by design, so the queue guard sits far above.
ITEM_HARD_TIMEOUT = 45 * 60
RESEARCH_MAX_TIME = 600

_TEST_QUERY_TEMPLATE = (
    "Create a TEST skill that proves whether the following feature works:\n"
    "{description}\n\n"
    "Hard requirements for the skill:\n"
    "- The skill name MUST start with \"test-\".\n"
    "- It is a runnable test procedure: concrete numbered steps that exercise "
    "the feature for real and check the outcome, not documentation.\n"
    "- Include a Verification section stating the expected outcome of each check.\n"
    "- The final step must report an explicit success confidence percentage "
    "(0-100%) for whether the feature works."
)


class ImprovementQueue:
    """Ordered improvement items + a sequential run-until-target runner."""

    def __init__(self, queue_file: str = QUEUE_FILE):
        self._file = queue_file
        self._items: List[Dict] = self._load()
        # Anything left "running" by a previous process crashed mid-run —
        # put it back in line so the next play press retries it.
        changed = False
        for it in self._items:
            if it.get("status") == "running":
                it["status"] = "queued"
                changed = True
        if changed:
            self._save()
        # Injected by configure() at app startup.
        self._research_handler = None
        self._skills_manager = None
        # Runner state (in-memory only; the queue file never says "running"
        # across restarts because the asyncio task dies with the process).
        self._runner_task: Optional[asyncio.Task] = None
        self._current_id: Optional[str] = None
        self._target_id: Optional[str] = None
        self._progress: Dict = {}
        self._stop_requested = False

    def configure(self, research_handler=None, skills_manager=None) -> None:
        self._research_handler = research_handler
        self._skills_manager = skills_manager

    # ── persistence ──

    def _load(self) -> List[Dict]:
        try:
            data = json.loads(Path(self._file).read_text(encoding="utf-8"))
            items = data.get("items", [])
            return items if isinstance(items, list) else []
        except FileNotFoundError:
            return []
        except Exception:
            logger.warning("Could not read %s — starting empty", self._file, exc_info=True)
            return []

    def _save(self) -> None:
        atomic_write_json(self._file, {"items": self._items}, indent=2)

    # ── CRUD ──

    def list_items(self, owner: str = "") -> List[Dict]:
        return [dict(it) for it in self._items if it.get("owner", "") == owner]

    def get(self, item_id: str, owner: str = "") -> Optional[Dict]:
        it = self._find(item_id, owner)
        return dict(it) if it else None

    def _find(self, item_id: str, owner: str = "") -> Optional[Dict]:
        for it in self._items:
            if it.get("id") == item_id and it.get("owner", "") == owner:
                return it
        return None

    def add(self, type_: str, description: str, owner: str = "",
            added_by: str = "user") -> Dict:
        type_ = (type_ or "").strip().lower()
        description = (description or "").strip()
        if type_ not in VALID_TYPES:
            raise ValueError(f"type must be one of {', '.join(VALID_TYPES)}")
        if not description:
            raise ValueError("A description of what needs to improve is required.")
        item = {
            "id": uuid.uuid4().hex[:12],
            "type": type_,
            "description": description[:4000],
            "status": "queued",
            "owner": owner or "",
            "added_by": added_by,
            "created_at": time.time(),
            "updated_at": time.time(),
            "completed_at": None,
            "research_session_id": "",
            "test_skill": "",
            "confidence": None,
            "result_summary": "",
            "error": "",
        }
        self._items.append(item)  # new improvements join at the BOTTOM
        self._save()
        return dict(item)

    def update(self, item_id: str, owner: str = "", description: Optional[str] = None,
               type_: Optional[str] = None) -> Dict:
        it = self._find(item_id, owner)
        if it is None:
            raise KeyError(item_id)
        if it.get("status") == "running":
            raise RuntimeError("Item is running — stop the queue before editing it.")
        if description is not None:
            description = description.strip()
            if not description:
                raise ValueError("A description of what needs to improve is required.")
            it["description"] = description[:4000]
        if type_ is not None:
            type_ = type_.strip().lower()
            if type_ not in VALID_TYPES:
                raise ValueError(f"type must be one of {', '.join(VALID_TYPES)}")
            it["type"] = type_
        # An edited error item is a fresh plan — put it back in line.
        if it.get("status") == "error":
            it["status"] = "queued"
            it["error"] = ""
        it["updated_at"] = time.time()
        self._save()
        return dict(it)

    def delete(self, item_id: str, owner: str = "") -> bool:
        it = self._find(item_id, owner)
        if it is None:
            return False
        if it.get("status") == "running":
            raise RuntimeError("Item is running — stop the queue before deleting it.")
        self._items.remove(it)
        self._save()
        return True

    def set_skipped(self, item_id: str, skipped: bool, owner: str = "") -> Dict:
        it = self._find(item_id, owner)
        if it is None:
            raise KeyError(item_id)
        if it.get("status") == "running":
            raise RuntimeError("Item is running — stop the queue before skipping it.")
        if it.get("status") == "done":
            raise RuntimeError("Item is already completed.")
        it["status"] = "skipped" if skipped else "queued"
        if skipped:
            it["error"] = ""
        it["updated_at"] = time.time()
        self._save()
        return dict(it)

    # ── runner ──

    @property
    def running(self) -> bool:
        return self._runner_task is not None and not self._runner_task.done()

    def runner_state(self) -> Dict:
        return {
            "active": self.running,
            "current_id": self._current_id,
            "target_id": self._target_id,
            "progress": dict(self._progress),
        }

    def run_until(self, target_id: str, owner: str = "") -> Dict:
        """Start the queue: work top-down and pause after `target_id` completes."""
        if self._research_handler is None:
            raise RuntimeError("Improvement queue is not configured yet.")
        if self.running:
            raise RuntimeError("The queue is already running.")
        target = self._find(target_id, owner)
        if target is None:
            raise KeyError(target_id)
        if target.get("status") not in _RUNNABLE:
            raise RuntimeError("That item is not runnable (already completed or skipped).")
        self._stop_requested = False
        self._target_id = target_id
        self._runner_task = asyncio.create_task(self._run_loop(target_id, owner))
        return self.runner_state()

    def stop(self) -> Dict:
        """Pause the queue: cancel the in-flight research and requeue the item."""
        self._stop_requested = True
        sid = None
        if self._current_id:
            it = next((i for i in self._items if i.get("id") == self._current_id), None)
            if it:
                sid = it.get("research_session_id")
        if sid and self._research_handler is not None:
            try:
                self._research_handler.cancel_research(sid)
            except Exception:
                logger.debug("cancel_research failed", exc_info=True)
        return self.runner_state()

    def _next_runnable(self, target_id: str, owner: str) -> Optional[Dict]:
        """First runnable item from the top, never past the target."""
        for it in self._items:
            if it.get("owner", "") != owner:
                continue
            if it.get("status") in _RUNNABLE:
                return it
            if it.get("id") == target_id:
                return None  # target already done/skipped — nothing left to run
        return None

    async def _run_loop(self, target_id: str, owner: str) -> None:
        try:
            while not self._stop_requested:
                item = self._next_runnable(target_id, owner)
                if item is None:
                    break
                ok = await self._run_item(item, owner)
                if not ok:
                    break  # error or stop pauses the queue for the user to inspect
                if item.get("id") == target_id:
                    break  # target completed — pause here by design
        except Exception:
            logger.error("Improvement queue runner crashed", exc_info=True)
        finally:
            self._current_id = None
            self._target_id = None
            self._progress = {}
            self._runner_task = None

    async def _run_item(self, item: Dict, owner: str) -> bool:
        item["status"] = "running"
        item["error"] = ""
        item["updated_at"] = time.time()
        self._current_id = item["id"]
        self._progress = {"phase": "starting"}
        self._save()
        try:
            # Same endpoint chain as the Deep Research panel (lazy import —
            # routes are loaded after src at startup).
            from routes.research.research_routes import resolve_panel_endpoint
            ep_url, ep_model, ep_headers = resolve_panel_endpoint(owner)

            before = self._test_skill_names(owner) if item["type"] == "test" else set()

            sid = f"qi-{uuid.uuid4().hex[:12]}"
            item["research_session_id"] = sid
            self._save()
            category = "skill" if item["type"] == "test" else item["type"]
            query = (_TEST_QUERY_TEMPLATE.format(description=item["description"])
                     if item["type"] == "test" else item["description"])
            self._research_handler.start_research(
                session_id=sid,
                query=query,
                llm_endpoint=ep_url,
                llm_model=ep_model,
                llm_headers=ep_headers,
                max_time=RESEARCH_MAX_TIME,
                max_rounds=20,
                category=category,
                owner=owner,
            )
            status = await self._await_research(sid)
            if self._stop_requested or status == "cancelled":
                # Paused, not failed — back in line for the next play press.
                item["status"] = "queued"
                item["updated_at"] = time.time()
                self._save()
                return False
            if status != "done":
                raise RuntimeError(self._research_error(sid) or f"research ended '{status}'")

            if item["type"] == "test":
                confidence, summary, skill_name = await self._orchestrate_test(
                    item, before, ep_url, ep_model, ep_headers, owner)
                item["confidence"] = confidence
                item["test_skill"] = skill_name
                item["result_summary"] = summary
            item["status"] = "done"
            item["completed_at"] = time.time()
            item["updated_at"] = time.time()
            self._save()
            return True
        except Exception as e:
            logger.warning("Improvement item %s failed: %s", item.get("id"), e)
            item["status"] = "error"
            # HTTPException from endpoint resolution stringifies as "400: msg" —
            # surface just the human message on the card.
            item["error"] = str(getattr(e, "detail", None) or e)[:500]
            item["updated_at"] = time.time()
            self._save()
            return False

    async def _await_research(self, sid: str) -> str:
        """Poll the research handler until the job leaves 'running'."""
        deadline = time.monotonic() + ITEM_HARD_TIMEOUT
        while True:
            status = self._research_handler.get_status(sid)
            if status is None:
                raise RuntimeError("research session disappeared")
            self._progress = dict(status.get("progress") or {})
            st = status.get("status", "")
            if st != "running":
                return st
            if self._stop_requested:
                # stop() already asked the handler to cancel; keep polling so
                # the session winds down before we requeue the item.
                pass
            if time.monotonic() > deadline:
                try:
                    self._research_handler.cancel_research(sid)
                except Exception:
                    pass
                raise RuntimeError("improvement run exceeded the time limit")
            await asyncio.sleep(2.0)

    def _research_error(self, sid: str) -> str:
        try:
            task = self._research_handler._active_tasks.get(sid, {})
            if task.get("result"):
                return str(task["result"])[:300]
        except Exception:
            pass
        return ""

    # ── test orchestration ──

    def _test_skill_names(self, owner: str) -> set:
        if self._skills_manager is None:
            return set()
        try:
            return {
                str(s.get("name") or "")
                for s in self._skills_manager.load(owner=owner)
                if str(s.get("name") or "").startswith("test-")
            }
        except Exception:
            return set()

    def _pick_test_skill(self, before: set, owner: str) -> str:
        """The test- skill the research run just produced (diff against the
        pre-run snapshot; on a re-run that updated an existing skill, fall
        back to the newest test- skill)."""
        after = self._test_skill_names(owner)
        new = sorted(after - before)
        if new:
            return new[0]
        if self._skills_manager is None or not after:
            return ""
        try:
            skills = [s for s in self._skills_manager.load(owner=owner)
                      if str(s.get("name") or "").startswith("test-")]
            skills.sort(key=lambda s: s.get("updated_at") or s.get("created_at") or 0,
                        reverse=True)
            return str(skills[0].get("name") or "") if skills else ""
        except Exception:
            return ""

    async def _orchestrate_test(self, item: Dict, before: set,
                                ep_url: str, ep_model: str, ep_headers: Optional[Dict],
                                owner: str) -> tuple:
        """Run the produced test- skill through the agent loop and judge it.

        Returns (success_confidence 0-100, one-line summary, skill name).
        Raises when orchestration itself breaks — that's the test-rule
        "failure" outcome, surfaced as an errored item.
        """
        name = self._pick_test_skill(before, owner)
        if not name:
            raise RuntimeError("test orchestration failed: no test- skill was produced")
        md = self._skills_manager.read_skill_md(name, owner=owner)
        if not md:
            raise RuntimeError(f"test orchestration failed: cannot read skill '{name}'")

        self._progress = {"phase": "action", "message": f"Running test {name}..."}
        task = (
            f"Execute this test now and determine whether the feature works: "
            f"{item['description']}\n"
            f"End with an explicit success confidence percentage (0-100%)."
        )
        transcript = await self._run_test_skill(md, task, ep_url, ep_model, ep_headers, owner)
        if not transcript.strip():
            raise RuntimeError("test orchestration failed: the test run produced no output")

        self._progress = {"phase": "action", "message": "Judging test result..."}
        verdict = await self._judge_test_run(item["description"], md, transcript,
                                             ep_url, ep_model, ep_headers)
        if verdict is None:
            raise RuntimeError("test orchestration failed: could not judge the test run")
        return verdict["success_confidence"], verdict["summary"], name

    async def _run_test_skill(self, md: str, task: str, url: str, model: str,
                              headers: Optional[Dict], owner: str) -> str:
        """Drive the test skill through the real agent loop; return the
        condensed transcript. Same shape as the skills page's manual test."""
        from src.agent_loop import stream_agent_loop
        transcript: List[str] = []
        messages = [
            {"role": "system", "content":
                "You are RUNNING a TEST skill. Follow its procedure to exercise the "
                "feature for real, using your tools, step by step. Finish with an "
                "explicit success confidence percentage (0-100%) for whether the "
                "feature works.\n\n=== SKILL ===\n" + md},
            {"role": "user", "content": task},
        ]
        async for chunk in stream_agent_loop(url, model, messages, headers=headers,
                                             temperature=0.3, max_tokens=4096,
                                             max_rounds=8, owner=owner):
            if not chunk.startswith("data: ") or chunk.strip() == "data: [DONE]":
                continue
            try:
                d = json.loads(chunk[6:])
            except Exception:
                continue
            if d.get("delta"):
                transcript.append(d["delta"])
            elif d.get("type") == "tool_start":
                transcript.append(f"\n[tool {d.get('tool')}] "
                                  f"{str(d.get('command') or d.get('args') or '')[:300]}\n")
            elif d.get("type") == "tool_output":
                transcript.append(f"[output] {str(d.get('output') or '')[:600]}\n")
            elif d.get("type") == "agent_step":
                transcript.append(f"\n--- round {d.get('round')} ---\n")
        return "".join(transcript)

    async def _judge_test_run(self, description: str, skill_md: str, transcript: str,
                              url: str, model: str, headers: Optional[Dict]) -> Optional[Dict]:
        """LLM judge → {"success_confidence": 0-100, "summary": str} or None."""
        from src.llm_core import llm_call_async
        sys_prompt = (
            "You are a strict QA judge. A TEST skill was executed to prove whether a "
            "feature works. Given the FEATURE, the TEST SKILL, and the TRANSCRIPT of "
            "the run, decide how confident you are that the feature WORKS.\n\n"
            "- 80-100 = the test clearly exercised the feature and it worked.\n"
            "- 40-79 = partially proven, unclear, or the test only weakly exercised it.\n"
            "- 0-39 = the test ran and the feature did NOT behave as expected.\n"
            "Judge only what the transcript shows — never assume steps that aren't "
            "there. If you need to reason, do it inside <think></think> FIRST. Then "
            "output ONLY this JSON (no fences):\n"
            '{"success_confidence": 0-100, "summary": "one short sentence"}'
        )
        def _clip(t: str, limit: int = 20000) -> str:
            t = (t or "").strip() or "(no output produced)"
            if len(t) <= limit:
                return t
            head = limit // 4
            return t[:head] + "\n\n…[transcript trimmed]…\n\n" + t[-(limit - head):]
        user_msg = (
            f"=== FEATURE ===\n{description}\n\n"
            f"=== TEST SKILL ===\n{(skill_md or '')[:4000]}\n\n"
            f"=== TRANSCRIPT ===\n{_clip(transcript)}"
        )
        try:
            raw = await llm_call_async(
                url, model,
                [{"role": "system", "content": sys_prompt},
                 {"role": "user", "content": user_msg}],
                temperature=0.1, max_tokens=4096, headers=headers, timeout=180)
        except Exception as e:
            logger.warning("Test judge call failed: %s", e)
            return None
        text = re.sub(r"<think(?:ing)?>[\s\S]*?</think(?:ing)?>", "", raw or "", flags=re.I)
        text = re.sub(r"<think(?:ing)?>[\s\S]*$", "", text, flags=re.I).strip()
        a, b = text.find("{"), text.rfind("}")
        if a < 0 or b <= a:
            return None
        frag = text[a:b + 1]
        data = None
        for cand in (frag, re.sub(r",(\s*[}\]])", r"\1", frag)):
            try:
                data = json.loads(cand)
                break
            except Exception:
                continue
        if not isinstance(data, dict) or "success_confidence" not in data:
            return None
        try:
            conf = int(round(float(data["success_confidence"])))
        except (TypeError, ValueError):
            return None
        return {
            "success_confidence": max(0, min(100, conf)),
            "summary": str(data.get("summary", ""))[:300],
        }


_instance: Optional[ImprovementQueue] = None


def get_improvement_queue() -> ImprovementQueue:
    global _instance
    if _instance is None:
        _instance = ImprovementQueue()
    return _instance
