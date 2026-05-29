"""Post-event check-in loop.

Scheduled function `tick_post_event` runs every 15 minutes and fires the
"any issues? Y/N" message to each farmer for events whose
`post_event_checkin_at` has arrived.

The Y/N reply is handled by the hotkey parser in post-event mode (so a bare
"Y" doesn't get confused with a claim). The message dispatch flow sets
`expecting_post_event_reply=True` when the farmer's last outbound was a
check-in question.

Window opps: instead of one ping per opp, send one ping per day-with-at-least-
one-confirmed-claim. Tracked in the `post_event_pings` sidecar collection
keyed by ISO date. Single-day opps continue to use the legacy
`post_event_checkin_sent` flag on the opp.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from app.copy import templates
from app.flows import _time
from app.flows._time import VASHON_TZ, format_when, to_local
from app.messaging import MessagingProvider, get_messaging_provider
from app.messaging._safe_send import safe_send
from app.repos import (
    farms_repo,
    messages_repo,
    opportunities_repo,
    post_event_pings_repo,
    users_repo,
)
from app.repos.models import (
    ClaimStatus,
    IntentLabel,
    MessageDirection,
    MessageDoc,
    OpportunityDoc,
    OpportunityKind,
    OpportunityStatus,
)


def run_checkin_tick(*, messaging: MessagingProvider | None = None) -> None:
    m = messaging or get_messaging_provider()
    now = datetime.now(UTC)
    if _time.is_quiet_hours(now):
        return  # Post-event checkins wait for morning.
    # Two surfaces:
    #   - Single-day opps gated by post_event_checkin_at + the legacy
    #     post_event_checkin_sent flag (unchanged from v1).
    #   - Window opps: walk confirmed claims grouped by scheduled_for_at.date(),
    #     fire one ping per (opp, date) where the day's check-in time has
    #     arrived AND no sidecar ping doc exists yet.
    due = opportunities_repo.list_due_for_post_event(now=now)
    for opp in due:
        if opp.window_end_at is not None:
            _send_window_checkins_for(opp=opp, messaging=m, now=now)
        else:
            _send_checkin_for(opp=opp, messaging=m)
    # Window opps may have late-firing days outside the legacy
    # `list_due_for_post_event` query (which checks the opp-level
    # post_event_checkin_at). Catch those by scanning OPEN/FILLING/FULL
    # window opps whose starts_at has passed.
    for opp in opportunities_repo.list_window_opps_in_progress(now=now):
        _send_window_checkins_for(opp=opp, messaging=m, now=now)


def _send_window_checkins_for(
    *, opp: OpportunityDoc, messaging: MessagingProvider, now: datetime,
) -> None:
    """Window opp: send one check-in per day that (a) had at least one
    CONFIRMED claim, (b) the day's post-event window has arrived (9am the
    morning after the claim's `scheduled_for_at`), and (c) no sidecar ping
    doc exists yet.

    The sidecar doc id is the ISO date in Vashon-local terms, idempotent so
    concurrent ticks can't double-send.
    """
    if opp.id is None:
        return
    farm = farms_repo.get_by_id(opp.farm_id)
    if not farm:
        return
    owner = users_repo.get_by_id(farm.owner_user_id)
    if not owner:
        return

    # Group confirmed claims by Vashon-local date.
    by_date: dict[str, datetime] = {}
    for claim in opportunities_repo.list_all_claims(opp.id):
        if claim.status != ClaimStatus.CONFIRMED:
            continue
        if claim.scheduled_for_at is None:
            continue
        local_date = to_local(claim.scheduled_for_at).date().isoformat()
        # Track the anchor datetime (one representative claim) for the
        # post-event timing check.
        if local_date not in by_date:
            by_date[local_date] = claim.scheduled_for_at

    for date_iso, anchor in by_date.items():
        # Per-day post-event time: 9am Vashon-local the day after the anchor.
        ping_at = _time.post_event_time_for(
            is_pickup=False, starts_at=anchor, deadline_at=None,
        )
        if ping_at is None or now < ping_at:
            continue
        if post_event_pings_repo.has_ping(opp_id=opp.id, date_iso=date_iso):
            continue
        when_text = format_when(anchor)
        body = templates.render_post_event_checkin(
            when_human=when_text, kind_label="shift"
        )
        provider_id = safe_send(messaging, to_phone=owner.phone, body=body)
        if provider_id is None:
            # Don't record the ping if send failed; we'll retry next tick.
            continue
        messages_repo.create(
            MessageDoc(
                direction=MessageDirection.OUTBOUND,
                provider_msg_id=provider_id,
                user_id=owner.id,
                opportunity_id=opp.id,
                body=body,
                intent_label=IntentLabel.POST_EVENT_CHECKIN,
                created_at=datetime.now(UTC),
            )
        )
        post_event_pings_repo.record_ping(
            opp_id=opp.id, date_iso=date_iso, sent_at=datetime.now(UTC),
        )


def _send_checkin_for(*, opp: OpportunityDoc, messaging: MessagingProvider) -> None:
    assert opp.id is not None
    farm = farms_repo.get_by_id(opp.farm_id)
    if not farm:
        return
    owner = users_repo.get_by_id(farm.owner_user_id)
    if not owner:
        return
    when_text = format_when(opp.starts_at) if opp.starts_at else (
        format_when(opp.deadline_at) if opp.deadline_at else "yesterday"
    )
    kind_label = "shift" if opp.kind == OpportunityKind.SHIFT else "pickup"
    body = templates.render_post_event_checkin(when_human=when_text, kind_label=kind_label)
    provider_id = safe_send(messaging, to_phone=owner.phone, body=body)
    if provider_id is not None:
        messages_repo.create(
            MessageDoc(
                direction=MessageDirection.OUTBOUND,
                provider_msg_id=provider_id,
                user_id=owner.id,
                opportunity_id=opp.id,
                body=body,
                intent_label=IntentLabel.POST_EVENT_CHECKIN,
                created_at=datetime.now(UTC),
            )
        )
    # Mark sent regardless of delivery success: the scheduled tick is one-shot.
    # If we left it pending after a delivery failure we'd retry on every tick
    # and double-text the farmer once Telnyx recovers.
    opportunities_repo.mark_post_event_sent(opp.id)
    if opp.status != OpportunityStatus.COMPLETED:
        opportunities_repo.update_status(opp.id, OpportunityStatus.COMPLETED)


def handle_post_event_reply(
    *,
    messaging: MessagingProvider,
    opportunity: OpportunityDoc,
    farmer_phone: str,
    answer: str,  # "Y" | "N"
) -> str:
    """Reply text to send the farmer after they answer the check-in."""
    if answer.upper().startswith("Y"):
        return "Glad to hear it — logged complete. Thanks!"
    # On N, ask for a brief detail. The follow-up text from the farmer will be
    # routed to the unified agent, which will typically clarify or escalate.
    return templates.render_post_event_followup()
