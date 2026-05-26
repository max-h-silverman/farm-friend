"""Claim resolution for YES replies.

Rules:
- Shifts: first-N-wins where N = headcount_needed. Late repliers get a waitlist
  message and a `waitlist` claim record. Cancellations can promote a waitlist
  claim.
- Pickups: single-claim race. First YES wins; later YESes get "already claimed".
  If headcount_needed > 1 on a pickup (big haul), behaves like a shift.
"""

from __future__ import annotations

from datetime import UTC, datetime

from app.copy import templates
from app.flows._time import format_deadline, format_when
from app.messaging import MessagingProvider
from app.repos import opportunities_repo
from app.repos.models import (
    ClaimDoc,
    ClaimStatus,
    OpportunityDoc,
    OpportunityKind,
    OpportunityStatus,
    UserDoc,
)


def handle_claim(
    *,
    messaging: MessagingProvider,
    opportunity: OpportunityDoc,
    volunteer: UserDoc,
    slots: int,
    farm_name: str,
    notify_farmer_phone: str | None,
) -> str:
    """Apply a YES claim; return the SMS body that should be sent back to the volunteer."""
    assert opportunity.id is not None
    assert volunteer.id is not None

    if opportunity.status in (OpportunityStatus.COMPLETED, OpportunityStatus.CANCELLED, OpportunityStatus.EXPIRED):
        return _stale_opportunity_body(opportunity, farm_name)

    seats_left = opportunity.headcount_needed - opportunity.seats_filled
    if seats_left <= 0:
        # Already full — record a waitlist claim and tell them.
        opportunities_repo.upsert_claim(
            opp_id=opportunity.id,
            claim=ClaimDoc(
                volunteer_user_id=volunteer.id,
                slots=slots,
                claimed_at=datetime.now(UTC),
                status=ClaimStatus.WAITLIST,
            ),
        )
        if opportunity.kind == OpportunityKind.PICKUP:
            return templates.render_pickup_already_claimed(farm_name=farm_name)
        return templates.render_shift_full(farm_name=farm_name)

    granted_slots = min(slots, seats_left)
    opportunities_repo.upsert_claim(
        opp_id=opportunity.id,
        claim=ClaimDoc(
            volunteer_user_id=volunteer.id,
            slots=granted_slots,
            claimed_at=datetime.now(UTC),
            status=ClaimStatus.CONFIRMED,
        ),
    )
    opportunities_repo.increment_seats(opportunity.id, by=granted_slots)
    new_filled = opportunity.seats_filled + granted_slots

    # First-claim notification to the farmer — once per opp.
    from app.flows import farmer_ops
    farmer_ops.notify_first_claim_if_unsent(
        opp=opportunity,
        volunteer_name=volunteer.name,
        farmer_phone=notify_farmer_phone,
        messaging=messaging,
    )

    # Move FILLING/OPEN -> FULL if we just filled the last seat.
    if new_filled >= opportunity.headcount_needed:
        opportunities_repo.update_status(opportunity.id, OpportunityStatus.FULL)
        if notify_farmer_phone:
            messaging.send(
                to_phone=notify_farmer_phone,
                body=f"{farm_name} is fully claimed for {farmer_ops.opp_short_summary(opportunity)}.",
            )
    else:
        if opportunity.status == OpportunityStatus.OPEN:
            opportunities_repo.update_status(opportunity.id, OpportunityStatus.FILLING)

    return _confirmation_body(opportunity, farm_name)


def handle_maybe(
    *,
    opportunity: OpportunityDoc,
    volunteer: UserDoc,
    farm_name: str,
) -> str:
    """Record soft interest on the opportunity without consuming a seat.

    Returned body is the volunteer ack. The interest is visible to admins
    via the claims subcollection (status=INTERESTED).
    """
    assert opportunity.id is not None
    assert volunteer.id is not None
    if opportunity.status in (
        OpportunityStatus.COMPLETED,
        OpportunityStatus.CANCELLED,
        OpportunityStatus.EXPIRED,
        OpportunityStatus.FULL,
    ):
        return _stale_opportunity_body(opportunity, farm_name)
    opportunities_repo.upsert_claim(
        opp_id=opportunity.id,
        claim=ClaimDoc(
            volunteer_user_id=volunteer.id,
            slots=0,
            claimed_at=datetime.now(UTC),
            status=ClaimStatus.INTERESTED,
        ),
    )
    return templates.render_maybe_ack(farm_name=farm_name)


def _confirmation_body(opp: OpportunityDoc, farm_name: str) -> str:
    if opp.kind == OpportunityKind.PICKUP:
        deadline_text = (
            format_deadline(opp.deadline_at) if opp.deadline_at else "today"
        )
        what = opp.produce_description or "the surplus pickup"
        return templates.render_claim_confirmed(
            farm_name=farm_name, when_human=deadline_text, activity_or_produce=what
        )
    when_text = format_when(opp.starts_at) if opp.starts_at else "soon"
    what = ", ".join(opp.activity_tags) if opp.activity_tags else "volunteer shift"
    return templates.render_claim_confirmed(
        farm_name=farm_name, when_human=when_text, activity_or_produce=what
    )


def _stale_opportunity_body(opp: OpportunityDoc, farm_name: str) -> str:
    if opp.kind == OpportunityKind.PICKUP:
        return templates.render_pickup_already_claimed(farm_name=farm_name)
    return templates.render_shift_full(farm_name=farm_name)
