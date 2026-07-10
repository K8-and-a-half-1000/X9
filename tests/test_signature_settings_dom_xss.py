"""Regression guards for DOM attribute sinks in signature/settings UI."""

from pathlib import Path


_REPO = Path(__file__).resolve().parent.parent


def test_signature_picker_allows_only_raster_data_urls():
    src = (_REPO / "static" / "js" / "signature.js").read_text(encoding="utf-8")

    assert "function _safeSignatureDataUrl(raw)" in src
    assert r"^data:image\/png;base64," in src
    assert '<img src="${_esc(dataUrl)}"/>' in src
    assert 'dataUrl: s.data_url' not in src


