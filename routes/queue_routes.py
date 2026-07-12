"""Improvement queue routes — /api/queue/*.

Backs the sidebar Queue page: an ordered list of skill/rag/memory/test
improvements the user (or the model, via the manage_queue tool) plans, then
runs top-down through the deep-research pipeline. See src/improvement_queue.py.
"""

import logging
from typing import Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from src.auth_helpers import require_user
from src.improvement_queue import VALID_TYPES

logger = logging.getLogger(__name__)


class QueueAddRequest(BaseModel):
    type: str
    description: str = Field(min_length=1, max_length=4000)


class QueueEditRequest(BaseModel):
    description: Optional[str] = Field(default=None, max_length=4000)
    type: Optional[str] = None


class QueueSkipRequest(BaseModel):
    skipped: bool = True


def setup_queue_routes(improvement_queue) -> APIRouter:
    router = APIRouter(prefix="/api/queue", tags=["queue"])

    def _state(user: str) -> dict:
        return {
            "items": improvement_queue.list_items(owner=user),
            "runner": improvement_queue.runner_state(),
            "types": list(VALID_TYPES),
        }

    @router.get("")
    async def queue_list(request: Request):
        user = require_user(request)
        return _state(user)

    @router.post("")
    async def queue_add(body: QueueAddRequest, request: Request):
        user = require_user(request)
        try:
            item = improvement_queue.add(body.type, body.description, owner=user)
        except ValueError as e:
            raise HTTPException(400, str(e))
        return {"item": item, **_state(user)}

    @router.patch("/{item_id}")
    async def queue_edit(item_id: str, body: QueueEditRequest, request: Request):
        user = require_user(request)
        try:
            item = improvement_queue.update(item_id, owner=user,
                                            description=body.description,
                                            type_=body.type)
        except KeyError:
            raise HTTPException(404, "Queue item not found")
        except ValueError as e:
            raise HTTPException(400, str(e))
        except RuntimeError as e:
            raise HTTPException(409, str(e))
        return {"item": item, **_state(user)}

    @router.post("/{item_id}/skip")
    async def queue_skip(item_id: str, body: QueueSkipRequest, request: Request):
        user = require_user(request)
        try:
            item = improvement_queue.set_skipped(item_id, body.skipped, owner=user)
        except KeyError:
            raise HTTPException(404, "Queue item not found")
        except RuntimeError as e:
            raise HTTPException(409, str(e))
        return {"item": item, **_state(user)}

    @router.delete("/{item_id}")
    async def queue_delete(item_id: str, request: Request):
        user = require_user(request)
        try:
            deleted = improvement_queue.delete(item_id, owner=user)
        except RuntimeError as e:
            raise HTTPException(409, str(e))
        if not deleted:
            raise HTTPException(404, "Queue item not found")
        return {"deleted": True, **_state(user)}

    @router.post("/run/{item_id}")
    async def queue_run(item_id: str, request: Request):
        """Play: work the queue top-down and pause after `item_id` completes."""
        user = require_user(request)
        try:
            runner = improvement_queue.run_until(item_id, owner=user)
        except KeyError:
            raise HTTPException(404, "Queue item not found")
        except RuntimeError as e:
            raise HTTPException(409, str(e))
        return {"runner": runner, **_state(user)}

    @router.post("/stop")
    async def queue_stop(request: Request):
        """Pause: cancel the in-flight item (it re-queues) and stop walking."""
        user = require_user(request)
        return {"runner": improvement_queue.stop(), **_state(user)}

    return router
