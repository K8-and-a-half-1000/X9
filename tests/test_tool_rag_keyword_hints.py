"""Deterministic keyword-hint behavior of the agent tool-RAG.

`_KEYWORD_HINTS` in src/tool_index.py force-includes a hint's tools whenever
one of its keywords appears (word-boundary match). These hints are
deterministic string matching — no embeddings — so we can test
`get_tools_for_query` directly with retrieval stubbed out (no ChromaDB needed).
"""

from src.tool_index import ToolIndex, ALWAYS_AVAILABLE


def _index_without_embeddings():
    """A ToolIndex whose retrieval returns nothing, so get_tools_for_query
    exercises only the deterministic base + keyword-hint logic."""
    ti = ToolIndex.__new__(ToolIndex)        # skip __init__ (no ChromaDB/fastembed)
    ti.retrieve = lambda query, k=8: []
    return ti


def test_explicit_web_search_query_gets_web_tools_without_retrieval():
    """Explicit web-search phrasing must surface web tools even if embeddings
    return nothing."""
    ti = _index_without_embeddings()
    tools = ti.get_tools_for_query("use web search and find a recipe for chocolate chip cookies")
    assert "web_search" in tools and "web_fetch" in tools


def test_plain_tell_request_keeps_always_available_baseline():
    """A bare 'tell me a joke' still gets the always-available baseline."""
    ti = _index_without_embeddings()
    tools = ti.get_tools_for_query("tell me a joke")
    assert set(ALWAYS_AVAILABLE) <= tools
