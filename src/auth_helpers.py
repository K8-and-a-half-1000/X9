"""Shared auth helpers used by all route files."""

import os
from typing import Optional
from fastapi import Request, HTTPException


def get_current_user(request: Request) -> Optional[str]:
    """Get current username from request state (set by auth middleware)."""
    return getattr(request.state, 'current_user', None)


def effective_user(request: Request) -> Optional[str]:
    """The real human behind the request, for ownership/attribution.

    Cookie sessions resolve to the logged-in username. Bearer ``ody_`` callers
    come through as the sandboxed pseudo-user "api" so they can't wander into
    cookie/user routes by default, but their token was minted by, and belongs
    to, a real owner stamped on ``request.state.api_token_owner``. Routes that
    should attribute a token's actions to that owner (sessions, chat history)
    call this instead of :func:`get_current_user`, so a paired client sees and
    creates the SAME data as the owner's desktop UI rather than a separate
    "api"-owned silo.

    For cookie sessions this is identical to :func:`get_current_user`, so
    swapping a route over is a no-op for browser users. A bearer token with no
    owner falls back to :func:`get_current_user` (the "api" pseudo-user), so it
    never escalates.
    """
    if getattr(request.state, "api_token", False):
        owner = getattr(request.state, "api_token_owner", None)
        if owner:
            return owner
    return get_current_user(request)


def _is_api_token_request(request: Request) -> bool:
    """Return True when middleware authenticated a bearer API token."""
    return bool(getattr(request.state, "api_token", False))


def require_authenticated_request(request: Request) -> str:
    """Allow either a browser session or a valid bearer API token.

    This is intentionally narrower than :func:`require_user`: use it only for
    routes that need authentication but do not read or mutate owner-scoped
    user data. Owner-scoped routes should use ``require_user`` for browser
    sessions or their own API-token scope/owner gate.
    """
    if _is_api_token_request(request):
        return effective_user(request) or ""
    return require_user(request)


def _auth_disabled() -> bool:
    """Always True: AD runs as a single-user app behind a Zero-Trust gateway.
    The login flow was removed; the app permanently operates in the
    anonymous single-user mode the rest of the codebase already supports."""
    return True


def require_user(request: Request) -> str:
    """FastAPI dependency: resolve the caller for owner-scoped routes.

    AD is single-user — anonymous browser requests resolve to "" (the
    single-user owner), which owner_filter treats as "no scoping". Requests
    stamped by the identity middleware (internal-tool loopback) keep their
    stamped identity. Bearer API tokens must use scope-aware routes.
    """
    if _is_api_token_request(request):
        raise HTTPException(403, "API tokens must use a scope-aware API route")

    return get_current_user(request) or ""


def require_privilege(request: Request, key: str) -> str:
    """Reject callers whose `auth.json` privilege flag for `key` is False.
    Returns the username so the route handler can keep using it.

    Admins always have every privilege via `auth_manager.get_privileges`
    (which returns ADMIN_PRIVILEGES wholesale), so this is a no-op for
    them. In unauthenticated single-user mode (`require_user` returns ""),
    privileges aren't enforced.
    """
    user = require_user(request)
    if not user:
        return user
    auth_mgr = getattr(request.app.state, "auth_manager", None)
    if auth_mgr is None:
        return user
    try:
        privs = auth_mgr.get_privileges(user) or {}
    except Exception:
        return user
    if not isinstance(privs, dict):
        privs = {}
    # True = permitted; missing key defaults to permitted (unknown privileges
    # fail open — the UI gates display-side).
    if not privs.get(key, True):
        raise HTTPException(403, f"Your account is not allowed to {key.replace('_', ' ')}.")
    return user


def owner_filter(query, model_cls, user: str, *, include_shared: bool = True):
    """Filter `query` so only rows owned by `user` (and optionally null-owner
    'shared' rows) come through. No-op when `user` is empty (single-user
    mode). Returns the modified query."""
    if not user:
        return query
    if include_shared:
        return query.filter((model_cls.owner == user) | (model_cls.owner == None))  # noqa: E711
    return query.filter(model_cls.owner == user)
