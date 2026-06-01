"""Deterministic guards added by the activity-model redesign (2026-05-31).

Two product decisions are enforced in code (not just the prompt, which a small
model follows unreliably):

1. A bare crop name is still not an activity — the over-confirm backstop
   downgrades a `create_opportunity` confirm to clarify when the inbound names a
   crop and no work word.
2. Vague-openness offer phrasing ("physical work", "anything") normalizes to an
   empty activity_detail so the matcher treats the volunteer as flexible.
"""

from __future__ import annotations

from datetime import UTC, datetime

from app.flows.message_dispatch import (
    _agent_overconfirm_reason,
    _inbound_has_crop_word,
    _inbound_has_work_word,
    _inbound_is_vague_time,
    _is_admin_worth_flagging,
    _normalize_offer_activity_detail,
)
from app.agent.unified import (
    ActionSpec,
    AgentOutput,
    CreateOpportunityPayload,
    RecordOfferPayload,
    UpdateDraftOpportunityPayload,
)
from app.agent.parser import ParsedOpportunity
from app.repos.models import IntentLabel, MessageDirection, MessageDoc


def _create_output(activity_detail: str) -> AgentOutput:
    return AgentOutput(
        mode="confirm",
        action=ActionSpec(
            name="create_opportunity",
            create_opportunity=CreateOpportunityPayload(
                parsed=ParsedOpportunity(
                    kind="shift",
                    starts_at="2026-06-05T09:00:00-07:00",
                    headcount_needed=2,
                    activity_detail=activity_detail,
                )
            ),
        ),
    )


# --- crop-word / work-word helpers -----------------------------------------
def test_crop_word_detected():
    assert _inbound_has_crop_word("need 2 for the tomatoes friday 9am")
    assert _inbound_has_crop_word("grapes need picking")  # grapes added per feedback
    assert not _inbound_has_crop_word("need 2 people friday 9am")


def test_work_word_exempts_mushroom_foraging():
    # "foraging" is a work word — mushroom foraging is a real activity, not a
    # crop-only inference, so it must NOT be treated as crop-only.
    assert _inbound_has_work_word("mushroom foraging saturday")


# --- backstop: crop-only inference downgrades confirm -----------------------
def test_overconfirm_fires_on_crop_only_activity():
    out = _create_output("Harvest tomatoes")
    reason = _agent_overconfirm_reason(
        output=out, inbound_text="need tomatoes two people Friday 9am"
    )
    assert reason is not None and "crop" in reason.lower()


def test_overconfirm_does_not_fire_when_work_word_present():
    out = _create_output("Mushroom Foraging")
    reason = _agent_overconfirm_reason(
        output=out, inbound_text="need 2 people Saturday 10am for mushroom foraging, 2 hours"
    )
    assert reason is None


def test_overconfirm_does_not_fire_without_crop():
    out = _create_output("Weeding")
    reason = _agent_overconfirm_reason(
        output=out, inbound_text="need 2 for weeding friday 9am"
    )
    assert reason is None


# --- helpers for signals 4 & 5 ---------------------------------------------
def _time_clarify_outbound() -> MessageDoc:
    """An outbound CLARIFY about the time axis, as the last outbound."""
    return MessageDoc(
        direction=MessageDirection.OUTBOUND,
        provider_msg_id="m1",
        body="What time should we start?",
        intent_label=IntentLabel.CLARIFY,
        clarify_axis="time",
        created_at=datetime.now(UTC),
    )


def _draft_update_output(starts_at: str | None) -> AgentOutput:
    return AgentOutput(
        mode="confirm",
        action=ActionSpec(
            name="update_draft_opportunity",
            update_draft_opportunity=UpdateDraftOpportunityPayload(
                opp_id="o_draft",
                parsed=ParsedOpportunity(
                    kind="shift",
                    starts_at=starts_at,
                    headcount_needed=2,
                    activity_detail="Harvest",
                ),
            ),
        ),
    )


def _offer_output(activity_detail: str) -> AgentOutput:
    return AgentOutput(
        mode="confirm",
        action=ActionSpec(
            name="record_offer",
            record_offer=RecordOfferPayload(activity_detail=activity_detail),
        ),
    )


# --- backstop signal 4: vague time after a "what time?" clarify -------------
def test_overconfirm_fires_on_anytime_after_time_clarify():
    # Draft already exists; farmer answers a time clarify with "anytime" —
    # not a valid bucket. Must downgrade to clarify, not confirm a draft update.
    out = _draft_update_output(starts_at="2026-06-05T09:00:00-07:00")
    reason = _agent_overconfirm_reason(
        output=out, inbound_text="anytime", last_outbound=_time_clarify_outbound()
    )
    assert reason is not None and "vague non-bucket time word" in reason


def test_overconfirm_signal4_variants():
    out = _draft_update_output(starts_at="2026-06-05T09:00:00-07:00")
    clarify = _time_clarify_outbound()
    for txt in ("whenever", "no preference", "flexible", "up to you", "Anytime!"):
        reason = _agent_overconfirm_reason(
            output=out, inbound_text=txt, last_outbound=clarify
        )
        assert reason is not None, f"{txt!r} should fire signal 4"


def test_overconfirm_fires_on_bare_yes_after_time_clarify():
    # A bare "yes" answers nothing after "what time?" — the model must not
    # invent a clock time from a default. Signal 4 shape (b).
    out = _draft_update_output(starts_at="2026-06-05T09:00:00-07:00")
    reason = _agent_overconfirm_reason(
        output=out, inbound_text="yes", last_outbound=_time_clarify_outbound()
    )
    assert reason is not None and "vague non-bucket time word" in reason


def test_signal4_does_not_fire_for_a_real_bucket():
    # "morning" IS a valid bucket — the farmer answered the question. Must pass.
    out = _draft_update_output(starts_at="2026-06-05T08:00:00-07:00")
    reason = _agent_overconfirm_reason(
        output=out, inbound_text="morning is fine", last_outbound=_time_clarify_outbound()
    )
    assert reason is None


def test_signal4_does_not_fire_for_a_clock_time():
    out = _draft_update_output(starts_at="2026-06-05T09:00:00-07:00")
    reason = _agent_overconfirm_reason(
        output=out, inbound_text="9am works", last_outbound=_time_clarify_outbound()
    )
    assert reason is None


def test_signal4_does_not_fire_without_a_prior_time_clarify():
    # No clarify context: "anytime" in a fresh draft update is the farmer's
    # business, not an over-confirm. We only police it right after we asked.
    out = _draft_update_output(starts_at="2026-06-05T09:00:00-07:00")
    assert _agent_overconfirm_reason(output=out, inbound_text="anytime", last_outbound=None) is None
    # Prior clarify was about a DIFFERENT axis (headcount), not time.
    headcount_clarify = MessageDoc(
        direction=MessageDirection.OUTBOUND, provider_msg_id="m2",
        body="How many people?", intent_label=IntentLabel.CLARIFY,
        clarify_axis="headcount", created_at=datetime.now(UTC),
    )
    assert _agent_overconfirm_reason(
        output=out, inbound_text="anytime", last_outbound=headcount_clarify
    ) is None


# --- backstop signal 5: crop-only offer below the floor --------------------
def test_overconfirm_fires_on_crop_only_offer():
    out = _offer_output("Harvest tomatoes")
    reason = _agent_overconfirm_reason(
        output=out, inbound_text="help with tomatoes this week"
    )
    assert reason is not None and "below the offer" in reason


def test_signal5_does_not_fire_on_offer_with_time_window():
    # The valid-offer eval case: has a time signal ("morning"), so it passes.
    out = _offer_output("")
    reason = _agent_overconfirm_reason(
        output=out,
        inbound_text="i'd love to get in some physical work this weekend, some morning",
    )
    assert reason is None


def test_signal5_does_not_fire_on_offer_without_crop():
    out = _offer_output("Tilling")
    reason = _agent_overconfirm_reason(
        output=out, inbound_text="happy to help with tilling sometime"
    )
    assert reason is None


def test_signal5_does_not_fire_for_a_named_farm():
    # A directed offer ("can I help at Plum Forest this week?") clears the
    # offer floor via the farm name — must NOT downgrade. Also guards the
    # false positive where the farm NAME contains a crop word ("plum").
    out = _offer_output("")
    reason = _agent_overconfirm_reason(
        output=out,
        inbound_text="can I help at Plum Forest this week?",
        known_farm_names=("Plum Forest", "Three Cedars"),
    )
    assert reason is None
    # Without the farm in the known set, the bare "plum" trips the crop scan —
    # confirms the guard (not some other reason) is what protects the case.
    assert _agent_overconfirm_reason(
        output=out, inbound_text="can I help at Plum Forest this week?",
        known_farm_names=(),
    ) is not None


# --- signals 4 & 5 are routine refinement, not admin-worthy ----------------
def test_signals_4_and_5_not_flagged_for_admin():
    assert not _is_admin_worth_flagging(
        "inbound is a vague non-bucket time word after a time CLARIFY ..."
    )
    assert not _is_admin_worth_flagging(
        "record_offer names a crop with no time window — below the offer floor ..."
    )


# --- _inbound_is_vague_time unit ------------------------------------------
def test_inbound_is_vague_time():
    assert _inbound_is_vague_time("anytime")
    assert _inbound_is_vague_time("whenever works")
    assert _inbound_is_vague_time("flexible")
    # Real time signals are NOT vague.
    assert not _inbound_is_vague_time("morning")
    assert not _inbound_is_vague_time("9am")
    assert not _inbound_is_vague_time("afternoon is best")


# --- offer normalization ----------------------------------------------------
def test_vague_openness_normalizes_to_empty():
    assert _normalize_offer_activity_detail("Physical work") == ""
    assert _normalize_offer_activity_detail("anything") == ""
    assert _normalize_offer_activity_detail("happy to help out") == ""


def test_concrete_task_is_kept():
    assert _normalize_offer_activity_detail("Tilling") == "Tilling"
    assert _normalize_offer_activity_detail("Gleaning") == "Gleaning"
    assert _normalize_offer_activity_detail("") == ""
