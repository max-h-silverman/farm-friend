"""Safe wrapper around outbound message sending.

Provider .send() can fail for many reasons (invalid number, suspended account,
rate limit, network). None of those should crash the webhook — the inbound
message has already been processed, the opportunity already created, etc.

Returns a provider message id on success, or None on failure. The caller is
responsible for deciding whether to persist a placeholder MessageDoc with a
"failed" marker. For now, on failure we log + return None and the caller
skips the message log entry.
"""

from __future__ import annotations

import logging

from .provider import MessagingProvider


log = logging.getLogger(__name__)


def safe_send(
    provider: MessagingProvider, *, to_phone: str, body: str
) -> str | None:
    try:
        return provider.send(to_phone=to_phone, body=body)
    except Exception as e:  # noqa: BLE001 — provider errors are intentionally broad
        log.warning("outbound send failed to %s: %s", to_phone, e)
        return None
