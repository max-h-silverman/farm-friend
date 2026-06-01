"""Pre-confirm guard: an edit_opportunity that would drop headcount below the
seats already confirmed is refused BEFORE the farmer is asked to confirm,
rather than after they reply YES (the old executor-time behavior).
"""

from __future__ import annotations

from datetime import UTC, datetime
from unittest.mock import patch

from app.agent.unified import ActionSpec, AgentOutput, EditOpportunityPayload
from app.flows.message_dispatch import _edit_headcount_block_reply
from app.repos.models import OpportunityDoc, OpportunityKind, OpportunityStatus


def _edit_output(opp_id: str, new_headcount: int) -> AgentOutput:
    return AgentOutput(
        mode="confirm",
        reply_text="Update headcount? Reply YES.",
        confirmation_token="YES",
        action=ActionSpec(
            name="edit_opportunity",
            edit_opportunity=EditOpportunityPayload(
                opp_id=opp_id, field_updates={"headcount_needed": new_headcount}
            ),
        ),
    )


def _opp(seats_filled: int) -> OpportunityDoc:
    return OpportunityDoc(
        id="o1",
        farm_id="f1",
        kind=OpportunityKind.SHIFT,
        status=OpportunityStatus.FILLING,
        headcount_needed=3,
        seats_filled=seats_filled,
        created_at=datetime.now(UTC),
    )


def test_blocks_headcount_below_seats_filled() -> None:
    with patch(
        "app.flows.message_dispatch.opportunities_repo.get_by_id",
        return_value=_opp(seats_filled=2),
    ):
        reply = _edit_headcount_block_reply(_edit_output("o1", new_headcount=1))
    assert reply is not None
    assert "2 already confirmed" in reply


def test_allows_headcount_at_or_above_seats_filled() -> None:
    with patch(
        "app.flows.message_dispatch.opportunities_repo.get_by_id",
        return_value=_opp(seats_filled=2),
    ):
        assert _edit_headcount_block_reply(_edit_output("o1", new_headcount=2)) is None
        assert _edit_headcount_block_reply(_edit_output("o1", new_headcount=4)) is None


def test_ignores_non_headcount_edits() -> None:
    output = AgentOutput(
        mode="confirm",
        reply_text="Move to Saturday? Reply YES.",
        confirmation_token="YES",
        action=ActionSpec(
            name="edit_opportunity",
            edit_opportunity=EditOpportunityPayload(
                opp_id="o1", field_updates={"starts_at": "2026-06-06T16:00:00+00:00"}
            ),
        ),
    )
    # No opp lookup needed when no headcount change — returns None fast.
    assert _edit_headcount_block_reply(output) is None


def test_ignores_non_edit_actions() -> None:
    from app.agent.unified import CancelOpportunityPayload

    output = AgentOutput(
        mode="confirm",
        reply_text="Cancel? Reply YES.",
        confirmation_token="YES",
        action=ActionSpec(
            name="cancel_opportunity",
            cancel_opportunity=CancelOpportunityPayload(opp_id="o1"),
        ),
    )
    assert _edit_headcount_block_reply(output) is None
