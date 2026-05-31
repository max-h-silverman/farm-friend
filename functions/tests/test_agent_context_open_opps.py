"""Regression coverage for `build_agent_context` with open opportunities.

This locks two things that previously had zero coverage:

1. `_opp_summary_from` actually returns an `OppSummary`. A 2026-05 edit
   accidentally orphaned its `return` statement (the draft helpers got pasted
   inside its body), so it silently returned `None` for every opportunity.
   `build_agent_context` then tried to put `None` into `list[OppSummary]`, which
   raised a ValidationError *outside* dispatch's try/except — every inbound from
   a user while any open opp existed crashed the webhook with no reply. The unit
   suite stayed green because nothing exercised this path. This test does.

2. The sender's phone number never reaches the AgentContext (data minimization —
   see CLAUDE.md "Project Constitution: ... Data dignity"). The agent coordinates
   by name and opaque IDs only.
"""

from __future__ import annotations

from datetime import UTC, datetime

import pytest

from app.flows import agent_context as ctx_mod
from app.flows.agent_context import build_agent_context
from app.agent.unified import OppSummary
from app.repos.models import (
    FarmDoc,
    OpportunityDoc,
    OpportunityKind,
    OpportunityStatus,
    UserDoc,
    UserRole,
    UserStatus,
)


_NOW = datetime(2026, 5, 31, 12, 0, tzinfo=UTC)


def _farmer() -> UserDoc:
    return UserDoc(
        id="farmer1",
        phone="+12065550111",
        name="Dana",
        role=UserRole.FARMER,
        status=UserStatus.ACTIVE,
        created_at=_NOW,
    )


def _farm() -> FarmDoc:
    return FarmDoc(id="farm1", name="Plum Forest", owner_user_id="farmer1", created_at=_NOW)


def _open_shift(farm_id: str, opp_id: str) -> OpportunityDoc:
    return OpportunityDoc(
        id=opp_id,
        farm_id=farm_id,
        kind=OpportunityKind.SHIFT,
        status=OpportunityStatus.OPEN,
        starts_at=datetime(2026, 6, 1, 9, 0, tzinfo=UTC),
        duration_min=180,
        headcount_needed=3,
        seats_filled=1,
        activity_tags=["weeding"],
        requirements_text="bring gloves",
        created_at=_NOW,
    )


@pytest.fixture
def _stub_repos(monkeypatch):
    """Stub the repo layer so build_agent_context runs without Firestore."""
    farm = _farm()
    own_opp = _open_shift("farm1", "opp_own")
    other_farm = FarmDoc(id="farm2", name="Misty Isle", owner_user_id="farmer2", created_at=_NOW)
    other_opp = _open_shift("farm2", "opp_other")

    monkeypatch.setattr(ctx_mod.farms_repo, "get_by_owner", lambda uid: farm)
    monkeypatch.setattr(
        ctx_mod.farms_repo, "get_by_id",
        lambda fid: {"farm1": farm, "farm2": other_farm}.get(fid),
    )
    monkeypatch.setattr(ctx_mod.farms_repo, "list_all", lambda: [farm, other_farm])
    monkeypatch.setattr(
        ctx_mod.opportunities_repo, "list_open_for_farm",
        lambda fid: {"farm1": [own_opp], "farm2": [other_opp]}.get(fid, []),
    )
    monkeypatch.setattr(ctx_mod.messages_repo, "list_for_user", lambda uid, limit=50: [])
    monkeypatch.setattr(
        ctx_mod.messages_repo, "list_for_user_since", lambda uid, since, hard_cap=20: []
    )
    monkeypatch.setattr(ctx_mod.messages_repo, "list_for_opportunity", lambda oid, limit=5: [])
    monkeypatch.setattr(ctx_mod.mutes_repo, "list_for_user", lambda uid: [])


def test_build_context_with_open_opps_returns_real_summaries(_stub_repos) -> None:
    """Previously raised ValidationError because _opp_summary_from returned None."""
    context = build_agent_context(
        sender=_farmer(),
        last_outbound=None,
        target_opp=None,
        pending_action=None,
        executed_action=None,
    )

    # Farmer's own open opp is summarized, not None.
    assert len(context.sender_farm_open_opps) == 1
    own = context.sender_farm_open_opps[0]
    assert isinstance(own, OppSummary)
    assert own.farm_name == "Plum Forest"
    assert own.activity_or_produce == "weeding"
    assert own.headcount_needed == 3
    assert own.seats_filled == 1

    # The other farm's open opp shows up as cross-cutting context.
    assert [o.opp_id for o in context.cross_cutting_opps] == ["opp_other"]
    assert all(isinstance(o, OppSummary) for o in context.cross_cutting_opps)


def test_sender_phone_never_enters_context(_stub_repos) -> None:
    """Data minimization: the phone number must not cross to the inference provider."""
    context = build_agent_context(
        sender=_farmer(),
        last_outbound=None,
        target_opp=None,
        pending_action=None,
        executed_action=None,
    )
    assert "+12065550111" not in context.model_dump_json()
    assert not hasattr(context, "sender_phone")
