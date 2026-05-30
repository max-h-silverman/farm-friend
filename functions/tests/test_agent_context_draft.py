"""Tests for model-maintained intake draft context."""

from __future__ import annotations

from datetime import UTC, datetime

from app.flows.agent_context import _current_draft_from
from app.repos.models import IntentLabel, MessageDirection, MessageDoc


def _outbound(**overrides) -> MessageDoc:
    data = dict(
        direction=MessageDirection.OUTBOUND,
        provider_msg_id="p1",
        body="What time should it start?",
        intent_label=IntentLabel.CLARIFY,
        created_at=datetime.now(UTC),
    )
    data.update(overrides)
    return MessageDoc(**data)


def test_current_draft_comes_from_last_outbound_intake_draft() -> None:
    draft = {
        "kind": "shift",
        "activity_tags": ["planting"],
        "missing_fields": ["headcount"],
    }
    msg = _outbound(intake_draft=draft)

    assert _current_draft_from(last_outbound=msg, target_opp=None) == draft


def test_current_draft_can_fall_back_to_pending_action_payload() -> None:
    parsed = {
        "kind": "shift",
        "activity_tags": ["planting"],
        "headcount_needed": 2,
        "missing_fields": [],
    }
    msg = _outbound(
        intent_label=IntentLabel.PENDING_CONFIRMATION,
        pending_action={"payload": {"parsed": parsed}},
    )

    assert _current_draft_from(last_outbound=msg, target_opp=None) == parsed
