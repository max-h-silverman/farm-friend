"""Unit checks for farmer operation helpers."""

from __future__ import annotations

from datetime import UTC, datetime
from unittest.mock import patch

from app.flows import farmer_ops
from app.repos.models import OpportunityDoc, OpportunityKind, OpportunityStatus


def test_first_claim_notification_uses_refreshed_filled_count() -> None:
    opp = OpportunityDoc(
        id="opp_1",
        farm_id="farm_1",
        kind=OpportunityKind.SHIFT,
        status=OpportunityStatus.FILLING,
        starts_at=datetime.now(UTC),
        headcount_needed=3,
        seats_filled=1,
        created_at=datetime.now(UTC),
        activity_tags=["weeding"],
    )

    with (
        patch.object(farmer_ops, "safe_send") as safe_send,
        patch.object(farmer_ops.opportunities_repo, "update_fields"),
    ):
        farmer_ops.notify_first_claim_if_unsent(
            opp=opp,
            volunteer_name="Alex",
            farmer_phone="+12065550001",
            messaging=object(),
        )

    body = safe_send.call_args.kwargs["body"]
    assert "1/3" in body
    assert "2/3" not in body
