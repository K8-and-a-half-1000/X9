"""App config routes (/api/auth/* kept for frontend compatibility).

X9 is a single-user app served behind a Zero-Trust gateway — the login
flow (passwords, sessions, 2FA, user management) was removed. What
remains under the historical /api/auth prefix is the app's config
surface the SPA depends on: status, feature flags, settings, and the
integrations CRUD.
"""

from fastapi import APIRouter, Request, HTTPException
import logging

from src.settings import (
    load_settings as _load_settings,
    save_settings as _save_settings,
    load_features as _load_features,
    save_features as _save_features,
    DEFAULT_SETTINGS,
)
from src.integrations import (
    load_integrations,
    add_integration,
    update_integration,
    delete_integration,
    get_integration,
    mask_integration_secret,
    execute_api_call,
    INTEGRATION_PRESETS,
    migrate_from_settings,
)

logger = logging.getLogger(__name__)


def setup_auth_routes() -> APIRouter:
    router = APIRouter(prefix="/api/auth", tags=["auth"])

    def _reject_api_tokens(request: Request) -> None:
        """Config endpoints are for the (single) browser user, not for
        scoped bearer-token integrations."""
        if getattr(request.state, "api_token", False):
            raise HTTPException(403, "API tokens cannot access config routes")

    @router.get("/status")
    async def auth_status():
        """Single-user mode: always authenticated, no username, no login."""
        return {
            "auth_enabled": False,
            "configured": True,
            "authenticated": True,
            "username": None,
            "is_admin": True,
            "signup_enabled": False,
        }

    # ---- Feature visibility ----

    @router.get("/features")
    async def get_features():
        """Public: returns which UI features are enabled."""
        return _load_features()

    @router.post("/features")
    async def set_features(request: Request):
        """Admin only: update feature toggles."""
        _reject_api_tokens(request)
        body = await request.json()
        current = _load_features()
        for key in current:
            if key in body and isinstance(body[key], bool):
                current[key] = body[key]
        _save_features(current)
        return current

    # ---- App settings (admin-managed) ----

    @router.get("/settings")
    async def get_settings(request: Request):
        """Returns app settings (single-user: always the full set)."""
        _reject_api_tokens(request)
        return _load_settings()

    @router.post("/settings")
    async def set_settings(request: Request):
        """Admin only: update app settings."""
        _reject_api_tokens(request)
        body = await request.json()
        current = _load_settings()
        # Per-key validation for numeric settings: coerce to int and clamp to a
        # sane range so a bad value can't disable the agent or let it run away.
        _INT_RANGES = {
            "agent_max_rounds": (1, 200),
            "agent_max_tool_calls": (0, 1000),  # 0 = unlimited
        }
        for key in DEFAULT_SETTINGS:
            if key not in body:
                continue
            val = body[key]
            if key in _INT_RANGES:
                lo, hi = _INT_RANGES[key]
                try:
                    val = int(val)
                except (TypeError, ValueError):
                    raise HTTPException(400, f"{key} must be an integer")
                val = max(lo, min(val, hi))
            current[key] = val
        _save_settings(current)
        return current

    # ---- Integrations CRUD ----

    # Run migration on startup
    migrate_from_settings()

    @router.get("/integrations")
    async def list_integrations_route(request: Request):
        """List all integrations (admin only, keys masked)."""
        _reject_api_tokens(request)
        items = load_integrations()
        # Mask API keys for frontend display
        safe = [mask_integration_secret(item) for item in items]
        return {"integrations": safe}

    @router.get("/integrations/presets")
    async def list_presets():
        """List available integration presets."""
        return {"presets": {k: {kk: vv for kk, vv in v.items() if kk != "api_key"} for k, v in INTEGRATION_PRESETS.items()}}

    @router.post("/integrations")
    async def create_integration(request: Request):
        """Create a new integration (admin only)."""
        _reject_api_tokens(request)
        body = await request.json()
        item = add_integration(body)
        return {"ok": True, "integration": mask_integration_secret(item)}

    @router.put("/integrations/{integration_id}")
    async def update_integration_route(integration_id: str, request: Request):
        """Update an existing integration (admin only)."""
        _reject_api_tokens(request)
        body = await request.json()
        item = update_integration(integration_id, body)
        if not item:
            raise HTTPException(404, "Integration not found")
        return {"ok": True, "integration": mask_integration_secret(item)}

    @router.delete("/integrations/{integration_id}")
    async def delete_integration_route(integration_id: str, request: Request):
        """Delete an integration (admin only)."""
        _reject_api_tokens(request)
        ok = delete_integration(integration_id)
        if not ok:
            raise HTTPException(404, "Integration not found")
        return {"ok": True}

    @router.post("/integrations/{integration_id}/test")
    async def test_integration_route(integration_id: str, request: Request):
        """Test connectivity to an integration (admin only)."""
        _reject_api_tokens(request)
        integ = get_integration(integration_id)
        if not integ:
            raise HTTPException(404, "Integration not found")
        preset = (integ.get("preset") or integ.get("name", "")).lower()

        # ntfy is special: a GET / proves the server is reachable but
        # publishes nothing, so the user has no way to know whether
        # subscribers will actually receive notifications. Instead, do
        # the real thing — POST a one-line "connectivity test" message
        # to the topic the Reminders panel is configured to use. If the
        # subscriber app is wired up correctly, this is what the green
        # checkmark + a phone ping confirms together.
        if preset == "ntfy":
            import httpx
            from urllib.parse import urlparse
            # Strip any path/query the user accidentally pasted in the
            # base URL (e.g. `http://host:8091/odysseus`) — otherwise
            # the topic gets appended after the path and we publish to
            # `/odysseus/odysseus` (which ntfy 404s on). ntfy itself
            # only ever serves from the root.
            raw_base = (integ.get("base_url") or "").strip()
            parsed = urlparse(raw_base)
            base = f"{parsed.scheme}://{parsed.netloc}" if parsed.scheme and parsed.netloc else raw_base.rstrip("/")
            settings = _load_settings()
            topic = (settings.get("reminder_ntfy_topic") or "reminders").strip() or "reminders"
            full_url = f"{base}/{topic}"
            api_key = integ.get("api_key", "")
            auth_type = (integ.get("auth_type") or "none").lower()
            headers = {
                "Title": "X9 connectivity test",
                "Tags": "white_check_mark",
                "Priority": "default",
            }
            if api_key:
                if auth_type == "bearer":
                    headers["Authorization"] = f"Bearer {api_key}"
                elif auth_type == "header":
                    headers[integ.get("auth_header") or "Authorization"] = api_key
            try:
                async with httpx.AsyncClient(timeout=8.0) as client:
                    r = await client.post(
                        full_url,
                        content="Connectivity test from X9. If you see this on your phone, ntfy is wired up correctly.",
                        headers=headers,
                    )
                if r.is_success:
                    # Tell the user EXACTLY where it went and what to
                    # subscribe to on their phone, so they can match
                    # without guesswork. The doubled-topic / wrong-host
                    # mistakes are easier to spot when the actual URL
                    # is right there in the success line.
                    return {
                        "ok": True,
                        "message": (
                            f"Sent to {full_url} — on your ntfy app, "
                            f"subscribe to topic \"{topic}\" with server "
                            f"\"{base}\" (or paste the full URL: {full_url})."
                        ),
                    }
                return {"ok": False, "message": f"ntfy returned HTTP {r.status_code} from {full_url}: {r.text[:200]}"}
            except Exception as e:
                hint = ""
                if parsed.hostname not in ("127.0.0.1", "localhost"):
                    hint = " If ntfy runs on another host, make sure it is bound to an interface reachable from this machine and the server URL matches."
                return {"ok": False, "message": f"ntfy publish to {full_url} failed: {e}.{hint}"[:500]}

        if preset == "discord_webhook":
            import httpx
            webhook_url = (integ.get("base_url") or "").strip()
            if not webhook_url:
                return {"ok": False, "message": "No webhook URL set — paste the full Discord webhook URL into the Base URL field."}
            payload = {
                "embeds": [{
                    "title": "X9 connectivity test",
                    "description": "If you see this, your Discord Webhook integration is wired up correctly.",
                    "color": 5793266,
                }]
            }
            try:
                async with httpx.AsyncClient(timeout=8.0) as client:
                    r = await client.post(webhook_url, json=payload)
                if r.is_success:
                    return {"ok": True, "message": "Test embed sent — check your Discord channel to confirm it arrived."}
                return {"ok": False, "message": f"Discord returned HTTP {r.status_code}: {r.text[:200]}"}
            except Exception as e:
                return {"ok": False, "message": f"Request failed: {e}"[:400]}

        # All other presets: GET against a known health endpoint.
        # Fall back to detecting from name if preset is missing.
        health_paths = {
            "miniflux": "/v1/me",
            "gitea": "/api/v1/version",
            "linkding": "/api/tags/",
            "homeassistant": "/api/",
            "home assistant": "/api/",
        }
        path = health_paths.get(preset, "/")
        result = await execute_api_call(integration_id, "GET", path)
        if result.get("exit_code", 1) == 0:
            return {"ok": True, "message": "Connection successful"}
        return {"ok": False, "message": (result.get("error") or "Connection failed")[:300]}

    return router
