"""Endpoint probing behaviour (REAL routes.model_routes helpers).

ROADMAP "Backend → more tests around endpoint probing and provider setup".
TestSetupProbeSafety in test_model_routes.py already covers the keyed-vs-unkeyed
curated-fallback safety of `_probe_endpoint`. This module pins the rest of the
probe surface that drives endpoint setup and degraded-state reporting:

  * `_probe_endpoint`     — OpenAI vs native-Ollama model-list parsing, the
    /api/tags fallback for Ollama builds without /v1/models, and the
    no-models-found result.
  * `_ping_endpoint`      — reachability classification: 2xx, auth failures,
    the "this is Odysseus, not a model server" /login-redirect trap, generic
    redirects, transport errors, and the native-Ollama /api/version fallback.
  * `_probe_single_model` — ok/fail/timeout status mapping, upstream error-body
    extraction, and per-provider (OpenAI / Anthropic) request routing.
  * `_classify_endpoint`  — the Tailscale CGNAT (100.64.0.0/10) "local" range.

HTTP is faked by monkeypatching `model_routes.httpx.{get,post}`, mirroring the
established pattern in test_model_routes.py — no network, no server.
"""
import sys
import types
from unittest.mock import MagicMock

import httpx
import pytest

from tests.helpers.import_state import clear_fake_endpoint_resolver_modules, preserve_import_state

with preserve_import_state("core.database", "src.database", "core.session_manager", "routes.model_routes"):
    # Match test_model_routes.py: if another test stubbed src.endpoint_resolver
    # during collection, drop the stub so the real URL helpers load here.
    clear_fake_endpoint_resolver_modules()

    if "core.database" not in sys.modules:
        _core_db = types.ModuleType("core.database")
        for _name in [
            "SessionLocal", "ModelEndpoint", "Session", "ChatMessage", "Document",
            "DocumentVersion", "GalleryImage", "GalleryAlbum", "Note",
            "CalendarCal", "CalendarEvent", "ScheduledTask", "TaskRun", "McpServer",
            "ProviderAuthSession", "Base",
        ]:
            setattr(_core_db, _name, MagicMock())
        _core_db.utcnow_naive = MagicMock()
        sys.modules["core.database"] = _core_db

    import routes.model_routes as model_routes
    import src.endpoint_resolver as endpoint_resolver
    from routes.model_routes import (
        _probe_endpoint,
        _ping_endpoint,
        _probe_single_model,
        _resolve_probe_key,
        _classify_endpoint,
        _normalize_bind_host_url,
        _openai_model_ids,
        _ollama_model_names,
        _PROVIDER_CURATED,
    )


def _patch_resolve(monkeypatch):
    """Neutralize DNS/Tailscale resolution and base normalization."""
    monkeypatch.setattr(endpoint_resolver, "resolve_url", lambda url: url, raising=False)
    monkeypatch.setattr(model_routes, "_normalize_base", lambda url: url.rstrip("/"))


def _resp(status, *, json=None, headers=None, url="https://api.example.com/v1/models"):
    """Build an httpx.Response with a request attached (so raise_for_status works)."""
    req = httpx.Request("GET", url)
    kwargs = {"request": req}
    if json is not None:
        kwargs["json"] = json
    if headers is not None:
        kwargs["headers"] = headers
    return httpx.Response(status, **kwargs)


# ── _openai_model_ids / _ollama_model_names: parsing helpers ──

class TestModelListHelpers:
    @pytest.mark.parametrize("data,expected", [
        ({"data": [{"id": "gpt-4o"}, {"id": "gpt-4o-mini"}]}, ["gpt-4o", "gpt-4o-mini"]),
        ({"data": [{"id": None}, {"id": 123}, {"id": "gpt-4o"}]}, ["gpt-4o"]),  # non-string ids dropped
        ({"data": ["x", {"id": "ok"}]}, ["ok"]),                                # non-dict entries dropped
        ({"data": []}, []),
        ({"data": "oops"}, []),                                                 # non-list "data"
        ([], []), ("nope", []), (None, []), (123, []),                          # non-dict body
    ])
    def test_openai_model_ids(self, data, expected):
        assert _openai_model_ids(data) == expected

    @pytest.mark.parametrize("data,expected", [
        ({"models": [{"name": "llama3:8b"}, {"model": "qwen3:4b"}]}, ["llama3:8b", "qwen3:4b"]),
        ({"models": [{"name": "a", "model": "b"}]}, ["a"]),                      # name precedence over model
        ({"models": [{"name": 123}, {"model": None}, {"name": "ok"}]}, ["ok"]),  # non-string values dropped
        ({"models": ["x", {"name": "ok"}]}, ["ok"]),                            # non-dict entries dropped
        ({"models": []}, []),
        ({"models": "oops"}, []),
        ([], []), (None, []), (42, []),                                         # non-dict body
    ])
    def test_ollama_model_names(self, data, expected):
        assert _ollama_model_names(data) == expected


# ── _probe_endpoint: model-list parsing ──

class TestProbeEndpointParsing:
    def test_parses_openai_data_format(self, monkeypatch):
        _patch_resolve(monkeypatch)
        monkeypatch.setattr(
            model_routes.httpx, "get",
            lambda url, headers=None, timeout=None, verify=None, **kwargs: _resp(
                200, json={"data": [{"id": "gpt-4o"}, {"id": "gpt-4o-mini"}]}),
        )
        assert _probe_endpoint("https://api.example.com/v1", "key") == ["gpt-4o", "gpt-4o-mini"]

    def test_parses_ollama_models_format(self, monkeypatch):
        _patch_resolve(monkeypatch)
        # No OpenAI-style "data"; fall back to the native {"models": [...]} shape,
        # honoring both the "name" and "model" keys.
        monkeypatch.setattr(
            model_routes.httpx, "get",
            lambda url, headers=None, timeout=None, verify=None, **kwargs: _resp(
                200, json={"models": [{"name": "llama3:8b"}, {"model": "qwen3:4b"}]}),
        )
        assert _probe_endpoint("https://api.example.com/v1") == ["llama3:8b", "qwen3:4b"]

    def test_falls_back_to_native_ollama_tags(self, monkeypatch):
        _patch_resolve(monkeypatch)
        seen = []

        def fake_get(url, headers=None, timeout=None, verify=None, **kwargs):
            seen.append(url)
            if url.endswith("/api/tags"):
                return _resp(200, json={"models": [{"name": "llama3:8b"}]})
            # This Ollama build has no OpenAI-compatible /v1/models surface.
            return _resp(404)

        monkeypatch.setattr(model_routes.httpx, "get", fake_get)
        assert _probe_endpoint("http://localhost:11434/v1") == ["llama3:8b"]
        assert "http://localhost:11434/v1/models" in seen
        assert "http://localhost:11434/api/tags" in seen

    def test_empty_list_with_no_curation_returns_empty(self, monkeypatch):
        _patch_resolve(monkeypatch)
        monkeypatch.setattr(
            model_routes.httpx, "get",
            lambda url, headers=None, timeout=None, verify=None, **kwargs: _resp(200, json={"data": []}),
        )
        assert _probe_endpoint("https://api.example.com/v1") == []

    @pytest.mark.parametrize("body", [[], "invalid", 123, True])
    def test_non_dict_json_body_degrades_to_empty(self, monkeypatch, caplog, body):
        # HTTP 200 with valid-but-non-dict JSON must not crash the probe with an
        # AttributeError (data.get(...) on a list/str/int); it should fall through
        # to the empty/curated path. caplog gives this test teeth: pre-fix the
        # swallowed AttributeError logs "Failed to probe"; post-fix it does not.
        _patch_resolve(monkeypatch)
        monkeypatch.setattr(
            model_routes.httpx, "get",
            lambda url, headers=None, timeout=None, verify=None, **kwargs: _resp(200, json=body),
        )
        with caplog.at_level("WARNING", logger="routes.model_routes"):
            assert _probe_endpoint("https://api.example.com/v1") == []
        assert "Failed to probe" not in caplog.text

    def test_skips_non_string_model_ids(self, monkeypatch):
        # A non-compliant upstream returns int/None IDs alongside a valid one.
        # The probe must not crash on .lower()/.startswith and must still surface
        # the valid string model.
        _patch_resolve(monkeypatch)
        monkeypatch.setattr(
            model_routes.httpx, "get",
            lambda url, headers=None, timeout=None, verify=None, **kwargs: _resp(
                200, json={"data": [{"id": None}, {"id": 123}, {"id": "gpt-4o"}]}),
        )
        assert _probe_endpoint("https://api.example.com/v1", "key") == ["gpt-4o"]

    def test_all_non_string_ids_returns_empty(self, monkeypatch):
        # Every id is non-string -> empty result, no exception, no curated leak.
        _patch_resolve(monkeypatch)
        monkeypatch.setattr(
            model_routes.httpx, "get",
            lambda url, headers=None, timeout=None, verify=None, **kwargs: _resp(
                200, json={"data": [{"id": 123}, {"id": None}]}),
        )
        assert _probe_endpoint("https://api.example.com/v1") == []

# ── _ping_endpoint: reachability classification ──

class TestPingEndpoint:
    def test_reachable_on_2xx(self, monkeypatch):
        _patch_resolve(monkeypatch)
        monkeypatch.setattr(
            model_routes.httpx, "get",
            lambda url, headers=None, timeout=None, verify=None, **kwargs: _resp(200),
        )
        assert _ping_endpoint("https://api.example.com/v1", "key") == {
            "reachable": True, "status_code": 200, "error": None,
        }

    def test_auth_failure_is_reached_but_not_reachable(self, monkeypatch):
        _patch_resolve(monkeypatch)
        # A 401 means the server answered — surface the status, not "offline".
        monkeypatch.setattr(
            model_routes.httpx, "get",
            lambda url, headers=None, timeout=None, verify=None, **kwargs: _resp(401),
        )
        assert _ping_endpoint("https://api.example.com/v1", "bad") == {
            "reachable": False, "status_code": 401, "error": "HTTP 401",
        }

    def test_detects_odysseus_login_redirect(self, monkeypatch):
        _patch_resolve(monkeypatch)

        def fake_get(url, headers=None, timeout=None, verify=None, **kwargs):
            return _resp(302, headers={"location": "/login?next=/"})

        monkeypatch.setattr(model_routes.httpx, "get", fake_get)
        result = _ping_endpoint("http://localhost:8080/v1")
        assert result["reachable"] is False
        assert result["status_code"] == 302
        assert "not a model server" in result["error"]

    def test_generic_redirect_reported(self, monkeypatch):
        _patch_resolve(monkeypatch)

        def fake_get(url, headers=None, timeout=None, verify=None, **kwargs):
            return _resp(301, headers={"location": "https://elsewhere.example/"})

        monkeypatch.setattr(model_routes.httpx, "get", fake_get)
        assert _ping_endpoint("https://api.example.com/v1") == {
            "reachable": False, "status_code": 301, "error": "HTTP 301 redirect",
        }

    def test_transport_error_is_unreachable(self, monkeypatch):
        _patch_resolve(monkeypatch)

        def fake_get(url, headers=None, timeout=None, verify=None, **kwargs):
            raise httpx.ConnectError("Connection refused")

        monkeypatch.setattr(model_routes.httpx, "get", fake_get)
        result = _ping_endpoint("https://api.example.com/v1")
        assert result["reachable"] is False
        assert result["status_code"] is None
        assert "Connection refused" in result["error"]

    def test_ollama_native_version_fallback(self, monkeypatch):
        _patch_resolve(monkeypatch)

        def fake_get(url, headers=None, timeout=None, verify=None, **kwargs):
            if url.endswith("/api/version"):
                return _resp(200)
            # The OpenAI-compatible /v1/models surface is down on this build.
            return _resp(500)

        monkeypatch.setattr(model_routes.httpx, "get", fake_get)
        assert _ping_endpoint("http://localhost:11434/v1") == {
            "reachable": True, "status_code": 200, "error": None,
        }


# ── Bind-address URL normalization ──

class TestBindHostNormalization:
    def test_bind_address_becomes_connectable_loopback(self):
        assert (
            _normalize_bind_host_url("http://0.0.0.0:8000/v1")
            == "http://127.0.0.1:8000/v1"
        )

    def test_ipv6_any_bind_becomes_connectable_loopback(self):
        assert (
            _normalize_bind_host_url("http://[::]:8000/v1")
            == "http://127.0.0.1:8000/v1"
        )

    def test_loopback_url_stays_unchanged(self):
        assert (
            _normalize_bind_host_url("http://127.0.0.1:8001/v1")
            == "http://127.0.0.1:8001/v1"
        )

    def test_real_hostname_stays_unchanged(self):
        assert (
            _normalize_bind_host_url("http://gpu-box.local:8000/v1")
            == "http://gpu-box.local:8000/v1"
        )


# ── _probe_single_model: completion probe ──

class TestProbeSingleModel:
    def test_ok_on_success(self, monkeypatch):
        _patch_resolve(monkeypatch)
        captured = {}

        def fake_post(url, headers=None, json=None, timeout=None, verify=None):
            captured["url"] = url
            return _resp(200, json={"choices": [{"message": {"content": "OK"}}]})

        monkeypatch.setattr(model_routes.httpx, "post", fake_post)
        result = _probe_single_model("https://api.example.com/v1", "key", "gpt-4o")
        assert result["status"] == "ok"
        assert "latency_ms" in result
        assert captured["url"] == "https://api.example.com/v1/chat/completions"

    @pytest.mark.parametrize("base,api_key,model_id", [
        ("https://api.example.com/v1", "key", "gpt-4o"),
        ("http://localhost:11434/v1", None, "llama3.2"),
        ("https://api.anthropic.com/v1", "sk-ant", "claude-sonnet-4-5"),
    ])
    def test_completion_probe_uses_llm_verify(self, monkeypatch, base, api_key, model_id):
        _patch_resolve(monkeypatch)
        marker = object()
        captured = {}
        monkeypatch.setattr(model_routes, "llm_verify", lambda: marker)

        def fake_post(url, headers=None, json=None, timeout=None, verify=None):
            captured["verify"] = verify
            return _resp(200, json={"choices": [{"message": {"content": "OK"}}]})

        monkeypatch.setattr(model_routes.httpx, "post", fake_post)
        result = _probe_single_model(base, api_key, model_id)
        assert result["status"] == "ok"
        assert captured["verify"] is marker

    def test_extracts_dict_error_message(self, monkeypatch):
        _patch_resolve(monkeypatch)
        monkeypatch.setattr(
            model_routes.httpx, "post",
            lambda url, headers=None, json=None, timeout=None, verify=None: _resp(
                400, json={"error": {"message": "model not found"}}),
        )
        result = _probe_single_model("https://api.example.com/v1", "key", "ghost")
        assert result["status"] == "fail"
        assert result["error"] == "model not found"

    def test_extracts_string_error(self, monkeypatch):
        _patch_resolve(monkeypatch)
        monkeypatch.setattr(
            model_routes.httpx, "post",
            lambda url, headers=None, json=None, timeout=None, verify=None: _resp(
                403, json={"error": "forbidden"}),
        )
        result = _probe_single_model("https://api.example.com/v1", "key", "m")
        assert result["status"] == "fail"
        assert result["error"] == "forbidden"

    def test_timeout(self, monkeypatch):
        _patch_resolve(monkeypatch)

        def fake_post(url, headers=None, json=None, timeout=None, verify=None):
            raise httpx.TimeoutException("timed out")

        monkeypatch.setattr(model_routes.httpx, "post", fake_post)
        result = _probe_single_model("https://api.example.com/v1", "key", "m", timeout=7)
        assert result["status"] == "timeout"
        assert "7s" in result["error"]

    def test_transport_error_is_fail(self, monkeypatch):
        _patch_resolve(monkeypatch)

        def fake_post(url, headers=None, json=None, timeout=None, verify=None):
            raise httpx.ConnectError("refused")

        monkeypatch.setattr(model_routes.httpx, "post", fake_post)
        result = _probe_single_model("https://api.example.com/v1", "key", "m")
        assert result["status"] == "fail"
        assert "refused" in result["error"]

    def test_routes_anthropic_messages_with_x_api_key(self, monkeypatch):
        _patch_resolve(monkeypatch)
        captured = {}

        def fake_post(url, headers=None, json=None, timeout=None, verify=None):
            captured.update(url=url, headers=headers, payload=json)
            return _resp(200, json={"content": [{"type": "text", "text": "OK"}]})

        monkeypatch.setattr(model_routes.httpx, "post", fake_post)
        result = _probe_single_model("https://api.anthropic.com/v1", "sk-ant", "claude-sonnet-4-5")
        assert result["status"] == "ok"
        assert captured["url"] == "https://api.anthropic.com/v1/messages"
        assert captured["headers"].get("x-api-key") == "sk-ant"
        assert captured["payload"]["model"] == "claude-sonnet-4-5"

    def test_with_tools_sends_anthropic_tool_schema(self, monkeypatch):
        _patch_resolve(monkeypatch)
        captured = {}

        def fake_post(url, headers=None, json=None, timeout=None, verify=None):
            captured["payload"] = json
            return _resp(200, json={"content": []})

        monkeypatch.setattr(model_routes.httpx, "post", fake_post)
        _probe_single_model("https://api.anthropic.com/v1", "sk-ant", "claude-sonnet-4-5", with_tools=True)
        assert "input_schema" in captured["payload"]["tools"][0]

# ── _resolve_probe_key: static key vs provider-auth runtime token ──

class TestResolveProbeKey:
    def test_static_endpoint_uses_api_key(self):
        ep = types.SimpleNamespace(id="e1", api_key="sk-static", provider_auth_id=None, owner=None)
        assert _resolve_probe_key(ep) == "sk-static"

    def test_endpoint_resolves_runtime_key(self, monkeypatch):
        ep = types.SimpleNamespace(id="e2", api_key=None, provider_auth_id="auth123", owner="alice")
        seen = {}

        def fake_runtime(endpoint, owner=None):
            seen["owner"] = owner
            return ("http://gpu-box.local:8000/v1", "live-bearer")

        monkeypatch.setattr(endpoint_resolver, "resolve_endpoint_runtime", fake_runtime)
        assert _resolve_probe_key(ep) == "live-bearer"
        assert seen["owner"] == "alice"

    def test_runtime_key_resolution_failure_returns_none(self, monkeypatch):
        ep = types.SimpleNamespace(id="e3", api_key=None, provider_auth_id="auth123", owner=None)

        def boom(endpoint, owner=None):
            raise RuntimeError("reauth required")

        monkeypatch.setattr(endpoint_resolver, "resolve_endpoint_runtime", boom)
        assert _resolve_probe_key(ep) is None


# ── _classify_endpoint: Tailscale CGNAT range ──

class TestClassifyEndpointTailscale:
    @pytest.mark.parametrize("url", [
        "http://100.64.0.1:11434/v1",     # bottom of 100.64.0.0/10
        "http://100.100.50.20:8080/v1",
        "http://100.127.255.254/v1",      # top of the range
    ])
    def test_cgnat_range_is_local(self, url):
        assert _classify_endpoint(url) == "local"

    @pytest.mark.parametrize("url", [
        "http://100.63.255.255/v1",   # just below 100.64.0.0/10
        "http://100.128.0.1/v1",      # just above
        "https://api.openai.com/v1",  # public hostname
    ])
    def test_outside_cgnat_is_api(self, url):
        assert _classify_endpoint(url) == "api"
