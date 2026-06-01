"""Agent-decision audit records: TTL defaulting and field capture.

The repo's `create` touches Firestore, so we patch the db collection handle and
assert on the document we hand it. The point of these tests is the TTL default
(90 days) and that the best-effort write captures the decision shape.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from unittest.mock import MagicMock, patch

from app.repos import agent_decisions_repo
from app.repos.models import AgentDecisionDoc


def test_create_defaults_ttl_to_90_days() -> None:
    created_at = datetime(2026, 6, 1, tzinfo=UTC)
    captured: dict = {}

    fake_ref = MagicMock()
    fake_ref.id = "doc123"
    fake_ref.set.side_effect = lambda d: captured.update(d)
    fake_collection = MagicMock()
    fake_collection.document.return_value = fake_ref
    fake_db = MagicMock()
    fake_db.collection.return_value = fake_collection

    with patch.object(agent_decisions_repo, "db", fake_db):
        result = agent_decisions_repo.create(
            AgentDecisionDoc(
                user_id="u1",
                mode="confirm",
                action_name="claim_opportunity",
                rationale="unique match",
                created_at=created_at,
            )
        )

    assert result.id == "doc123"
    assert captured["ttl"] == created_at + timedelta(days=90)
    assert captured["mode"] == "confirm"
    assert captured["action_name"] == "claim_opportunity"
    # id is the doc path, not a stored field.
    assert "id" not in captured


def test_create_preserves_explicit_ttl() -> None:
    explicit = datetime(2026, 12, 31, tzinfo=UTC)
    fake_ref = MagicMock()
    fake_ref.id = "d"
    fake_collection = MagicMock()
    fake_collection.document.return_value = fake_ref
    fake_db = MagicMock()
    fake_db.collection.return_value = fake_collection

    with patch.object(agent_decisions_repo, "db", fake_db):
        agent_decisions_repo.create(
            AgentDecisionDoc(
                mode="reply",
                created_at=datetime(2026, 6, 1, tzinfo=UTC),
                ttl=explicit,
            )
        )
    fake_ref.set.assert_called_once()
    assert fake_ref.set.call_args[0][0]["ttl"] == explicit
