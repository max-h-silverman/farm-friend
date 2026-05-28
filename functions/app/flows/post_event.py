"""Post-event check-in loop.

Scheduled function `tick_post_event` runs every 15 minutes and fires the
"any issues? Y/N" message to each farmer for events whose
`post_event_checkin_at` has arrived.

The Y/N reply is handled by the hotkey parser in post-event mode (so a bare
"Y" doesn't get confused with a claim). The message dispatch flow sets
`expecting_post_event_reply=True` when the farmer's last outbound was a
check-in question.
"""

from __future__ import annotations

from datetime import UTC, datetime

from app.copy import templates
from app.flows import _time
from app.flows._time import format_when
from app.messaging import MessagingProvider, get_messaging_provider
from app.messaging._safe_send import safe_send
from app.repos import farms_repo, messages_repo, opportunities_repo, users_repo
from app.repos.models import (
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
    due = opportunities_repo.list_due_for_post_event(now=now)
    for opp in due:
        _send_checkin_for(opp=opp, messaging=m)


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
