"""Regression tests for owner-scoped model resolution in scheduled actions."""

from datetime import datetime
from types import SimpleNamespace

import pytest


class _Column:
    def __eq__(self, _other):
        return True

    def __ne__(self, _other):
        return True

    def __ge__(self, _other):
        return True

    def __le__(self, _other):
        return True


class _Query:
    def __init__(self, rows):
        self._rows = rows

    def filter(self, *_args, **_kwargs):
        return self

    def limit(self, _limit):
        return self

    def all(self):
        return list(self._rows)


class _Db:
    def __init__(self, rows_by_model):
        self._rows_by_model = rows_by_model
        self.commits = 0
        self.closed = False

    def query(self, model):
        return _Query(self._rows_by_model.get(model, []))

    def commit(self):
        self.commits += 1

    def close(self):
        self.closed = True


def _resolver_spy(monkeypatch, candidates=None):
    from src import task_endpoint

    calls = []

    def fake_candidates(*args, **kwargs):
        calls.append(kwargs.get("owner"))
        if candidates is None:
            return [("http://llm", "model", {})]
        return list(candidates)

    monkeypatch.setattr(task_endpoint, "resolve_task_candidates", fake_candidates)
    return calls


@pytest.mark.asyncio
async def test_classify_events_resolves_llm_for_task_owner(monkeypatch):
    from core import database
    from src.builtin_actions import action_classify_events

    class FakeCalendarEvent:
        dtstart = _Column()
        status = _Column()

    event = SimpleNamespace(
        summary="Demo presentation",
        event_type="work",
        importance="high",
        color=None,
        dtstart=datetime(2026, 1, 1, 9, 0, 0),
        location="",
    )
    db = _Db({FakeCalendarEvent: [event]})
    calls = _resolver_spy(monkeypatch)

    monkeypatch.setattr(database, "CalendarEvent", FakeCalendarEvent)
    monkeypatch.setattr(database, "SessionLocal", lambda: db)

    message, ok = await action_classify_events("alice")

    assert ok is True
    assert "Scanned 1 upcoming event" in message
    assert calls == ["alice"]
    assert db.closed is True
