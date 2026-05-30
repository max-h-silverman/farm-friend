"""Round-trip tests for the window-post / MVD fields added in PR 1.

Pure pydantic — no Firestore. Verifies:
  - new optional fields default correctly on legacy-shaped docs
  - new fields round-trip through model_dump + model_validate
  - ClaimStatus.PROPOSED is a valid status
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from app.repos.models import (
    TIME_OF_DAY_BUCKETS,
    ClaimDoc,
    ClaimStatus,
    OpportunityDoc,
    OpportunityKind,
    OpportunityStatus,
    MessageDirection,
    MessageDoc,
)


def _now() -> datetime:
    return datetime(2026, 6, 3, 21, 0, tzinfo=UTC)


def _make_opp(**overrides) -> OpportunityDoc:
    defaults = dict(
        farm_id="f_1",
        kind=OpportunityKind.SHIFT,
        status=OpportunityStatus.OPEN,
        starts_at=_now() + timedelta(days=1),
        duration_min=180,
        headcount_needed=2,
        activity_tags=["harvest"],
        created_at=_now(),
    )
    defaults.update(overrides)
    return OpportunityDoc(**defaults)


def test_opportunity_legacy_doc_defaults():
    """An OpportunityDoc built without the new fields gets sane defaults."""
    opp = _make_opp()
    assert opp.window_end_at is None
    assert opp.time_of_day_bucket is None
    assert opp.headcount_open is False
    assert opp.seats_held == 0
    assert opp.seats_filled == 0
    assert opp.media_urls == []


def test_message_intake_draft_defaults_and_roundtrip():
    msg = MessageDoc(
        direction=MessageDirection.OUTBOUND,
        provider_msg_id="p1",
        body="How many people do you need?",
        created_at=_now(),
    )
    assert msg.intake_draft is None

    draft = {
        "kind": "shift",
        "activity_tags": ["planting"],
        "time_of_day_bucket": "morning",
        "missing_fields": ["headcount"],
    }
    with_draft = msg.model_copy(update={"intake_draft": draft})
    restored = MessageDoc.model_validate(with_draft.model_dump(mode="python"))
    assert restored.intake_draft == draft


def test_opportunity_media_urls_roundtrip():
    opp = _make_opp(
        kind=OpportunityKind.PICKUP,
        starts_at=None,
        deadline_at=_now() + timedelta(days=1),
        produce_description="20 lbs plums",
        destination="farm stand",
        media_urls=["https://media.example.test/pickup.jpg"],
    )
    data = opp.model_dump(mode="python")
    restored = OpportunityDoc.model_validate(data)
    assert restored.media_urls == ["https://media.example.test/pickup.jpg"]


def test_opportunity_window_fields_roundtrip():
    """Window fields survive a serialize → deserialize cycle."""
    opp = _make_opp(
        window_end_at=_now() + timedelta(days=5),
        time_of_day_bucket="morning",
        headcount_open=True,
        seats_held=2,
        seats_filled=1,
    )
    data = opp.model_dump(mode="python")
    restored = OpportunityDoc.model_validate(data)
    assert restored.window_end_at == opp.window_end_at
    assert restored.time_of_day_bucket == "morning"
    assert restored.headcount_open is True
    assert restored.seats_held == 2
    assert restored.seats_filled == 1


def test_opportunity_bucket_values_are_known():
    """Each canonical bucket is accepted as a value. (Pydantic doesn't enforce
    membership here — string is intentional so non-canonical values can be
    persisted defensively — but the canonical list is the contract.)"""
    for bucket in TIME_OF_DAY_BUCKETS:
        opp = _make_opp(time_of_day_bucket=bucket)
        assert opp.time_of_day_bucket == bucket


def test_claim_legacy_doc_defaults():
    """A ClaimDoc built without scheduled_for_at defaults to None."""
    claim = ClaimDoc(
        volunteer_user_id="u_vol_a",
        slots=1,
        claimed_at=_now(),
        status=ClaimStatus.CONFIRMED,
    )
    assert claim.scheduled_for_at is None


def test_claim_scheduled_for_at_roundtrip():
    """scheduled_for_at survives serialization."""
    when = _now() + timedelta(days=2)
    claim = ClaimDoc(
        volunteer_user_id="u_vol_a",
        slots=1,
        claimed_at=_now(),
        status=ClaimStatus.PROPOSED,
        scheduled_for_at=when,
    )
    data = claim.model_dump(mode="python")
    restored = ClaimDoc.model_validate(data)
    assert restored.scheduled_for_at == when
    assert restored.status == ClaimStatus.PROPOSED


def test_proposed_is_a_valid_claim_status():
    """PROPOSED is reachable from the enum and distinct from CONFIRMED."""
    assert ClaimStatus.PROPOSED.value == "proposed"
    assert ClaimStatus.PROPOSED != ClaimStatus.CONFIRMED


def test_time_of_day_buckets_match_doc():
    """The canonical bucket list matches the rethink doc's MVD section."""
    expected = {
        "early_morning", "morning", "late_morning", "midday",
        "afternoon", "late_afternoon", "early_evening", "evening",
    }
    assert set(TIME_OF_DAY_BUCKETS) == expected
