"""Audit log of unified-agent decisions.

Observability only — one compact record per inbound agent call, so the
coordinator can see what the (frozen, open-weight) model is actually deciding
in production. Never on the critical path: writes are best-effort and a failure
here must not affect the user-facing reply.

TTL-purged like `messages` (90 days), since records may carry inbound excerpts.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from app.firebase_app import db

from ._base import model_to_dict, snapshot_to_model
from .models import AgentDecisionDoc


COLLECTION = "agent_decisions"
_TTL_DAYS = 90


def create(doc: AgentDecisionDoc) -> AgentDecisionDoc:
    if doc.ttl is None:
        doc = doc.model_copy(
            update={"ttl": doc.created_at + timedelta(days=_TTL_DAYS)}
        )
    ref = db.collection(COLLECTION).document()
    ref.set(model_to_dict(doc))
    return doc.model_copy(update={"id": ref.id})


def list_recent(limit: int = 50) -> list[AgentDecisionDoc]:
    """Most recent decisions, newest first. For the admin view."""
    q = (
        db.collection(COLLECTION)
        .order_by("created_at", direction="DESCENDING")
        .limit(limit)
    )
    return [snapshot_to_model(s, AgentDecisionDoc) for s in q.stream() if s.exists]  # type: ignore[misc]


def list_by_mode(mode: str, *, since: datetime | None = None, limit: int = 100) -> list[AgentDecisionDoc]:
    """Decisions of a given mode (e.g. all `escalate`) since a cutoff. Lets the
    coordinator audit a specific decision class during pilot."""
    cutoff = since or (datetime.now(UTC) - timedelta(days=7))
    q = (
        db.collection(COLLECTION)
        .where("mode", "==", mode)
        .where("created_at", ">=", cutoff)
        .limit(limit)
    )
    return [snapshot_to_model(s, AgentDecisionDoc) for s in q.stream() if s.exists]  # type: ignore[misc]
