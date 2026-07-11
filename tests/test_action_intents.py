from src.action_intents import classify_tool_intent, message_needs_tools


def test_ui_actions_promote_to_agent():
    assert message_needs_tools("open my documents")
    assert message_needs_tools("turn off web search")


def test_research_action_promotes_to_agent():
    assert message_needs_tools("research cost effective local models")
    assert message_needs_tools("can you look into GPU hosting options")


def test_explicit_web_search_promotes_to_agent():
    assert message_needs_tools("use web search and find a recipe for chocolate chip cookies")
    assert message_needs_tools("do a web search for the best chocolate chip cookies")
    assert message_needs_tools("search the web for current RTX 3090 prices")
    assert classify_tool_intent("use web search and find a recipe").category == "web"


def test_router_reports_categories():
    assert classify_tool_intent("open my documents").category == "ui"
    assert classify_tool_intent("research cost effective local models").category == "research"
