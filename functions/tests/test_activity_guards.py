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
    _inbound_has_time_signal,
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
    # Signal 4 is gated on a prior *time* clarify. Isolate it from signal 6 by
    # giving a draft whose 9am was legitimately stated earlier ("9am" in the
    # recent inbounds), so signal 6 is satisfied and only signal 4's gating is
    # under test here.
    out = _draft_update_output(starts_at="2026-06-05T09:00:00-07:00")
    earlier = ("anytime", "post a harvest sunday 9am")
    # No clarify context at all: an affirmative-ish word is the farmer's
    # business, not an over-confirm, when the time was already given.
    assert _agent_overconfirm_reason(
        output=out, inbound_text="anytime", last_outbound=None,
        recent_inbound_texts=earlier,
    ) is None
    # Prior clarify was about a DIFFERENT axis (headcount), not time.
    headcount_clarify = MessageDoc(
        direction=MessageDirection.OUTBOUND, provider_msg_id="m2",
        body="How many people?", intent_label=IntentLabel.CLARIFY,
        clarify_axis="headcount", created_at=datetime.now(UTC),
    )
    assert _agent_overconfirm_reason(
        output=out, inbound_text="anytime", last_outbound=headcount_clarify,
        recent_inbound_texts=earlier,
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


# --- backstop signal 6: draft finalized with a default-filled time ----------
def test_overconfirm_fires_on_draft_finalize_with_default_time():
    # Multi-turn: day clarified, farmer replies "Sun", NO time ever stated.
    # The model fills starts_at=9am from the farm default and confirms — must
    # downgrade to clarify. (The screenshot bug.)
    out = _draft_update_output(starts_at="2026-06-08T09:00:00-07:00")
    reason = _agent_overconfirm_reason(
        output=out,
        inbound_text="Sun",
        recent_inbound_texts=(
            "Sun",
            "need a couple people to pick surpluss tomatoes on sunday",
        ),
    )
    assert reason is not None and "default-filled on draft finalize" in reason


def test_signal6_accepts_bare_number_time_after_time_clarify():
    # The screenshot bug: "10 for a couple hours" answering a "what time?"
    # clarify. The bare "10" IS the time (the prior question disambiguates it),
    # so signal 6 must NOT fire and the draft confirms.
    out = _draft_update_output(starts_at="2026-06-07T10:00:00-07:00")
    reason = _agent_overconfirm_reason(
        output=out,
        inbound_text="10 for a couple hours",
        last_outbound=_time_clarify_outbound(),
        recent_inbound_texts=("10 for a couple hours", "sat is better"),
    )
    assert reason is None


def test_signal6_bare_number_only_counts_after_a_TIME_clarify():
    # A bare number answering a DATE clarify must NOT be read as a time — the
    # gating is on prior_axis == "time". Here no time was ever stated, so signal
    # 6 still fires (the 9am is default-filled).
    out = _draft_update_output(starts_at="2026-06-08T09:00:00-07:00")
    date_clarify = MessageDoc(
        direction=MessageDirection.OUTBOUND, provider_msg_id="m3",
        body="Which day?", intent_label=IntentLabel.CLARIFY,
        clarify_axis="date", created_at=datetime.now(UTC),
    )
    reason = _agent_overconfirm_reason(
        output=out, inbound_text="sun", last_outbound=date_clarify,
        recent_inbound_texts=("sun", "need help sunday"),
    )
    assert reason is not None and "default-filled on draft finalize" in reason


def test_bare_number_time_detector_bounds():
    from app.flows.message_dispatch import _inbound_answers_time_with_bare_number as bn
    assert bn("10 for a couple hours")
    assert bn("10")
    assert bn("9 thanks")
    assert not bn("sat is better")
    assert not bn("tomatoes")
    assert not bn("25 people")  # 25 > 23, not a valid hour
    assert not bn("30")


def test_signal6_does_not_fire_when_time_given_on_an_earlier_turn():
    # Farmer DID give "8am" on turn 1; a later turn answered headcount. The
    # draft carries the real time forward — must NOT fire (anti-phone-tree).
    out = _draft_update_output(starts_at="2026-06-08T08:00:00-07:00")
    reason = _agent_overconfirm_reason(
        output=out,
        inbound_text="2",
        recent_inbound_texts=("2", "need people sunday 8am to pick tomatoes"),
    )
    assert reason is None


def test_signal6_does_not_fire_for_a_midnight_date_placeholder():
    # starts_at at midnight is a date-only placeholder, not a clock time — the
    # time axis is still genuinely open, so signal 6 (which is about a FABRICATED
    # clock time) must not fire; the normal missing-axis path handles it.
    out = _draft_update_output(starts_at="2026-06-08T00:00:00-07:00")
    reason = _agent_overconfirm_reason(
        output=out, inbound_text="Sun", recent_inbound_texts=("Sun",)
    )
    assert reason is None


# --- signals 4 & 5 are routine refinement, not admin-worthy ----------------
def test_signals_4_and_5_not_flagged_for_admin():
    assert not _is_admin_worth_flagging(
        "inbound is a vague non-bucket time word after a time CLARIFY ..."
    )
    assert not _is_admin_worth_flagging(
        "record_offer names a crop with no time window — below the offer floor ..."
    )


def test_signal6_is_flagged_for_admin():
    # Signal 6 IS worth flagging — the model fabricated a required value.
    assert _is_admin_worth_flagging(
        "parsed.starts_at has a clock time ... (default-filled on draft finalize); "
        "re-ask the time"
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


# --- _inbound_has_time_signal unit (bare-hour context) ----------------------
def test_time_signal_recognizes_bare_hour_in_context():
    # The "around 10 for a couple hours" miss that made signal 6 misfire on a
    # valid time answer (then the clarify cap turned it into silent escalation).
    assert _inbound_has_time_signal("around 10 for a couple hours")
    assert _inbound_has_time_signal("at 9")
    assert _inbound_has_time_signal("about 7")
    assert _inbound_has_time_signal("start around 6")
    assert _inbound_has_time_signal("10ish")
    assert _inbound_has_time_signal("9 o'clock")
    # Explicit clock times still match.
    assert _inbound_has_time_signal("9am")
    assert _inbound_has_time_signal("noon")
    assert _inbound_has_time_signal("morning")


def test_time_signal_does_not_match_headcount_or_duration():
    # A bare number that is a headcount/duration/date is NOT a time.
    assert not _inbound_has_time_signal("need 2 people")
    assert not _inbound_has_time_signal("for a couple hours")
    assert not _inbound_has_time_signal("for 3 hours")
    assert not _inbound_has_time_signal("the 5th")
    assert not _inbound_has_time_signal("about 2 people")
    assert not _inbound_has_time_signal("by 3 volunteers")
    assert not _inbound_has_time_signal("around 5 ppl")


# --- offer normalization ----------------------------------------------------
def test_vague_openness_normalizes_to_empty():
    assert _normalize_offer_activity_detail("Physical work") == ""
    assert _normalize_offer_activity_detail("anything") == ""
    assert _normalize_offer_activity_detail("happy to help out") == ""


def test_concrete_task_is_kept():
    assert _normalize_offer_activity_detail("Tilling") == "Tilling"
    assert _normalize_offer_activity_detail("Gleaning") == "Gleaning"
    assert _normalize_offer_activity_detail("") == ""
