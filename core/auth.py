"""Reserved synthetic-owner sentinels.

X9 is a single-user app served behind a Zero-Trust gateway — the multi-user
password/session/2FA AuthManager was removed with the login flow. What
remains is the reserved-username set that the middleware and task layers
still use to recognize synthetic (non-human) owners.
"""

from core.middleware import INTERNAL_TOOL_USER

# Usernames the middleware layer reserves as internal "synthetic owner"
# sentinels; they must never be treated as a real user. The most dangerous is
# "internal-tool": `core.middleware.require_admin` treats any request whose
# `current_user == "internal-tool"` as the in-process tool loopback. "api" is
# the bearer-token owner-attribution sentinel. "demo"/"system" round out the
# synthetic-owner set the rest of the codebase special-cases (see
# routes/assistant_routes.py and src/task_scheduler.py).
RESERVED_USERNAMES = frozenset({INTERNAL_TOOL_USER, "api", "demo", "system"})
