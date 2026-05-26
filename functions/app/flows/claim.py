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
from app.messaging._safe_send import safe_send
from app.repos import opportunities_repo
from app.repos.models import (
    ClaimDoc,
    ClaimStatus,
    OpportunityDoc,
    OpportunityKind,
    OpportunityStatus,
    UserDoc,
)

# ClaimDoc / ClaimStatus stay imported for handle_maybe below.


def handle_claim(
    *,
    messaging: MessagingProvider,
    opportunity: OpportunityDoc,
    volunteer: UserDoc,
    slots: int,
    farm_name: str,
    notify_farmer_phone: str | None,
) -> str:
    """Apply a YES claim; return the SMS body that should be sent back to the volunteer.

    Seat resolution runs inside a Firestore transaction so concurrent YES
    messages can't overshoot `headcount_needed`. The transaction returns a
    ClaimOutcome describing what happened; SMS side-effects (volunteer reply,
    farmer milestones) fire here, outside the transaction.
    """
    assert opportunity.id is not None
    assert volunteer.id is not None

    if opportunity.status in (OpportunityStatus.COMPLETED, OpportunityStatus.CANCELLED, OpportunityStatus.EXPIRED):
        return _stale_opportunity_body(opportunity, farm_name)

    outcome = opportunities_repo.try_claim_in_transaction(
        opp_id=opportunity.id,
        volunteer_user_id=volunteer.id,
        requested_slots=slots,
        now=datetime.now(UTC),
    )

    if outcome.is_stale:
        return _stale_opportunity_body(opportunity, farm_name)

    if outcome.is_waitlist:
        if outcome.kind == OpportunityKind.PICKUP:
            return templates.render_pickup_already_claimed(farm_name=farm_name)
        return templates.render_shift_full(farm_name=farm_name)

    # Re-load with the post-transaction state so milestone helpers see the
    # updated seats_filled / status when deciding whether to fire.
    refreshed = opportunities_repo.get_by_id(opportunity.id) or opportunity

    from app.flows import farmer_ops
    farmer_ops.notify_first_claim_if_unsent(
        opp=refreshed,
        volunteer_name=volunteer.name,
        farmer_phone=notify_farmer_phone,
        messaging=messaging,
    )

    if outcome.just_filled and notify_farmer_phone:
        safe_send(
            messaging,
            to_phone=notify_farmer_phone,
            body=f"{farm_name} is fully claimed for {farmer_ops.opp_short_summary(refreshed)}.",
        )

    return _confirmation_body(refreshed, farm_name)


def handle_volunteer_drop(
    *,
    messaging: MessagingProvider,
    opportunity: OpportunityDoc,
    volunteer: UserDoc,
) -> str:
    """Volunteer is dropping a confirmed claim (typically in reply to a
    confirmation reminder). Decrements seats_filled atomically, flips status
    back to FILLING if it was FULL, resets next_escalation_at so the existing
    outreach tick re-fires, and notifies the farmer of the drop.

    Returns the SMS body to send back to the volunteer. If their claim wasn't
    actually CONFIRMED (already dropped, never confirmed, opp gone), returns
    a neutral ack rather than erroring.
    """
    assert opportunity.id is not None
    assert volunteer.id is not None
    outcome = opportunities_repo.drop_confirmed_claim_in_transaction(
        opp_id=opportunity.id,
        volunteer_user_id=volunteer.id,
        now=datetime.now(UTC),
    )
    if not outcome.dropped:
        # Either never confirmed, or already dropped. Acknowledge harmlessly.
        return templates.render_volunteer_drop_ack()

    # Re-fire outreach. The existing escalation tick re-pings the broader pool
    # (or insiders, if we're somehow still in insider tier) and skips anyone
    # already pinged, claimed, or muted — so this is safe even if the opp was
    # already saturated with outreach attempts.
    opportunities_repo.set_next_escalation(
        opportunity.id, at=datetime.now(UTC), tier=opportunity.current_tier
    )

    # Notify the farmer. Direct one-to-one, sends even in quiet hours because
    # the farmer needs to know in real time.
    from app.flows import farmer_ops
    refreshed = opportunities_repo.get_by_id(opportunity.id) or opportunity
    farm = None
    try:
        from app.repos import farms_repo as _farms_repo
        from app.repos import users_repo as _users_repo
        farm = _farms_repo.get_by_id(refreshed.farm_id)
        farmer = _users_repo.get_by_id(farm.owner_user_id) if farm else None
        if farmer and farmer.phone:
            body = templates.render_volunteer_dropped_to_farmer(
                opp_summary=farmer_ops.opp_short_summary(refreshed),
                volunteer_name=volunteer.name,
                filled=outcome.seats_filled_after,
                headcount=outcome.headcount_needed,
            )
            safe_send(messaging, to_phone=farmer.phone, body=body)
    except Exception:  # noqa: BLE001 — farmer notification is best-effort
        pass

    return templates.render_volunteer_drop_ack()


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
