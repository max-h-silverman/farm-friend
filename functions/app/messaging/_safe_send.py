"""Safe wrapper around outbound message sending.

Provider .send() can fail for many reasons (invalid number, suspended account,
rate limit, network). None of those should crash the webhook — the inbound
message has already been processed, the opportunity already created, etc.

Returns a provider message id on success, or None on failure / quiet-hours
defer. The caller is responsible for deciding whether to persist a placeholder
MessageDoc; on a None return we skip the log entry so retries don't double-log.

Quiet hours: 11pm–7am Vashon local. System-initiated sends (scheduled ticks,
fan-outs, milestones) pass `respect_quiet_hours=True` and get deferred silently
during the window. Direct replies to inbound messages don't pass that flag —
the user is actively in conversation and an immediate reply is expected.
"""

from __future__ import annotations

import logging

from app.flows._time import is_quiet_hours

from .provider import MessagingProvider


log = logging.getLogger(__name__)


def safe_send(
    provider: MessagingProvider,
    *,
    to_phone: str,
    body: str,
    media_urls: list[str] | None = None,
    respect_quiet_hours: bool = False,
) -> str | None:
    if respect_quiet_hours and is_quiet_hours():
        log.info("outbound deferred (quiet hours) to %s", to_phone)
        return None
    try:
        return provider.send(to_phone=to_phone, body=body, media_urls=media_urls)
    except Exception as e:  # noqa: BLE001 — provider errors are intentionally broad
        log.warning("outbound send failed to %s: %s", to_phone, e)
        return None
