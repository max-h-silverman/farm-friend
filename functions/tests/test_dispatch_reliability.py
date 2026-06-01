"""Dispatch-level reliability tests for the inbound SMS webhook.

These exercise the *whole* `_dispatch` flow (and the webhook backstop) with the
repo + LLM layers stubbed — no live Firestore, no live model. They lock the
reliability contract that the isolated `build_agent_context` tests cannot:

  - an inbound while an open opportunity exists builds context and replies;
  - a context-assembly failure degrades to flag+fallback, never an escape;
  - any other escaped exception in dispatch returns HTTP 200 (no 500 → no
    Telnyx retry storm), with the failure logged;
  - the sender's phone never reaches the AgentContext handed to the model.

Background: a committed bug once made `_opp_summary_from` return None, so every
inbound with an open opp raised a ValidationError in context assembly. That call
sat *outside* dispatch's try/except, so the webhook 500'd silently. These tests
would have caught it.
"""

from __future__ import annotations

from contextlib import contextmanager
from datetime import UTC, datetime
from unittest.mock import patch

from app.flows import message_dispatch
from app.agent.unified import AgentContext, AgentOutput
from app.messaging import InboundMessage
from app.messaging.fake_provider import FakeMessagingProvider
from app.repos.models import (
    FarmDoc,
    IntentLabel,
    MessageDoc,
    MessageDirection,
    OpportunityDoc,
    OpportunityKind,
    OpportunityStatus,
    UserDoc,
    UserRole,
    UserStatus,
)


_NOW = datetime(2026, 5, 31, 12, 0, tzinfo=UTC)
_PHONE = "+12065550111"


def _farmer() -> UserDoc:
    return UserDoc(
        id="farmer1", phone=_PHONE, name="Dana",
        role=UserRole.FARMER, status=UserStatus.ACTIVE, created_at=_NOW,
    )


def _farm() -> FarmDoc:
    return FarmDoc(id="farm1", name="Plum Forest", owner_user_id="farmer1", created_at=_NOW)


def _open_shift() -> OpportunityDoc:
    return OpportunityDoc(
        id="opp_own", farm_id="farm1", kind=OpportunityKind.SHIFT,
        status=OpportunityStatus.OPEN,
        starts_at=datetime(2026, 6, 1, 9, 0, tzinfo=UTC),
        duration_min=180, headcount_needed=3, seats_filled=1,
        activity_tags=["weeding"], requirements_text="bring gloves", created_at=_NOW,
    )


def _inbound(body: str = "how is the weeding shift filling up?") -> InboundMessage:
    return InboundMessage(
        from_phone=_PHONE, to_phone="+15555550100", body=body,
        provider_msg_id="pmsg-1", received_at=_NOW,
    )


@contextmanager
def _stubbed_dispatch(created_msgs, created_flags):
    """Patch every repo/LLM seam _dispatch touches so it runs offline.

    The reply path is left real (FakeMessagingProvider captures sends). Returns
    nothing; callers assert on the FakeMessagingProvider + the captured lists.
    """
    farmer = _farmer()
    farm = _farm()
    own_opp = _open_shift()

    def _create_msg(doc):
        return doc.model_copy(update={"id": f"m{len(created_msgs)}"}) if doc.id is None else doc

    with (
        patch.object(message_dispatch.messages_repo, "exists_by_provider_msg_id", return_value=False),
        patch.object(message_dispatch.users_repo, "get_by_phone", return_value=farmer),
        patch.object(message_dispatch.messages_repo, "latest_outbound_for_user", return_value=None),
        patch.object(
            message_dispatch.messages_repo, "create",
            side_effect=lambda doc: (created_msgs.append(doc) or _create_msg(doc)),
        ),
        patch.object(message_dispatch.flags_repo, "is_user_flagged", return_value=False),
        patch.object(
            message_dispatch.flags_repo, "create",
            side_effect=lambda doc: (created_flags.append(doc) or doc),
        ),
        # Context-assembly repo reads.
        patch.object(message_dispatch.farms_repo, "list_all", return_value=[farm]),
        patch.object(message_dispatch.farms_repo, "get_by_owner", return_value=farm),
        patch.object(message_dispatch.farms_repo, "get_by_id", return_value=farm),
        patch.object(message_dispatch.opportunities_repo, "list_open_for_farm", return_value=[own_opp]),
        patch.object(message_dispatch.opportunities_repo, "get_by_id", return_value=None),
        patch("app.flows.agent_context.messages_repo.list_for_user", return_value=[]),
        patch("app.flows.agent_context.messages_repo.list_for_user_since", return_value=[]),
        patch("app.flows.agent_context.messages_repo.list_for_opportunity", return_value=[]),
        patch("app.flows.agent_context.mutes_repo.list_for_user", return_value=[]),
        patch.object(message_dispatch, "get_llm_client", return_value=object()),
        patch.object(message_dispatch, "_record_agent_decision", return_value=None),
    ):
        yield


def test_open_opp_inbound_builds_context_and_replies() -> None:
    """An inbound while an open opp exists runs the agent and sends its reply."""
    provider = FakeMessagingProvider()
    created_msgs: list[MessageDoc] = []
    created_flags: list = []

    def _fake_agent(*, llm, context, inbound_text):
        return AgentOutput(mode="reply", reply_text="It has 1 of 3 seats filled.")

    with _stubbed_dispatch(created_msgs, created_flags):
        with patch.object(message_dispatch, "run_agent", side_effect=_fake_agent):
            message_dispatch._dispatch(inbound=_inbound(), messaging=provider)

    assert provider.sent, "expected a reply to be sent"
    assert provider.sent[-1].body == "It has 1 of 3 seats filled."
    assert not created_flags, "happy path must not flag for admin"


def test_context_assembly_failure_degrades_to_flag_and_fallback() -> None:
    """If build_agent_context raises, dispatch must not escape — it flags + falls back."""
    provider = FakeMessagingProvider()
    created_msgs: list[MessageDoc] = []
    created_flags: list = []

    with _stubbed_dispatch(created_msgs, created_flags):
        with patch.object(
            message_dispatch, "build_agent_context",
            side_effect=ValueError("simulated context-assembly bug"),
        ):
            # Must NOT raise out of _dispatch.
            message_dispatch._dispatch(inbound=_inbound(), messaging=provider)

    assert created_flags, "context-assembly failure must flag for admin"
    assert "context" in created_flags[-1].reason.lower() or "ValueError" in created_flags[-1].reason
    assert provider.sent, "user must get a fallback reply, not silence"


def test_phone_never_enters_agent_context() -> None:
    """Data minimization: the AgentContext handed to the model carries no phone."""
    provider = FakeMessagingProvider()
    created_msgs: list[MessageDoc] = []
    created_flags: list = []
    seen: dict[str, AgentContext] = {}

    def _capture_agent(*, llm, context, inbound_text):
        seen["context"] = context
        return AgentOutput(mode="reply", reply_text="ok")

    with _stubbed_dispatch(created_msgs, created_flags):
        with patch.object(message_dispatch, "run_agent", side_effect=_capture_agent):
            message_dispatch._dispatch(inbound=_inbound(), messaging=provider)

    ctx = seen["context"]
    assert isinstance(ctx, AgentContext)
    assert _PHONE not in ctx.model_dump_json()
    assert not hasattr(ctx, "sender_phone")


def test_webhook_backstop_returns_200_when_dispatch_raises() -> None:
    """A bug that escapes _dispatch must yield HTTP 200, not a 500 retry storm."""
    inbound = _inbound()

    class _FakeReq:
        def get_data(self):
            return b'{"data": {"event_type": "message.received"}}'
        headers = {"X-Smoke-Test-Token": "tok"}

    with (
        patch.dict("os.environ", {"SMOKE_TEST_TOKEN": "tok"}),
        patch.object(message_dispatch, "get_messaging_provider", return_value=FakeMessagingProvider()),
        patch.object(
            message_dispatch.get_messaging_provider(), "parse_inbound", return_value=inbound,
        ),
        patch.object(message_dispatch, "_dispatch", side_effect=RuntimeError("boom")),
    ):
        resp = message_dispatch.handle_inbound_webhook(_FakeReq())

    assert resp.status_code == 200
