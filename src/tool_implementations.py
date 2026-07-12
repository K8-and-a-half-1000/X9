"""
tool_implementations.py

Extracted tool implementation functions (do_* and helpers) from agent_tools.py.
These handle the actual execution logic for each tool type.
"""

import logging
from typing import Dict, Optional

from src.tool_utils import get_mcp_manager  # re-exported: tests patch src.tool_implementations.get_mcp_manager

# System-domain tools were extracted to src/tools/system.py (slice 1,
# #4082/#4071); the admin manage_* tools live in src/agent_tools/admin_tools
# after the upstream registry migration (#3629). Re-imported here so this
# module stays a working facade.
from src.tools.system import (  # noqa: F401
    do_manage_skills, _skill_dump, do_manage_tasks,
    do_api_call, do_app_api,
    _APP_API_BLOCKLIST_PREFIXES, _APP_API_BLOCKLIST_METHOD_PATH,
)
# Admin manage_* tools (endpoints/mcp/webhooks/tokens/settings) live in
# src/agent_tools/admin_tools after the upstream registry migration (#3629).
# Re-exported lazily via __getattr__: src.agent_tools.__init__ imports this
# facade at top level, so a eager `from src.agent_tools.admin_tools import`
# here would re-enter the partially-initialized agent_tools package (circular).
_ADMIN_TOOL_SYMBOLS = (
    "do_manage_endpoints", "do_manage_mcp", "do_manage_webhooks",
    "do_manage_tokens", "do_manage_settings",
    "_MCP_DENIED_COMMANDS", "_validate_mcp_command", "_mcp_allowed_commands",
)


def __getattr__(name):
    if name in _ADMIN_TOOL_SYMBOLS:
        from src.agent_tools import admin_tools
        return getattr(admin_tools, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


# Search domain extracted to src/tools/search.py (slice 1, #4082/#4071).
# Re-imported here so this module stays a working facade.
from src.tools.search import do_search_chats  # noqa: F401
# Image domain extracted to src/tools/image.py (slice 1, #4082/#4071).
from src.tools.image import do_edit_image  # noqa: F401
# Research domain extracted to src/tools/research.py (slice 1, #4082/#4071).
from src.tools.research import do_manage_research, do_trigger_research  # noqa: F401
# Improvement queue lives in src/tools/queue.py.
from src.tools.queue import do_manage_queue  # noqa: F401
# Contacts domain extracted to src/tools/contacts.py (slice 1, #4082/#4071).
from src.tools.contacts import do_resolve_contact, do_manage_contact  # noqa: F401
# Vault domain extracted to src/tools/vault.py (slice 1, #4082/#4071).
from src.tools.vault import (  # noqa: F401
    _load_vault_config, _run_bw,
    do_vault_search, do_vault_get, do_vault_unlock,
)
# Shared helpers live in src/tools/_common.py. Re-exported here so the
# function-local `from src.tool_implementations import _INTERNAL_BASE` (and
# friends) used by domain files still resolve through this facade.
from src.tools._common import _parse_tool_args, _INTERNAL_BASE, _internal_headers  # noqa: F401

logger = logging.getLogger(__name__)
