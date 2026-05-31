from __future__ import annotations

from datetime import UTC, datetime
from unittest.mock import patch

from app.flows.message_dispatch import (
    _handle_timeout_offer_fallback,
    _timeout_offer_payload,
)
from app.messaging.fake_provider import FakeMessagingProvider
from app.repos.models import MessageDoc, UserDoc, UserRole, UserStatus


def test_timeout_offer_payload_captures_weekend_daytime_offer() -> None:
    payload = _timeout_offer_payload("i'm free this weekend to help during the day")

    assert payload is not None
    assert payload["activity_tags"] == []
    assert payload["earliest_at"]
    assert payload["latest_at"]
    assert payload["note"] == "i'm free this weekend to help during the day"


def test_timeout_offer_payload_rejects_unavailable_text() -> None:
    assert _timeout_offer_payload("I can't help this weekend") is None


def test_timeout_offer_payload_marks_explicit_flexible() -> None:
    payload = _timeout_offer_payload("available Saturday morning for anything")

    assert payload is not None
    assert payload["activity_tags"] == ["flexible"]


def test_timeout_offer_fallback_sends_pending_confirmation() -> None:
    sender = UserDoc(
        id="u_vol",
        phone="+15550101002",
        name="Brigid Shaw",
        role=UserRole.VOLUNTEER,
        status=UserStatus.ACTIVE,
        created_at=datetime.now(UTC),
    )
    provider = FakeMessagingProvider()
    created: list[MessageDoc] = []

    with (
        patch("app.flows.message_dispatch.messages_repo.create", side_effect=created.append),
        patch("app.flows.message_dispatch._media_urls_from_message", return_value=[]),
    ):
        handled = _handle_timeout_offer_fallback(
            sender=sender,
            inbound_text="i'm free this weekend to help during the day",
            inbound_doc_id="m_in",
            target_opp=None,
            provider=provider,
        )

    assert handled is True
    assert provider.sent[0].body == (
        "Great, recording your offer to help this weekend. Reply YES to confirm."
    )
    assert created[0].intent_label.value == "PENDING_CONFIRMATION"
    assert created[0].pending_action["action"] == "record_offer"
    assert created[0].pending_action["payload"]["note"] == (
        "i'm free this weekend to help during the day"
    )
