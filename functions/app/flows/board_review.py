"""Proactive review tick — the agent-driven "coordinator on the board" flow.

Runs every 30 minutes during waking hours (quiet-hours gated). Builds a
board-state context (open opps, open offers, upcoming confirmations, stalled
threads, remaining budget) and calls the unified agent in `mode="review"`.

The agent returns a ranked list of proposals. Dispatch applies budget filters
(per-user 48h, per-opp 2-lifetime, per-tick global ceiling) and either:
  - Sends a user-facing PENDING_CONFIRMATION SMS (state-changing proposals)
  - Sends a user-facing informational SMS (no action attached)
  - Creates an admin flag (target=admin, or proposal exceeded a budget)

The agent never directly sends — it proposes, dispatch decides.

See docs/refactor-unified-agent.md §"Proactive review".
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from app.agent.unified import (
    BoardState,
    ClaimSummary,
    OfferSummary,
    OppSummary,
    ReviewProposal,
    run_review_agent,
)
from app.config import load_settings
from app.copy import templates
from app.flows import farmer_ops
from app.flows._time import VASHON_TZ, is_quiet_hours
from app.llm import get_llm_client
from app.messaging import get_messaging_provider
from app.messaging._safe_send import safe_send
from app.repos import (
    farms_repo,
    flags_repo,
    messages_repo,
    mutes_repo,
    offers_repo,
    opportunities_repo,
    users_repo,
)
from app.repos.models import (
    CANONICAL_ACTIVITIES,
    FlagDoc,
    IntentLabel,
    MessageDirection,
    MessageDoc,
    MuteDimension,
    OpportunityKind,
    OpportunityStatus,
)


def run_board_review_tick() -> None:
    """Entry point called by the scheduled function.

    Quiet-hours-gated: a no-op between 11pm and 7am Vashon local. The next
    tick after 7am catches up. ESCALATE-class issues are routed via the
    inbound dispatch path's `_handle_escalation`, NOT this tick — this is
    only for proactive nudges.
    """
    if is_quiet_hours(datetime.now(VASHON_TZ)):
        return

    settings = load_settings()
    messaging = get_messaging_provider(settings)
    llm = get_llm_client(settings)

    board = _build_board_state()
    if _is_board_trivially_empty(board):
        # Nothing to review. Don't burn an LLM call.
        return

    try:
        output = run_review_agent(llm=llm, board=board)
    except Exception as e:
        flags_repo.create(
            FlagDoc(
                message_id=None,
                flagged_by_user_id=None,
                reason=f"Board review agent failed: {type(e).__name__}: {e}",
                created_at=datetime.now(UTC),
            )
        )
        return

    _route_review_proposals(
        proposals=output.proposals,
        per_tick_budget=settings.agent_review_per_tick_max,
        per_user_budget_hours=settings.agent_nudge_budget_hours,
        per_opp_max=settings.agent_nudge_per_opp_max,
        admin_only=settings.agent_review_admin_only,
        messaging=messaging,
    )


# ---------------------------------------------------------------------------
# Building the board state
# ---------------------------------------------------------------------------
def _build_board_state() -> BoardState:
    now = datetime.now(VASHON_TZ)

    # All OPEN/FILLING opps.
    open_opps: list[OppSummary] = []
    farm_lookup = {f.id: f for f in farms_repo.list_all() if f.id}
    for farm_id, farm in farm_lookup.items():
        for opp in opportunities_repo.list_open_for_farm(farm_id):
            open_opps.append(_opp_summary_for_board(opp=opp, farm=farm))

    # All OPEN offers.
    open_offers: list[OfferSummary] = []
    # offers_repo doesn't have a list_all_open, but list_open_aged with a far-future
    # cutoff works to enumerate them. (Defensive: created_at < far-future is always true.)
    for offer in offers_repo.list_open_aged(since=now + timedelta(days=1)):
        volunteer = users_repo.get_by_id(offer.volunteer_user_id)
        age_days = max(0, (now.replace(tzinfo=UTC) - offer.created_at).days)
        open_offers.append(OfferSummary(
            offer_id=offer.id or "",
            volunteer_name=volunteer.name if volunteer else "unknown",
            activity_tags=offer.activity_tags,
            when_human=_offer_when_human(offer),
            age_days=age_days,
        ))

    # Upcoming confirmation reminders sent in the last 24h.
    # We pass these so the agent doesn't propose contacting a user the
    # confirmation-reminder tick is already pinging.
    upcoming_confirmations: list[ClaimSummary] = []
    # Conservatively skip building this list in v1 — `tick_confirmations`
    # handles its own load. Empty list is the safest signal to the agent.

    # Stalled threads: outbound CLARIFY with no subsequent inbound for >4h.
    # Computing this efficiently needs a "messages where intent=CLARIFY and
    # no later inbound from same user" query. Approximation: scan recent
    # CLARIFY outbounds and check freshness.
    stalled_threads: list[dict] = _find_stalled_clarify_threads(now=now)

    return BoardState(
        now_local_iso=now.isoformat(),
        open_opps=open_opps,
        open_offers=open_offers,
        upcoming_confirmations=upcoming_confirmations,
        stalled_threads=stalled_threads,
        per_tick_send_budget=load_settings().agent_review_per_tick_max,
        canonical_activities=list(CANONICAL_ACTIVITIES),
    )


def _opp_summary_for_board(*, opp, farm) -> OppSummary:
    activity_or_produce = (
        ", ".join(opp.activity_tags) if opp.kind == OpportunityKind.SHIFT
        else (opp.produce_description or "surplus")
    )
    return OppSummary(
        opp_id=opp.id or "",
        farm_name=farm.name if farm else "unknown farm",
        kind=opp.kind.value,
        status=opp.status.value,
        when_human=farmer_ops.opp_short_summary(opp),
        activity_or_produce=activity_or_produce,
        headcount_needed=opp.headcount_needed,
        seats_filled=opp.seats_filled,
        requirements_text=opp.requirements_text or "",
    )


def _offer_when_human(offer) -> str:
    if offer.earliest_at and offer.latest_at:
        return f"{offer.earliest_at.date().isoformat()} – {offer.latest_at.date().isoformat()}"
    if offer.latest_at:
        return f"by {offer.latest_at.date().isoformat()}"
    return "flexible"


def _find_stalled_clarify_threads(*, now: datetime) -> list[dict]:
    """Find users whose most recent outbound was a CLARIFY > 4h ago with no
    subsequent inbound. Cheap at pilot scale; revisit if it grows."""
    # We don't have a direct cross-collection query here; scan known users.
    # At pilot scale (~50 vols, 2-3 farms) this is dozens of doc reads max.
    stalled: list[dict] = []
    cutoff = now.replace(tzinfo=UTC) - timedelta(hours=4)
    for user in users_repo.list_active():
        if not user.id:
            continue
        last = messages_repo.latest_outbound_for_user(user.id)
        if last is None or last.intent_label != IntentLabel.CLARIFY:
            continue
        if last.created_at > cutoff:
            continue
        # Was there a later inbound? Check the user's recent messages.
        recent = messages_repo.list_for_user(user.id, limit=5)
        # list_for_user returns DESC; if the first item is inbound and newer than `last`, no stall.
        if recent and recent[0].direction == MessageDirection.INBOUND and recent[0].created_at > last.created_at:
            continue
        stalled.append({
            "user_id": user.id,
            "user_name": user.name,
            "last_clarify_at_iso": last.created_at.isoformat(),
            "last_clarify_body": last.body[:200],
        })
    return stalled


def _is_board_trivially_empty(board: BoardState) -> bool:
    """Skip the LLM call entirely when there's nothing actionable.

    Saves cost on most ticks at pilot scale where the board is often quiet.
    """
    return (
        not board.open_opps
        and not board.open_offers
        and not board.stalled_threads
    )


# ---------------------------------------------------------------------------
# Routing the agent's proposals through budget filters
# ---------------------------------------------------------------------------
def _route_review_proposals(
    *,
    proposals: list[ReviewProposal],
    per_tick_budget: int,
    per_user_budget_hours: int,
    per_opp_max: int,
    messaging,
    admin_only: bool = True,
) -> None:
    sent_count = 0
    now = datetime.now(UTC)

    # Sort by priority high→low so the budget eats the most important first.
    priority_rank = {"high": 0, "medium": 1, "low": 2}
    sorted_proposals = sorted(
        proposals, key=lambda p: priority_rank.get(p.priority, 99),
    )

    for proposal in sorted_proposals:
        # Pilot safety gate: when admin_only is set, the review tick never
        # autonomously SMSes a user. Every proposal — including state-changing
        # ones — lands on the admin worklist instead, where the coordinator decides. This
        # removes the highest carrier-complaint risk (unsolicited proactive
        # outbound) while OLMo's review-mode behavior is still unproven. Flip
        # AGENT_REVIEW_ADMIN_ONLY=0 to re-enable user-facing nudges.
        if admin_only and proposal.target == "user":
            _create_admin_flag(
                proposal,
                override_reason="Review tick in admin-only mode (pilot); not sent to user",
            )
            continue

        # Admin-targeted proposals always flag, no budget consumed.
        if proposal.target == "admin":
            _create_admin_flag(proposal)
            continue

        # User-targeted: apply filters in order.
        if not proposal.target_user_id:
            _create_admin_flag(
                proposal, override_reason="Proposal target=user but no target_user_id"
            )
            continue

        user = users_repo.get_by_id(proposal.target_user_id)
        if user is None:
            continue

        # Filter 1: active PAUSE / agent_nudge mute → drop entirely.
        # NOTE: mutes_repo.is_muted only covers ACTIVITY/FARM/OPPORTUNITY/
        # WINDOW dimensions; AGENT_NUDGE has its own walker because PAUSE is
        # specifically about review-tick nudges, not the user's opt-out from a
        # specific farm/activity.
        if _is_agent_nudge_muted(user.id or "", now=now):
            _create_admin_flag(
                proposal,
                override_reason=f"Skipped: user {user.name} has PAUSE mute active",
            )
            continue

        # Filter 2: per-user 48h budget.
        if not users_repo.is_within_agent_nudge_budget(
            user.id or "", now=now, window_hours=per_user_budget_hours,
        ):
            _create_admin_flag(
                proposal,
                override_reason=f"Skipped: user {user.name} over 48h nudge budget",
            )
            continue

        # Filter 3: per-opp cap.
        if proposal.target_opp_id:
            opp = opportunities_repo.get_by_id(proposal.target_opp_id)
            if opp is None or opp.agent_nudges_sent >= per_opp_max:
                _create_admin_flag(
                    proposal,
                    override_reason=(
                        f"Skipped: opp {proposal.target_opp_id} at "
                        f"{opp.agent_nudges_sent if opp else '?'}/{per_opp_max} nudges"
                    ),
                )
                continue

        # Filter 4: per-tick global ceiling.
        if sent_count >= per_tick_budget:
            _create_admin_flag(
                proposal,
                override_reason="Skipped: per-tick send budget reached",
            )
            continue

        # All filters passed — send.
        sent = _send_review_proposal(proposal=proposal, user=user, messaging=messaging)
        if sent:
            sent_count += 1
            # Update budget bookkeeping ONLY after a successful send.
            users_repo.set_last_agent_initiated_outbound_at(user.id or "", at=now)
            if proposal.target_opp_id:
                opportunities_repo.increment_agent_nudges_sent(proposal.target_opp_id)


def _is_agent_nudge_muted(user_id: str, *, now: datetime) -> bool:
    """Walk mute rules for the user; return True if an unexpired
    AGENT_NUDGE mute exists. Used by review-tick filtering, NOT by inbound
    dispatch (inbound replies are always allowed)."""
    if not user_id:
        return False
    for rule in mutes_repo.list_for_user(user_id):
        if rule.dimension != MuteDimension.AGENT_NUDGE:
            continue
        if rule.expires_at is not None and rule.expires_at < now:
            continue
        return True
    return False


def _create_admin_flag(
    proposal: ReviewProposal,
    *,
    override_reason: str | None = None,
) -> None:
    reason_parts = [f"Review proposal ({proposal.priority}): {proposal.reason}"]
    if override_reason:
        reason_parts.append(override_reason)
    if proposal.target_opp_id:
        reason_parts.append(f"opp_id={proposal.target_opp_id}")
    if proposal.target_user_id:
        reason_parts.append(f"user_id={proposal.target_user_id}")
    flags_repo.create(
        FlagDoc(
            message_id=None,
            flagged_by_user_id=None,  # raised by the agent
            reason=" | ".join(reason_parts),
            created_at=datetime.now(UTC),
        )
    )


def _send_review_proposal(
    *,
    proposal: ReviewProposal,
    user,
    messaging,
) -> bool:
    """Send a user-facing review-initiated message. Returns True on success."""
    body = proposal.reply_text or ""
    if not body:
        # Agent forgot to write the body. Flag and skip.
        _create_admin_flag(
            proposal, override_reason="Proposal had empty reply_text",
        )
        return False

    provider_id = safe_send(messaging, to_phone=user.phone, body=body)
    if provider_id is None:
        return False

    # If the proposal includes an action + token, this is a PENDING_CONFIRMATION.
    # Otherwise it's a plain AGENT_NUDGE (informational, no state change pending).
    if proposal.action:
        from app.flows.message_dispatch import _token_for_action, _extract_action_payload
        # Token is derived deterministically from the action (see
        # message_dispatch._token_for_action) — never taken from the model.
        token = _token_for_action(proposal.action.name)
        from app.agent.unified import AgentOutput
        wrapped = AgentOutput(
            mode="confirm", reply_text=body,
            confirmation_token=token, action=proposal.action,
        )
        pending_payload = {
            "action": proposal.action.name,
            "token": token,
            "payload": _extract_action_payload(wrapped),
            "expires_at": (datetime.now(UTC) + timedelta(minutes=30)).isoformat(),
        }
        intent = IntentLabel.PENDING_CONFIRMATION
    else:
        pending_payload = None
        intent = IntentLabel.AGENT_NUDGE

    messages_repo.create(
        MessageDoc(
            direction=MessageDirection.OUTBOUND,
            provider_msg_id=provider_id,
            user_id=user.id,
            opportunity_id=proposal.target_opp_id,
            body=body,
            intent_label=intent,
            pending_action=pending_payload,
            created_at=datetime.now(UTC),
        )
    )
    return True
