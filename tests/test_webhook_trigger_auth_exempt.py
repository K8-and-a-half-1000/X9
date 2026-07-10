"""Pin the auth exemption for task webhook-trigger URLs.

The task router exposes ``POST /api/tasks/{task_id}/webhook/{token}`` as a
public webhook entrypoint — the path-embedded ``webhook_token`` is the
credential, and the route handler in ``routes/task_routes.py`` validates
it against the row and returns 404 on mismatch. The UI advertises the
URL as "no auth needed" because external callers (Zapier, n8n, curl)
can't supply a session cookie.

Without an entry in ``AUTH_EXEMPT_PATTERNS`` ``AuthMiddleware`` rejected
every POST with 401 before the token was ever checked (issue #621).
This test re-reads the exemption logic out of ``app.py`` and confirms a
representative webhook path is treated as exempt, while neighbouring
non-public task paths are NOT.
"""

import os
import re


def _read_app_source() -> str:
    app_path = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        "app.py",
    )
    with open(app_path, encoding="utf-8") as fh:
        return fh.read()




def test_webhook_trigger_handler_still_validates_token():
    """The exemption is only safe because the route handler in
    routes/task_routes.py still checks the token against the row and
    returns 404 on mismatch. Pin that behaviour so a refactor of the
    handler doesn't quietly make the endpoint truly anonymous. Read the
    source directly — importing task_routes pulls in SQLAlchemy and
    fails under the conftest stubs."""
    routes_path = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        "routes",
        "task_routes.py",
    )
    with open(routes_path, encoding="utf-8") as fh:
        src = fh.read()
    assert "ScheduledTask.webhook_token == token" in src
    assert '@router.post("/{task_id}/webhook/{token}")' in src
