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

from app.flows.message_dispatch import (
    _agent_overconfirm_reason,
    _inbound_has_crop_word,
    _inbound_has_work_word,
    _normalize_offer_activity_detail,
)
from app.agent.unified import ActionSpec, AgentOutput, CreateOpportunityPayload
from app.agent.parser import ParsedOpportunity


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


# --- offer normalization ----------------------------------------------------
def test_vague_openness_normalizes_to_empty():
    assert _normalize_offer_activity_detail("Physical work") == ""
    assert _normalize_offer_activity_detail("anything") == ""
    assert _normalize_offer_activity_detail("happy to help out") == ""


def test_concrete_task_is_kept():
    assert _normalize_offer_activity_detail("Tilling") == "Tilling"
    assert _normalize_offer_activity_detail("Gleaning") == "Gleaning"
    assert _normalize_offer_activity_detail("") == ""
