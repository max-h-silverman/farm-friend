"""Unit tests for provider-level MMS media handling."""

from __future__ import annotations

from app.messaging.fake_provider import FakeMessagingProvider
from app.messaging.telnyx_provider import TelnyxProvider


def test_fake_provider_records_media_urls() -> None:
    provider = FakeMessagingProvider()
    provider.send(
        to_phone="+12065550101",
        body="Pickup details",
        media_urls=["https://media.example.test/pickup.jpg"],
    )

    assert provider.sent[0].media_urls == ["https://media.example.test/pickup.jpg"]


def test_telnyx_send_includes_media_urls(monkeypatch) -> None:
    captured: dict = {}

    class _Response:
        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict:
            return {"data": {"id": "msg_123"}}

    def fake_post(url, *, json, headers, timeout):
        captured["url"] = url
        captured["json"] = json
        captured["headers"] = headers
        captured["timeout"] = timeout
        return _Response()

    monkeypatch.setattr("app.messaging.telnyx_provider.httpx.post", fake_post)
    provider = TelnyxProvider(
        api_key="key", public_key="", from_number="+15555550100",
    )

    msg_id = provider.send(
        to_phone="+12065550101",
        body="Pickup details",
        media_urls=["https://media.example.test/pickup.jpg"],
    )

    assert msg_id == "msg_123"
    assert captured["json"]["text"] == "Pickup details"
    assert captured["json"]["media_urls"] == ["https://media.example.test/pickup.jpg"]


def test_telnyx_parse_inbound_extracts_media_urls() -> None:
    provider = TelnyxProvider(
        api_key="key", public_key="", from_number="+15555550100",
    )

    inbound = provider.parse_inbound(
        payload={
            "data": {
                "payload": {
                    "id": "msg_in",
                    "from": {"phone_number": "+12065550101"},
                    "to": [{"phone_number": "+15555550100"}],
                    "text": "photo of pickup spot",
                    "received_at": "2026-05-29T12:00:00Z",
                    "media": [
                        {
                            "url": "https://media.example.test/pickup.jpg",
                            "content_type": "image/jpeg",
                        }
                    ],
                }
            }
        }
    )

    assert inbound.body == "photo of pickup spot"
    assert inbound.media_urls == ["https://media.example.test/pickup.jpg"]
