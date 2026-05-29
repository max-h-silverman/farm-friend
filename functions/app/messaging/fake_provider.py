"""In-memory messaging provider for tests.

Use this in pytest fixtures to avoid hitting Telnyx. Records every send call
on `.sent` so tests can assert on outbound traffic. `parse_inbound` accepts
a simple {from, to, body} dict; `verify_webhook` always returns valid.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from uuid import uuid4

from .provider import InboundMessage, MessagingProvider, WebhookValidation


@dataclass
class SentMessage:
    to_phone: str
    body: str
    provider_msg_id: str
    sent_at: datetime
    media_urls: list[str] = field(default_factory=list)


class FakeMessagingProvider(MessagingProvider):
    def __init__(self) -> None:
        self.sent: list[SentMessage] = []

    def send(
        self, *, to_phone: str, body: str, media_urls: list[str] | None = None
    ) -> str:
        mid = f"fake-{uuid4()}"
        self.sent.append(
            SentMessage(
                to_phone=to_phone,
                body=body,
                provider_msg_id=mid,
                sent_at=datetime.now(UTC),
                media_urls=list(media_urls or []),
            )
        )
        return mid

    def verify_webhook(
        self, *, body: bytes, signature: str, timestamp: str
    ) -> WebhookValidation:
        return WebhookValidation(valid=True)

    def parse_inbound(self, *, payload: dict) -> InboundMessage:
        return InboundMessage(
            from_phone=payload["from"],
            to_phone=payload.get("to", "+15555550100"),
            body=payload.get("body", ""),
            provider_msg_id=payload.get("id", f"fake-in-{uuid4()}"),
            received_at=datetime.now(UTC),
            media_urls=list(payload.get("media_urls") or []),
        )

    def reset(self) -> None:
        self.sent.clear()
