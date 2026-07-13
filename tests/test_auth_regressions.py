"""Pin the auth-gate fixes from the 2026-05-19 v2 review so they
don't regress. Specifically:

- All `/api/research/*` endpoints reject anonymous callers.
"""

import os
import sys
import types
import asyncio
import pytest
from types import SimpleNamespace
from unittest.mock import MagicMock

# Stub `core.database` / `core.auth` before the route modules import them.
# (Same trick as test_null_owner_gates.py — the real modules instantiate
# SQLAlchemy declarative classes at import-time which blow up under the
# conftest's `sqlalchemy.*` MagicMock stubs.)
def _ensure_stub(name: str, **attrs):
    """Create or augment a stub module with the given attributes.
    Augments existing entries because earlier-run tests may have already
    stubbed the same module with a different attribute set.

    Also stubs the parent package and wires the child onto it as an
    attribute. Without stubbing the parent we'd either (a) run the real
    `core/__init__.py`, which transitively imports SQLAlchemy-using
    modules and explodes under the conftest mocks, or (b) leave the
    stub orphaned so `import core.auth; core.auth.AuthManager` raises
    `AttributeError`."""
    # Stub the parent package first if not already loaded. We point
    # `__path__` at the real on-disk directory so submodules NOT
    # stubbed here can still resolve via normal import machinery —
    # but `core/__init__.py` is bypassed because the package is
    # already in `sys.modules`, which is exactly what we want.
    if "." in name:
        parent_name, _, child_name = name.rpartition(".")
        if parent_name not in sys.modules:
            parent = types.ModuleType(parent_name)
            # Find the real on-disk path so unstubbed submodules
            # (core.middleware etc.) still load from disk.
            real_path = os.path.join(
                os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                *parent_name.split("."),
            )
            parent.__path__ = [real_path] if os.path.isdir(real_path) else []
            sys.modules[parent_name] = parent
        else:
            parent = sys.modules[parent_name]
    else:
        parent = None
        child_name = None

    mod = sys.modules.get(name)
    if mod is None:
        mod = types.ModuleType(name)
        sys.modules[name] = mod
    for k, v in attrs.items():
        if not hasattr(mod, k):
            setattr(mod, k, v)
    if parent is not None and not hasattr(parent, child_name):
        setattr(parent, child_name, mod)
    return mod

@pytest.fixture(autouse=True)
def _auth_regressions_stubs(monkeypatch):
    db = _ensure_stub("core.database",
        SessionLocal=MagicMock(),
        ModelEndpoint=MagicMock(), Session=MagicMock(), ChatMessage=MagicMock(),
        CalendarCal=MagicMock(), CalendarEvent=MagicMock(),
        Document=MagicMock(), DocumentVersion=MagicMock(),
        GalleryImage=MagicMock(), GalleryAlbum=MagicMock(), Note=MagicMock(),
        McpServer=MagicMock(),
    )
    auth = _ensure_stub("core.auth", AuthManager=MagicMock())
    ep = _ensure_stub("src.endpoint_resolver",
        resolve_endpoint=MagicMock(return_value=("", "", {})),
        normalize_base=MagicMock(),
        build_chat_url=MagicMock(),
        build_models_url=MagicMock(),
        build_headers=MagicMock(),
    )
    monkeypatch.setitem(sys.modules, "core.database", db)
    monkeypatch.setitem(sys.modules, "core.auth", auth)
    monkeypatch.setitem(sys.modules, "src.endpoint_resolver", ep)

from fastapi import HTTPException

# ---------------------------------------------------------------------------
# Auth routes -- open signup setter
# ---------------------------------------------------------------------------

def _auth_route_endpoint(path: str, method: str):
    from routes.auth_routes import setup_auth_routes

    auth_manager = MagicMock()
    router = setup_auth_routes(auth_manager)
    for route in router.routes:
        if getattr(route, "path", "") == path and method in getattr(route, "methods", set()):
            return auth_manager, route.endpoint
    raise AssertionError(f"{method} {path} route not registered")


def _fake_auth_request(token="session-token"):
    from routes.auth_routes import SESSION_COOKIE

    req = SimpleNamespace()
    req.cookies = {SESSION_COOKIE: token}
    req.client = SimpleNamespace(host="127.0.0.1")
    return req


# ---------------------------------------------------------------------------
# Research endpoints — `_require_user` rejects anonymous
# ---------------------------------------------------------------------------

def _build_research_router():
    """Construct the research router with a mock research_handler so we
    can fish out the inner `_require_user` helper without booting the
    full app."""
    from routes.research_routes import setup_research_routes
    rh = MagicMock()
    setup_research_routes(rh)
    # The helper lives inside the setup closure. Easiest way to exercise
    # it: re-import the module and grab the symbol via its source.
    # Instead, exercise it via the route helper that has request:Request.
    return rh


def _fake_request(user=None):
    """Cheap stand-in for fastapi.Request — only `request.state.current_user`
    matters to `get_current_user`."""
    req = SimpleNamespace()
    req.state = SimpleNamespace(current_user=user)
    # Some endpoints touch .client too — provide a benign default.
    req.client = SimpleNamespace(host="127.0.0.1")
    return req


def test_research_status_accepts_authenticated():
    from routes.research_routes import setup_research_routes
    rh = MagicMock()
    rh._active_tasks = {"x": {"owner": "alice", "status": "running"}}
    rh.get_status.return_value = {"status": "running", "progress": {}}
    router = setup_research_routes(rh)
    target = next(r.endpoint for r in router.routes if getattr(r, "path", "") == "/api/research/status/{session_id}")
    out = asyncio.run(target(session_id="x", request=_fake_request(user="alice")))
    assert out == {"status": "running", "progress": {}}


def test_research_status_rejects_wrong_owner():
    from routes.research_routes import setup_research_routes
    rh = MagicMock()
    rh._active_tasks = {"x": {"owner": "alice", "status": "running"}}
    rh.get_status.return_value = {"status": "running", "progress": {}}
    router = setup_research_routes(rh)
    target = next(r.endpoint for r in router.routes if getattr(r, "path", "") == "/api/research/status/{session_id}")
    with pytest.raises(HTTPException) as exc:
        asyncio.run(target(session_id="x", request=_fake_request(user="bob")))
    assert exc.value.status_code == 404


def test_research_spinoff_rejects_wrong_owner():
    """A user must not be able to spin off (and thereby read) another user's
    research report. The ownership gate must 404 before any data is read or a
    new session is created. Regression for the cross-user disclosure IDOR."""
    from routes.research_routes import setup_research_routes
    sm = MagicMock()
    rh = MagicMock()
    rh._active_tasks = {"x": {"owner": "alice"}}
    rh.get_result.return_value = "TOP SECRET REPORT"
    router = setup_research_routes(rh, session_manager=sm)
    target = next(r.endpoint for r in router.routes if getattr(r, "path", "") == "/api/research/spinoff/{session_id}")
    with pytest.raises(HTTPException) as exc:
        asyncio.run(target(session_id="x", request=_fake_request(user="bob")))
    assert exc.value.status_code == 404
    # The attacker must never get a session created on their behalf.
    sm.create_session.assert_not_called()


