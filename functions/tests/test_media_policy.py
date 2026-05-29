"""Policy checks for pickup photo delivery."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from app.flows.message_dispatch import _confirmed_pickup_media_urls
from app.repos.models import OpportunityDoc, OpportunityKind, OpportunityStatus


def _opp(*, kind: OpportunityKind) -> OpportunityDoc:
    return OpportunityDoc(
        farm_id="f_1",
        kind=kind,
        status=OpportunityStatus.OPEN,
        deadline_at=datetime.now(UTC) + timedelta(hours=3),
        starts_at=datetime.now(UTC) + timedelta(hours=3),
        headcount_needed=1,
        activity_tags=["harvest"] if kind == OpportunityKind.SHIFT else [],
        produce_description="20 lbs plums" if kind == OpportunityKind.PICKUP else None,
        destination="farm stand" if kind == OpportunityKind.PICKUP else None,
        media_urls=["https://media.example.test/pickup.jpg"],
        created_at=datetime.now(UTC),
    )


def test_pickup_photo_goes_with_confirmed_claim_only() -> None:
    opp = _opp(kind=OpportunityKind.PICKUP)

    assert _confirmed_pickup_media_urls(opp, "Confirmed: pickup details") == [
        "https://media.example.test/pickup.jpg"
    ]
    assert _confirmed_pickup_media_urls(opp, "Farm Friend Vashon: pickup available") == []


def test_shift_confirmations_do_not_get_pickup_photo_media() -> None:
    opp = _opp(kind=OpportunityKind.SHIFT)

    assert _confirmed_pickup_media_urls(opp, "Confirmed: shift details") == []
