"""Telnyx SMS provider implementation.

Uses Telnyx's HTTP API directly (httpx). We don't bring in the telnyx-python SDK
because the SDK pulls in a lot of unrelated deps; the HTTP surface we need is
tiny (one send endpoint + one signature verification).

Signature verification is Ed25519 over `${timestamp}|${raw_body}`, per
https://developers.telnyx.com/docs/api/v2/overview#webhook-verification.
"""

from __future__ import annotations

import base64
from datetime import UTC, datetime, timedelta

import httpx
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from .provider import InboundMessage, MessagingProvider, WebhookValidation


TELNYX_API_BASE = "https://api.telnyx.com/v2"
WEBHOOK_TOLERANCE_SECONDS = 5 * 60  # reject webhooks older than 5 minutes


class TelnyxProvider(MessagingProvider):
    def __init__(self, *, api_key: str, public_key: str, from_number: str) -> None:
        self._api_key = api_key
        self._public_key_b64 = public_key
        self._from_number = from_number

    # ------------------------------------------------------------------
    # send
    # ------------------------------------------------------------------
    def send(
        self, *, to_phone: str, body: str, media_urls: list[str] | None = None
    ) -> str:
        payload = {"from": self._from_number, "to": to_phone, "text": body}
        if media_urls:
            payload["media_urls"] = media_urls
        resp = httpx.post(
            f"{TELNYX_API_BASE}/messages",
            json=payload,
            headers={"Authorization": f"Bearer {self._api_key}"},
            timeout=15.0,
        )
        resp.raise_for_status()
        data = resp.json()
        return data["data"]["id"]

    # ------------------------------------------------------------------
    # verify_webhook
    # ------------------------------------------------------------------
    def verify_webhook(
        self, *, body: bytes, signature: str, timestamp: str
    ) -> WebhookValidation:
        if not self._public_key_b64:
            return WebhookValidation(valid=False, error="public key not configured")
        try:
            ts = int(timestamp)
        except ValueError:
            return WebhookValidation(valid=False, error="invalid timestamp header")
        now = int(datetime.now(UTC).timestamp())
        if abs(now - ts) > WEBHOOK_TOLERANCE_SECONDS:
            return WebhookValidation(valid=False, error="timestamp outside tolerance")

        signed_payload = f"{timestamp}|".encode() + body
        try:
            key_bytes = base64.b64decode(self._public_key_b64)
            sig_bytes = base64.b64decode(signature)
            Ed25519PublicKey.from_public_bytes(key_bytes).verify(sig_bytes, signed_payload)
        except (InvalidSignature, ValueError) as e:
            return WebhookValidation(valid=False, error=f"signature check failed: {e}")
        return WebhookValidation(valid=True)

    # ------------------------------------------------------------------
    # parse_inbound
    # ------------------------------------------------------------------
    def parse_inbound(self, *, payload: dict) -> InboundMessage:
        data = payload["data"]
        attrs = data["payload"]
        # Inbound messages have `direction == "inbound"`; outbound delivery
        # receipts come through the same webhook with different shape — those
        # are filtered upstream in message_dispatch.
        to_phones = attrs.get("to", [])
        to_phone = to_phones[0]["phone_number"] if to_phones else ""
        media_urls = [
            item["url"]
            for item in (attrs.get("media") or [])
            if isinstance(item, dict) and item.get("url")
        ]
        return InboundMessage(
            from_phone=attrs["from"]["phone_number"],
            to_phone=to_phone,
            body=attrs.get("text") or "",
            provider_msg_id=attrs["id"],
            received_at=_parse_iso(attrs.get("received_at")) or datetime.now(UTC),
            media_urls=media_urls,
        )


def _parse_iso(s: str | None) -> datetime | None:
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None
