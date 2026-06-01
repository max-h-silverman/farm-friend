"""Backstops for model-maintained intake draft memory."""

from __future__ import annotations

from app.flows.message_dispatch import (
    _draft_axis_answered,
    _draft_is_complete_post,
    _merge_intake_draft_for_turn,
    _next_unanswered_axis_if_already_answered,
)
from app.repos.models import UserRole


def test_merge_preserves_activity_when_headcount_answer_arrives() -> None:
    previous = {
        "kind": "shift",
        "starts_at": "2026-06-07T00:00:00-07:00",
        "time_of_day_bucket": "morning",
        "activity_detail": "Planting",
        "headcount_needed": None,
        "missing_fields": ["headcount"],
    }
    model_output = {
        "kind": "shift",
        "starts_at": "2026-06-07T00:00:00-07:00",
        "time_of_day_bucket": "morning",
        "activity_detail": "",
        "headcount_needed": 3,
        "missing_fields": ["activity"],
    }

    merged = _merge_intake_draft_for_turn(
        output_draft=model_output,
        previous_draft=previous,
        inbound_text="two or three",
        recent_inbound_texts=["I need help with planting tomato starts on sun morn"],
        sender_role=UserRole.FARMER,
    )

    # Non-empty previous activity_detail is preserved when the new turn's draft
    # leaves it empty (the merge never downgrades a filled field).
    assert merged is not None
    assert merged["activity_detail"] == "Planting"
    assert merged["headcount_needed"] == 3
    assert merged["missing_fields"] == []


def test_merge_no_longer_recovers_activity_from_raw_text() -> None:
    # Activity-model redesign: the deterministic crop/slug recovery is gone. The
    # agent supplies activity_detail directly; if it doesn't, the activity axis
    # stays missing (the agent will clarify next turn). This documents the
    # intentional removal of the old text-recovery enrichment.
    model_output = {
        "kind": "shift",
        "starts_at": "2026-06-07T00:00:00-07:00",
        "time_of_day_bucket": "morning",
        "activity_detail": "",
        "headcount_needed": 3,
        "missing_fields": ["activity"],
    }

    merged = _merge_intake_draft_for_turn(
        output_draft=model_output,
        previous_draft=None,
        inbound_text="two or three",
        recent_inbound_texts=["I need help with planting tomato starts on sun morn"],
        sender_role=UserRole.FARMER,
    )

    assert merged is not None
    assert (merged.get("activity_detail") or "") == ""
    assert "activity" in merged["missing_fields"]
    assert _draft_axis_answered(axis="activity", draft=merged) is False
    assert _draft_is_complete_post(merged) is False


def test_clarify_axis_guard_skips_already_answered_activity() -> None:
    draft = {
        "kind": "shift",
        "starts_at": "2026-06-07T00:00:00-07:00",
        "time_of_day_bucket": "morning",
        "activity_detail": "Planting",
        "headcount_needed": None,
    }

    assert (
        _next_unanswered_axis_if_already_answered(axis="activity", draft=draft)
        == "headcount"
    )
