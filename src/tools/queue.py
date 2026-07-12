"""Improvement-queue tool implementation.

Lets the agent plan skill/rag/memory/test improvements together with the
user by adding items to the sidebar Queue page (and listing / removing /
skipping them). Deliberately NO run/start action: how far the queue
auto-processes is the user's call, from the Queue page's play buttons.
"""
from typing import Dict, Optional

from src.tools._common import _parse_tool_args

_STATUS_MARK = {
    "queued": "·",
    "running": "▶",
    "done": "✓",
    "skipped": "○",
    "error": "✗",
}


async def do_manage_queue(content: str, owner: Optional[str] = None) -> Dict:
    """Add, list, remove, or skip items on the improvement queue.
    Args (JSON): {"action": "add|list|remove|skip",
                  "type": "skill|rag|memory|test", "description": "...",
                  "id": "<item id>", "skipped": true|false}."""
    from src.improvement_queue import get_improvement_queue, VALID_TYPES
    try:
        args = _parse_tool_args(content) if content.strip().startswith("{") else {}
    except ValueError:
        return {"error": "Invalid JSON arguments", "exit_code": 1}
    if not isinstance(args, dict):
        args = {}
    action = (args.get("action") or "list").lower()
    queue = get_improvement_queue()
    owner = owner or ""

    if action == "add":
        type_ = (args.get("type") or "").strip().lower()
        description = (args.get("description") or args.get("text") or "").strip()
        try:
            item = queue.add(type_, description, owner=owner, added_by="model")
        except ValueError as e:
            return {"error": str(e), "exit_code": 1}
        return {
            "output": (
                f"Queued {item['type']} improvement (id {item['id']}): "
                f"{item['description'][:120]}. It joined the bottom of the Queue "
                f"page — the user decides when to run it."
            ),
            "item_id": item["id"],
            "ui_event": "queue_updated",
            "exit_code": 0,
        }

    if action in ("remove", "delete"):
        item_id = (args.get("id") or "").strip()
        if not item_id:
            return {"error": "Provide the item id (from action='list')."}
        try:
            deleted = queue.delete(item_id, owner=owner)
        except RuntimeError as e:
            return {"error": str(e), "exit_code": 1}
        if not deleted:
            return {"error": f"Queue item '{item_id}' not found."}
        return {"output": f"Removed queue item '{item_id}'.",
                "ui_event": "queue_updated", "exit_code": 0}

    if action == "skip":
        item_id = (args.get("id") or "").strip()
        if not item_id:
            return {"error": "Provide the item id (from action='list')."}
        skipped = args.get("skipped", True)
        try:
            item = queue.set_skipped(item_id, bool(skipped), owner=owner)
        except KeyError:
            return {"error": f"Queue item '{item_id}' not found."}
        except RuntimeError as e:
            return {"error": str(e), "exit_code": 1}
        state = "skipped" if item["status"] == "skipped" else "back in the queue"
        return {"output": f"Item '{item_id}' is now {state}.",
                "ui_event": "queue_updated", "exit_code": 0}

    # default: list — top-down queue order (the order they will run in)
    items = queue.list_items(owner=owner)
    if not items:
        return {"output": ("The improvement queue is empty. Add items with "
                           f"action='add' (type: {', '.join(VALID_TYPES)} + description)."),
                "exit_code": 0}
    rows = []
    for it in items:
        mark = _STATUS_MARK.get(it.get("status", ""), "·")
        extra = ""
        if it.get("type") == "test" and it.get("confidence") is not None:
            extra = f" — {it['confidence']}% success confidence"
        elif it.get("status") == "error" and it.get("error"):
            extra = f" — {str(it['error'])[:80]}"
        rows.append(f"- {mark} [{it['type']}] {it['description'][:140]} "
                    f"(id {it['id']}, {it['status']}){extra}")
    running = queue.runner_state()
    note = "\nThe queue is currently running." if running.get("active") else ""
    return {"output": f"Improvement queue ({len(items)} item"
                      f"{'s' if len(items) != 1 else ''}, top runs first):\n"
                      + "\n".join(rows) + note,
            "exit_code": 0}
