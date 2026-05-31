"""The pilot-safety admin-only gate on the proactive review tick.

When `agent_review_admin_only` is set (the pilot default), the review tick must
never autonomously SMS a user — every proposal, even a high-priority
state-changing one, lands on the admin worklist instead.
"""

from __future__ import annotations

from unittest.mock import patch

from app.agent.unified import ReviewProposal
from app.flows import board_review


def _user_proposal() -> ReviewProposal:
    return ReviewProposal(
        priority="high",
        target="user",
        target_user_id="u_farmer_a",
        target_opp_id="o_fri_harvest",
        reason="underfilled shift T-24h",
        action=None,
        confirmation_token=None,
        reply_text="Farm Friend Vashon: Friday harvest at 1/3.",
    )


def test_admin_only_routes_user_proposal_to_flag_not_sms() -> None:
    provider_sends: list = []
    with (
        patch("app.flows.board_review._create_admin_flag") as flag,
        patch(
            "app.flows.board_review._send_review_proposal",
            side_effect=lambda **kw: provider_sends.append(kw) or True,
        ) as send,
        patch("app.flows.board_review.users_repo.get_by_id"),
    ):
        board_review._route_review_proposals(
            proposals=[_user_proposal()],
            per_tick_budget=3,
            per_user_budget_hours=48,
            per_opp_max=2,
            messaging=object(),
            admin_only=True,
        )
    assert flag.called
    assert not send.called
    assert provider_sends == []


def test_user_facing_mode_still_sends_when_admin_only_disabled() -> None:
    with (
        patch("app.flows.board_review._create_admin_flag"),
        patch("app.flows.board_review._send_review_proposal", return_value=True) as send,
        patch("app.flows.board_review.users_repo.get_by_id", return_value=_FakeUser()),
        patch(
            "app.flows.board_review._is_agent_nudge_muted", return_value=False
        ),
        patch(
            "app.flows.board_review.users_repo.is_within_agent_nudge_budget",
            return_value=True,
        ),
        patch(
            "app.flows.board_review.opportunities_repo.get_by_id",
            return_value=_FakeOpp(),
        ),
        patch("app.flows.board_review.users_repo.set_last_agent_initiated_outbound_at"),
        patch("app.flows.board_review.opportunities_repo.increment_agent_nudges_sent"),
    ):
        board_review._route_review_proposals(
            proposals=[_user_proposal()],
            per_tick_budget=3,
            per_user_budget_hours=48,
            per_opp_max=2,
            messaging=object(),
            admin_only=False,
        )
    assert send.called


class _FakeUser:
    id = "u_farmer_a"
    name = "Maya"
    phone = "+15550100001"


class _FakeOpp:
    id = "o_fri_harvest"
    agent_nudges_sent = 0
