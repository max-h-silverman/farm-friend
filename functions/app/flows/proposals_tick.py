"""Auto-confirm tick for window-opp PROPOSED claims.

When a volunteer claims a specific day on a window opp, the claim sits in
PROPOSED state awaiting the farmer's ACCEPT/DECLINE. Farmers may be in a
field and not see the SMS in a timely way, so we don't strand the volunteer:
after a settings-configured timeout, we auto-confirm and notify the farmer
after the fact with a forward-exit (CANCEL/DROP).

Two timers, picked based on how close the claim's scheduled day is:
  - `proposal_auto_confirm_far_min` (default 240 = 4h) when the day is >24h out
  - `proposal_auto_confirm_close_min` (default 60 = 1h) when the day is <24h out

Quiet hours are respected for the auto-confirm fan-out (farmer + volunteer
notifications) — we let the tick no-op overnight and pick up at 7am.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from app.config import load_settings
from app.copy import templates
from app.flows import _time, proposals as proposals_flow
from app.flows._time import to_local
from app.messaging import MessagingProvider, get_messaging_provider
from app.messaging._safe_send import safe_send
from app.repos import (
    farms_repo,
    messages_repo,
    opportunities_repo,
    users_repo,
)
from app.repos.models import (
    ClaimDoc,
    IntentLabel,
    MessageDirection,
    MessageDoc,
    OpportunityDoc,
)


def run_proposals_tick(*, messaging: MessagingProvider | None = None) -> None:
    """Auto-confirm PROPOSED claims whose proposal timer has elapsed."""
    m = messaging or get_messaging_provider()
    now = datetime.now(UTC)
    if _time.is_quiet_hours(now):
        return
    settings = load_settings()
    # Only window opps have PROPOSED claims. Walk in-progress window opps;
    # for each, check each PROPOSED claim's age against the timer.
    in_progress = opportunities_repo.list_window_opps_in_progress(now=now)
    # Also scan recent window opps where starts_at is in the future but
    # proposals may already be aging — list_in_progress only returns those
    # whose first day has started. PROPOSED claims on a Friday opp will start
    # accumulating on Wednesday; pick those up via a separate query.
    upcoming = opportunities_repo.list_upcoming_window_opps(now=now)
    seen_ids: set[str] = set()
    for opp in list(in_progress) + list(upcoming):
        if opp.id is None or opp.id in seen_ids:
            continue
        seen_ids.add(opp.id)
        _process_opp(opp=opp, now=now, settings=settings, messaging=m)


def _process_opp(
    *,
    opp: OpportunityDoc,
    now: datetime,
    settings,
    messaging: MessagingProvider,
) -> None:
    if opp.id is None:
        return
    proposed = opportunities_repo.list_proposed_claims(opp.id)
    if not proposed:
        return
    farm = farms_repo.get_by_id(opp.farm_id)
    if farm is None:
        return
    farmer = users_repo.get_by_id(farm.owner_user_id)
    for claim in proposed:
        if not _proposal_timer_elapsed(claim=claim, now=now, settings=settings):
            continue
        _auto_confirm(
            opp=opp, claim=claim, farm=farm, farmer=farmer,
            messaging=messaging, now=now,
        )


def _proposal_timer_elapsed(
    *, claim: ClaimDoc, now: datetime, settings,
) -> bool:
    """True iff the claim has been PROPOSED long enough to auto-confirm."""
    if claim.scheduled_for_at is None:
        return False
    age = now - claim.claimed_at
    # Pick the timer based on how soon the scheduled day is.
    if (claim.scheduled_for_at - now) <= timedelta(hours=24):
        timeout = timedelta(minutes=settings.proposal_auto_confirm_close_min)
    else:
        timeout = timedelta(minutes=settings.proposal_auto_confirm_far_min)
    return age >= timeout


def _auto_confirm(
    *,
    opp: OpportunityDoc,
    claim: ClaimDoc,
    farm,
    farmer,
    messaging: MessagingProvider,
    now: datetime,
) -> None:
    """Promote a PROPOSED claim to CONFIRMED and notify farmer + volunteer."""
    if opp.id is None or claim.scheduled_for_at is None:
        return
    claim_doc_id = opportunities_repo._claim_doc_id(
        volunteer_user_id=claim.volunteer_user_id,
        scheduled_for_at=claim.scheduled_for_at,
    )
    outcome = opportunities_repo.accept_proposal_in_transaction(
        opp_id=opp.id, claim_doc_id=claim_doc_id, now=now,
    )
    if not outcome.found or outcome.was_already_decided:
        # Raced with the farmer's manual decision; nothing else to do.
        return

    volunteer = users_repo.get_by_id(claim.volunteer_user_id)
    day_human = _format_day_with_time(opp=opp, scheduled_for_at=claim.scheduled_for_at)
    opp_summary = _proposal_opp_summary(opp=opp)

    # Notify the farmer (after the fact, with forward exit).
    if farmer and farmer.phone and volunteer:
        body = templates.render_proposal_auto_confirmed_to_farmer(
            volunteer_name=volunteer.name,
            day_human=day_human,
            opp_summary=opp_summary,
        )
        provider_id = safe_send(messaging, to_phone=farmer.phone, body=body)
        if provider_id is not None:
            messages_repo.create(
                MessageDoc(
                    direction=MessageDirection.OUTBOUND,
                    provider_msg_id=provider_id,
                    user_id=farmer.id,
                    opportunity_id=opp.id,
                    body=body,
                    intent_label=IntentLabel.AUTO_CONFIRM_NOTICE,
                    created_at=now,
                )
            )

    # Notify the volunteer (they're now confirmed).
    if volunteer and volunteer.phone and farm:
        activity_or_produce = (
            ", ".join(opp.activity_tags) if opp.activity_tags else "a shift"
        )
        vol_body = templates.render_proposal_accepted_to_volunteer(
            farm_name=farm.name,
            day_human=day_human,
            activity_or_produce=activity_or_produce,
        )
        provider_id = safe_send(messaging, to_phone=volunteer.phone, body=vol_body)
        if provider_id is not None:
            messages_repo.create(
                MessageDoc(
                    direction=MessageDirection.OUTBOUND,
                    provider_msg_id=provider_id,
                    user_id=volunteer.id,
                    opportunity_id=opp.id,
                    body=vol_body,
                    intent_label=IntentLabel.ACTION_RECEIPT,
                    created_at=now,
                )
            )


def _format_day_with_time(
    *, opp: OpportunityDoc, scheduled_for_at: datetime,
) -> str:
    """Mirror of proposals._format_day_with_time. Inlined to avoid coupling."""
    local = to_local(scheduled_for_at)
    day = local.strftime("%a %-m/%-d")
    if opp.time_of_day_bucket:
        return f"{day} {proposals_flow._BUCKET_PHRASE.get(opp.time_of_day_bucket, opp.time_of_day_bucket)}"
    if opp.starts_at:
        starts_local = to_local(opp.starts_at)
        hour = starts_local.strftime("%-I%p").lower()
        return f"{day} {hour}"
    return day


def _proposal_opp_summary(*, opp: OpportunityDoc) -> str:
    activity = ", ".join(opp.activity_tags) if opp.activity_tags else "shift"
    if opp.window_end_at:
        return f"{activity} window"
    return f"{activity} shift"
