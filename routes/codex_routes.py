"""Codex integration routes.

These are small HTTP surfaces intended for the Codex plugin/MCP bridge. They
reuse existing AD helpers and enforce API-token scopes before touching
user data.
"""

import asyncio
import json
import zipfile
from io import BytesIO
from pathlib import Path
from typing import Any

from fastapi import APIRouter, BackgroundTasks, Body, HTTPException, Request
from fastapi.responses import StreamingResponse

from core.middleware import require_admin
from src.auth_helpers import require_authenticated_request, require_user
from routes._validators import validate_remote_host, validate_ssh_port


MEMORY_READ_SCOPES = {"memory:read", "memory:write"}
MEMORY_WRITE_SCOPES = {"memory:write"}
DOCS_READ_SCOPES = {"documents:read", "documents:write"}
DOCS_WRITE_SCOPES = {"documents:write"}
WRITE_ACTIONS = {"add", "create", "new", "save", "remind", "update", "delete", "toggle_item", "remove", "remove_item"}


async def _as_owner(request: Request, owner: str, fn, *args, **kwargs):
    """Run an existing route handler with request.state.current_user temporarily
    set to ``owner`` so its internal get_current_user/require_user calls see
    the scope-gated owner (not the "api" pseudo-user the bearer middleware sets).
    Restores the original value when done. Works for sync and async handlers."""
    orig = getattr(request.state, "current_user", None)
    orig_api_token = getattr(request.state, "api_token", None)
    request.state.current_user = owner
    request.state.api_token = False
    try:
        result = fn(*args, **kwargs)
        if asyncio.iscoroutine(result):
            result = await result
        return result
    finally:
        request.state.current_user = orig
        if orig_api_token is None:
            try:
                delattr(request.state, "api_token")
            except AttributeError:
                pass
        else:
            request.state.api_token = orig_api_token


def _scope_owner(request: Request, allowed: set[str]) -> str:
    """Return the data owner if the caller is allowed for this Codex action."""
    if getattr(request.state, "api_token", False):
        scopes = set(getattr(request.state, "api_token_scopes", []) or [])
        if not scopes.intersection(allowed):
            required = " or ".join(sorted(allowed))
            raise HTTPException(403, f"API token missing required scope: {required}")
        owner = getattr(request.state, "api_token_owner", None)
        if not owner:
            raise HTTPException(403, "API token has no owner")
        return owner
    return require_user(request)


def _scope_owner_all(request: Request, required: set[str]) -> str:
    """Return owner only when an API token has every required scope."""
    if getattr(request.state, "api_token", False):
        scopes = set(getattr(request.state, "api_token_scopes", []) or [])
        missing = required - scopes
        if missing:
            raise HTTPException(403, f"API token missing required scope: {' and '.join(sorted(missing))}")
        owner = getattr(request.state, "api_token_owner", None)
        if not owner:
            raise HTTPException(403, "API token has no owner")
        return owner
    return require_user(request)


def _find_endpoint(router: APIRouter | None, method: str, path: str):
    if router is None:
        return None
    for route in getattr(router, "routes", []):
        if getattr(route, "path", "") == path and method in getattr(route, "methods", set()):
            return route.endpoint
    return None


def _clamp_pagination(offset: Any, limit: Any, *, default_limit: int = 50, max_limit: int = 50) -> tuple[int, int]:
    try:
        parsed_offset = int(0 if offset in (None, "") else offset)
    except (TypeError, ValueError):
        raise HTTPException(400, "Invalid offset")
    try:
        parsed_limit = int(default_limit if limit in (None, "") else limit)
    except (TypeError, ValueError):
        raise HTTPException(400, "Invalid limit")
    return max(0, parsed_offset), max(1, min(parsed_limit, max_limit))


def setup_codex_routes(
    memory_router: APIRouter | None = None,
    document_router: APIRouter | None = None,
) -> APIRouter:
    router = APIRouter(prefix="/api/codex", tags=["codex"])
    memory_list_endpoint = _find_endpoint(memory_router, "GET", "/api/memory")
    memory_add_endpoint = _find_endpoint(memory_router, "POST", "/api/memory/add")
    documents_library_endpoint = _find_endpoint(document_router, "GET", "/api/documents/library")
    documents_get_endpoint = _find_endpoint(document_router, "GET", "/api/document/{doc_id}")
    documents_create_endpoint = _find_endpoint(document_router, "POST", "/api/document")

    @router.get("/capabilities")
    def capabilities(request: Request):
        token_scopes = set(getattr(request.state, "api_token_scopes", []) or [])
        has_token = bool(getattr(request.state, "api_token", False))
        def scoped(allowed):
            return bool(token_scopes.intersection(allowed)) if has_token else True
        return {
            "integration": "codex",
            "token_scopes": sorted(token_scopes),
            "tools": {
                "memory": {
                    "read": scoped(MEMORY_READ_SCOPES),
                    "write": scoped(MEMORY_WRITE_SCOPES),
                    "actions": ["list", "add", "delete"],
                    "available": memory_list_endpoint is not None,
                },
                "documents": {
                    "read": scoped(DOCS_READ_SCOPES),
                    "write": scoped(DOCS_WRITE_SCOPES),
                    "actions": ["library", "read", "create", "delete"],
                    "available": documents_library_endpoint is not None,
                },
            },
            "safety": {
                "destructive_actions_should_confirm": True,
            },
        }

    @router.get("/plugin.zip")
    def plugin_zip(request: Request):
        require_authenticated_request(request)
        root = Path(__file__).resolve().parent.parent / "integrations" / "codex"
        if not root.exists():
            raise HTTPException(404, "Codex plugin bundle not found")
        buf = BytesIO()
        with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
            for path in sorted(root.rglob("*")):
                if path.is_dir() or "__pycache__" in path.parts or path.suffix == ".pyc":
                    continue
                zf.write(path, Path("odysseus") / path.relative_to(root))
        buf.seek(0)
        headers = {"Content-Disposition": 'attachment; filename="odysseus-codex-plugin.zip"'}
        return StreamingResponse(buf, media_type="application/zip", headers=headers)

    # ── Memory ────────────────────────────────────────────────────────────

    @router.get("/memory")
    async def codex_memory_list(request: Request):
        owner = _scope_owner(request, MEMORY_READ_SCOPES)
        if memory_list_endpoint is None:
            raise HTTPException(503, "Memory integration is not available")
        return await _as_owner(request, owner, memory_list_endpoint, request)

    @router.post("/memory")
    async def codex_memory_add(request: Request, body: dict[str, Any] = Body(default_factory=dict)):
        owner = _scope_owner(request, MEMORY_WRITE_SCOPES)
        if memory_add_endpoint is None:
            raise HTTPException(503, "Memory integration is not available")
        from src.request_models import MemoryAddRequest

        try:
            memory_data = MemoryAddRequest(
                text=str(body.get("text") or "").strip(),
                category=body.get("category", "fact"),
                source=body.get("source", "user"),
                session_id=body.get("session_id"),
            )
        except Exception as exc:
            raise HTTPException(400, f"Invalid memory payload: {exc}")
        if not memory_data.text:
            raise HTTPException(400, "Empty memory text")
        return await _as_owner(request, owner, memory_add_endpoint, request, memory_data)

    # ── Documents ─────────────────────────────────────────────────────────

    @router.get("/documents")
    async def codex_documents_library(
        request: Request,
        search: str | None = None,
        language: str | None = None,
        sort: str = "recent",
        offset: int = 0,
        limit: int = 50,
        archived: bool = False,
    ):
        owner = _scope_owner(request, DOCS_READ_SCOPES)
        if documents_library_endpoint is None:
            raise HTTPException(503, "Documents integration is not available")
        offset, limit = _clamp_pagination(offset, limit)
        result = await _as_owner(
            request, owner, documents_library_endpoint,
            request, search, language, sort, offset, limit, archived,
        )
        if isinstance(result, dict):
            docs = result.get("documents")
            total = result.get("total")
            if isinstance(docs, list) and isinstance(total, int):
                next_offset = offset + len(docs)
                result["next_offset"] = next_offset if next_offset < total else None
        return result

    @router.get("/documents/{doc_id}")
    async def codex_documents_get(request: Request, doc_id: str):
        owner = _scope_owner(request, DOCS_READ_SCOPES)
        if documents_get_endpoint is None:
            raise HTTPException(503, "Documents integration is not available")
        return await _as_owner(request, owner, documents_get_endpoint, request, doc_id)

    # ── DELETE endpoints so agents can clean up after themselves ──────────

    memory_delete_endpoint = _find_endpoint(memory_router, "DELETE", "/api/memory/{memory_id}")
    documents_delete_endpoint = _find_endpoint(document_router, "DELETE", "/api/document/{doc_id}")

    @router.delete("/memory/{memory_id}")
    async def codex_memory_delete(request: Request, memory_id: str):
        owner = _scope_owner(request, MEMORY_WRITE_SCOPES)
        if memory_delete_endpoint is None:
            raise HTTPException(503, "Memory delete not available")
        return await _as_owner(request, owner, memory_delete_endpoint, request, memory_id)

    @router.delete("/documents/{doc_id}")
    async def codex_documents_delete(request: Request, doc_id: str):
        owner = _scope_owner(request, DOCS_WRITE_SCOPES)
        if documents_delete_endpoint is None:
            raise HTTPException(503, "Documents delete not available")
        return await _as_owner(request, owner, documents_delete_endpoint, request, doc_id)

    @router.post("/documents")
    async def codex_documents_create(request: Request, body: dict[str, Any] = Body(default_factory=dict)):
        owner = _scope_owner(request, DOCS_WRITE_SCOPES)
        if documents_create_endpoint is None:
            raise HTTPException(503, "Documents integration is not available")
        from routes.document_routes import DocumentCreate

        try:
            req = DocumentCreate(**body)
        except Exception as exc:
            raise HTTPException(400, f"Invalid document payload: {exc}")
        return await _as_owner(request, owner, documents_create_endpoint, request, req)

    return router


def setup_claude_routes() -> APIRouter:
    """Serve the Claude Code skill bundle.

    Claude Code uses the same scope-gated `/api/codex/*` endpoints at runtime;
    this router only exists to deliver the skill zip via `/api/claude/plugin.zip`
    so the user-facing setup commands stay in the Claude namespace.
    """
    router = APIRouter(prefix="/api/claude", tags=["claude"])

    @router.get("/plugin.zip")
    def plugin_zip(request: Request):
        require_authenticated_request(request)
        # Only ship the skills/ subtree so extracting at ~/.claude/ doesn't dump
        # README.md or other bundle metadata into the user's claude config dir.
        skills_root = Path(__file__).resolve().parent.parent / "integrations" / "claude" / "skills"
        if not skills_root.exists():
            raise HTTPException(404, "Claude skill bundle not found")
        bundle_root = skills_root.parent
        buf = BytesIO()
        with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
            for path in sorted(skills_root.rglob("*")):
                if path.is_dir() or "__pycache__" in path.parts or path.suffix == ".pyc":
                    continue
                zf.write(path, path.relative_to(bundle_root))
        buf.seek(0)
        headers = {"Content-Disposition": 'attachment; filename="odysseus-claude-skill.zip"'}
        return StreamingResponse(buf, media_type="application/zip", headers=headers)

    return router
