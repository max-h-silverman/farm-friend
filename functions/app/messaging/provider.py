"""Messaging provider abstraction.

Everything that sends or receives a message goes through this interface so
the rest of the app doesn't know about Telnyx specifically. To swap in
WhatsApp, iMessage Business, or email later: implement `MessagingProvider`
and select it via config.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Protocol

from app.config import Settings, load_settings


@dataclass(frozen=True, slots=True)
class InboundMessage:
    """Normalized inbound message — provider-agnostic shape."""
    from_phone: str       # E.164
    to_phone: str         # E.164 (our number)
    body: str
    provider_msg_id: str
    received_at: datetime
    media_urls: list[str] | None = None


@dataclass(frozen=True, slots=True)
class WebhookValidation:
    valid: bool
    error: str | None = None


class MessagingProvider(Protocol):
    """Contract every provider implements."""

    def send(
        self, *, to_phone: str, body: str, media_urls: list[str] | None = None
    ) -> str:
        """Send an SMS/MMS. Returns the provider's message id."""
        ...

    def verify_webhook(
        self, *, body: bytes, signature: str, timestamp: str
    ) -> WebhookValidation:
        """Verify an inbound webhook came from the provider."""
        ...

    def parse_inbound(self, *, payload: dict) -> InboundMessage:
        """Parse the provider's inbound webhook payload into our normalized shape."""
        ...


def get_messaging_provider(settings: Settings | None = None) -> MessagingProvider:
    """Factory. Only Telnyx in v1; abstraction lets us add more later."""
    s = settings or load_settings()
    from .telnyx_provider import TelnyxProvider
    return TelnyxProvider(
        api_key=s.telnyx_api_key,
        public_key=s.telnyx_public_key,
        from_number=s.telnyx_from_number,
    )
