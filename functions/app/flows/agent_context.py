"""Agent-context assembly for inbound dispatch.

The dispatcher owns routing and side effects. This module owns the read-model
payload sent to the unified agent.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from app.agent.unified import AgentContext, ClaimSummary, MessageExcerpt, OppSummary
from app.flows import farmer_ops
from app.flows._time import VASHON_TZ
from app.repos import farms_repo, messages_repo, mutes_repo, opportunities_repo
from app.repos.models import (
    CANONICAL_ACTIVITIES,
    ClaimStatus,
    MessageDoc,
    MessageDirection,
    OpportunityDoc,
    OpportunityKind,
    OpportunityStatus,
    UserDoc,
    UserRole,
)


def farm_defaults_dict(farm) -> dict | None:
    if farm is None:
        return None
    return {
        "typical_start_hour": farm.typical_start_hour,
        "typical_shift_duration_min": farm.typical_shift_duration_min,
        "usual_days_of_week": farm.usual_days_of_week,
    }


def build_agent_context(
    *,
    sender: UserDoc,
    last_outbound: MessageDoc | None,
    target_opp: OpportunityDoc | None,
    pending_action: dict | None,
    executed_action: dict | None,
) -> AgentContext:
    """Assemble the AgentContext payload the unified agent sees.

    Includes sender state, recent excerpts, live pending/executed actions,
    sender claims, farmer-owned open opps, and cross-cutting open opps.
    """
    now_local = datetime.now(VASHON_TZ)

    sender_claims = _sender_claims(sender)

    sender_farm_id: str | None = None
    sender_farm_name: str | None = None
    sender_farm_defaults: dict | None = None
    sender_farm_open_opps: list[OppSummary] = []
    if sender.id and sender.role in (UserRole.FARMER, UserRole.BOTH):
        farm = farms_repo.get_by_owner(sender.id)
        if farm and farm.id:
            sender_farm_id = farm.id
            sender_farm_name = farm.name
            sender_farm_defaults = farm_defaults_dict(farm)
            for opp in opportunities_repo.list_open_for_farm(farm.id):
                sender_farm_open_opps.append(_opp_summary_from(opp=opp, farm=farm))

    cross_cutting: list[OppSummary] = []
    all_farms = {f.id: f for f in farms_repo.list_all() if f.id}
    for farm_id, farm in all_farms.items():
        if farm_id == sender_farm_id:
            continue
        for opp in opportunities_repo.list_open_for_farm(farm_id):
            cross_cutting.append(_opp_summary_from(opp=opp, farm=farm))

    last_outbound_opp_summary: OppSummary | None = None
    if last_outbound is not None and target_opp:
        farm = farms_repo.get_by_id(target_opp.farm_id)
        last_outbound_opp_summary = _opp_summary_from(opp=target_opp, farm=farm)

    return AgentContext(
        now_local_iso=now_local.isoformat(),
        sender_role=sender.role.value,
        sender_name=sender.name,
        sender_phone=sender.phone,
        sender_availability={
            "available_days": sender.available_days,
            "available_start_hour": sender.available_start_hour,
            "available_end_hour": sender.available_end_hour,
            "max_commit_hours_per_week": sender.max_commit_hours_per_week,
        },
        sender_activity_preferences=sender.activity_preferences,
        sender_mute_summary=_mute_summary(sender),
        sender_open_claims=sender_claims,
        sender_farm_id=sender_farm_id,
        sender_farm_name=sender_farm_name,
        sender_farm_defaults=sender_farm_defaults,
        sender_farm_open_opps=sender_farm_open_opps,
        last_outbound_body=last_outbound.body if last_outbound else None,
        last_outbound_intent=(
            last_outbound.intent_label.value if last_outbound and last_outbound.intent_label else None
        ),
        last_outbound_clarification_round=(
            last_outbound.clarification_round if last_outbound else 0
        ),
        last_outbound_opp_summary=last_outbound_opp_summary,
        pending_action=pending_action,
        executed_action=executed_action,
        cross_cutting_opps=cross_cutting,
        known_farms=[{"id": fid, "name": f.name} for fid, f in all_farms.items()],
        canonical_activities=list(CANONICAL_ACTIVITIES),
        opp_message_excerpt=_opp_excerpt(target_opp),
        user_recent_excerpt=_user_excerpt(sender),
    )


def _sender_claims(sender: UserDoc) -> list[ClaimSummary]:
    claims: list[ClaimSummary] = []
    if not sender.id:
        return claims

    recent_msgs = messages_repo.list_for_user(sender.id, limit=50)
    seen_opp_ids: set[str] = set()
    for msg in recent_msgs:
        if not msg.opportunity_id or msg.opportunity_id in seen_opp_ids:
            continue
        seen_opp_ids.add(msg.opportunity_id)
        claim = opportunities_repo.get_claim(
            opp_id=msg.opportunity_id,
            volunteer_user_id=sender.id,
        )
        if claim is None or claim.status == ClaimStatus.DROPPED:
            continue
        opp = opportunities_repo.get_by_id(msg.opportunity_id)
        if opp is None or opp.status in (
            OpportunityStatus.COMPLETED,
            OpportunityStatus.CANCELLED,
            OpportunityStatus.EXPIRED,
        ):
            continue
        farm = farms_repo.get_by_id(opp.farm_id)
        claims.append(_claim_summary_from(opp=opp, claim=claim, farm=farm))
    return claims


def _mute_summary(sender: UserDoc) -> list[str]:
    if not sender.id:
        return []
    return [
        f"{rule.dimension.value}:{rule.value}"
        for rule in mutes_repo.list_for_user(sender.id)
    ]


def _opp_excerpt(target_opp: OpportunityDoc | None) -> list[MessageExcerpt]:
    if target_opp is None or not target_opp.id:
        return []
    return [
        _excerpt_from(msg)
        for msg in messages_repo.list_for_opportunity(target_opp.id, limit=5)
    ]


def _user_excerpt(sender: UserDoc) -> list[MessageExcerpt]:
    if not sender.id:
        return []
    since = datetime.now(UTC) - timedelta(hours=24)
    return [
        _excerpt_from(msg)
        for msg in messages_repo.list_for_user_since(sender.id, since=since, hard_cap=20)
    ]


def _opp_summary_from(*, opp: OpportunityDoc, farm) -> OppSummary:
    activity_or_produce = (
        ", ".join(opp.activity_tags)
        if opp.kind == OpportunityKind.SHIFT
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


def _claim_summary_from(*, opp: OpportunityDoc, claim, farm) -> ClaimSummary:
    activity_or_produce = (
        ", ".join(opp.activity_tags)
        if opp.kind == OpportunityKind.SHIFT
        else (opp.produce_description or "surplus")
    )
    return ClaimSummary(
        opp_id=opp.id or "",
        opp_kind=opp.kind.value,
        farm_name=farm.name if farm else "unknown farm",
        activity_or_produce=activity_or_produce,
        when_human=farmer_ops.opp_short_summary(opp),
        status=claim.status.value,
    )


def _excerpt_from(msg: MessageDoc) -> MessageExcerpt:
    return MessageExcerpt(
        direction=msg.direction.value,
        body=msg.body[:200],
        intent_label=msg.intent_label.value if msg.intent_label else None,
        created_at_iso=msg.created_at.isoformat(),
    )
