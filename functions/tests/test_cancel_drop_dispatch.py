"""Dispatch-level checks for CANCEL/DROP context semantics."""

from __future__ import annotations

from datetime import UTC, datetime
from unittest.mock import patch

from app.agent.hotkeys import HotkeyMatch
from app.flows import message_dispatch
from app.messaging.fake_provider import FakeMessagingProvider
from app.repos.models import (
    IntentLabel,
    MessageDirection,
    MessageDoc,
    OpportunityDoc,
    OpportunityKind,
    OpportunityStatus,
    UserDoc,
    UserRole,
    UserStatus,
)


def _volunteer() -> UserDoc:
    return UserDoc(
        id="u_vol",
        phone="+12065550101",
        name="Alex",
        role=UserRole.VOLUNTEER,
        status=UserStatus.ACTIVE,
        created_at=datetime.now(UTC),
    )


def _opp() -> OpportunityDoc:
    return OpportunityDoc(
        id="opp_1",
        farm_id="farm_1",
        kind=OpportunityKind.SHIFT,
        status=OpportunityStatus.FULL,
        starts_at=datetime.now(UTC),
        headcount_needed=1,
        seats_filled=1,
        created_at=datetime.now(UTC),
        activity_tags=["weeding"],
    )


def _reminder() -> MessageDoc:
    return MessageDoc(
        id="m_out",
        direction=MessageDirection.OUTBOUND,
        provider_msg_id="fake-out",
        user_id="u_vol",
        opportunity_id="opp_1",
        body="Reply DROP if you can't make it.",
        intent_label=IntentLabel.CONFIRMATION_REMINDER,
        created_at=datetime.now(UTC),
    )


def test_drop_after_confirmation_reminder_drops_claim() -> None:
    provider = FakeMessagingProvider()
    volunteer = _volunteer()
    opp = _opp()

    with (
        patch.object(message_dispatch.claim_flow, "handle_volunteer_drop", return_value="Dropped.") as drop,
        patch.object(message_dispatch.messages_repo, "create"),
    ):
        message_dispatch._handle_hotkey(
            match=HotkeyMatch(IntentLabel.DROP, {}),
            sender=volunteer,
            target_opp=opp,
            last_outbound=_reminder(),
            inbound_doc_id="m_in",
            provider=provider,
        )

    drop.assert_called_once()
    assert provider.sent[-1].body == "Dropped."


def test_ambiguous_volunteer_cancel_unsubscribes() -> None:
    provider = FakeMessagingProvider()
    volunteer = _volunteer()

    with (
        patch.object(message_dispatch.users_repo, "set_status") as set_status,
        patch.object(message_dispatch.messages_repo, "create"),
    ):
        message_dispatch._handle_hotkey(
            match=HotkeyMatch(IntentLabel.CANCEL, {}),
            sender=volunteer,
            target_opp=None,
            last_outbound=None,
            inbound_doc_id="m_in",
            provider=provider,
        )

    set_status.assert_called_once_with("u_vol", UserStatus.UNSUBSCRIBED)
    assert "unsubscribed" in provider.sent[-1].body.lower()
