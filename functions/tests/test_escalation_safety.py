"""Safety tests for the immediate-escalation coordinator path and pilot-
readiness config checks.

The risk these cover: an IMMEDIATE escalation (injury/safety) must reach the
coordinator in real time, and the system must surface — not silently swallow — the case where
the coordinator phone is unconfigured.
"""

from __future__ import annotations

from datetime import UTC, datetime
from unittest.mock import patch

from app.config import Settings, pilot_readiness_warnings
from app.flows.message_dispatch import _handle_escalation, _is_llm_timeout
from app.messaging.fake_provider import FakeMessagingProvider
from app.repos.models import UserDoc, UserRole, UserStatus


def _settings(**overrides) -> Settings:
    base = dict(
        llm_provider="mistral-deepinfra",
        llm_model_fast="f",
        llm_model_strong="s",
        llm_base_url="https://api.deepinfra.com/v1/openai",
        llm_api_key="",
        llm_timeout_ms=20000,
        llm_temperature=0.1,
        anthropic_api_key="",
        telnyx_api_key="",
        telnyx_public_key="",
        telnyx_from_number="+12065551234",
        vcard_url="",
        coordinator_phone="+12065550100",
        agent_review_interval_min=30,
        agent_nudge_budget_hours=48,
        agent_nudge_per_opp_max=2,
        agent_review_per_tick_max=3,
        agent_review_admin_only=True,
        clarify_round_max=2,
        clarify_user_24h_max=5,
        offer_default_ttl_days=7,
        proposal_auto_confirm_far_min=240,
        proposal_auto_confirm_close_min=60,
    )
    base.update(overrides)
    return Settings(**base)


def _sender() -> UserDoc:
    return UserDoc(
        id="u_vol",
        phone="+15550101099",
        name="Dana Reed",
        role=UserRole.VOLUNTEER,
        status=UserStatus.ACTIVE,
        created_at=datetime.now(UTC),
    )


def test_immediate_escalation_texts_coordinator_when_configured() -> None:
    provider = FakeMessagingProvider()
    with (
        patch("app.flows.message_dispatch.load_settings", return_value=_settings()),
        patch("app.flows.message_dispatch.flags_repo.create"),
        patch("app.flows.message_dispatch.messages_repo.create"),
    ):
        _handle_escalation(
            sender=_sender(),
            inbound_doc_id="m_in",
            provider=provider,
            reason="cut hand at Plum Forest",
            urgency="immediate",
            reply_body="The Farm Friend team will reach out shortly.",
        )
    # One reply to the user + one alert to the coordinator.
    to_coordinator = [m for m in provider.sent if m.to_phone == "+12065550100"]
    assert len(to_coordinator) == 1
    assert "ESCALATE" in to_coordinator[0].body


def test_immediate_escalation_logs_error_when_coordinator_unset(caplog) -> None:
    provider = FakeMessagingProvider()
    with (
        patch(
            "app.flows.message_dispatch.load_settings",
            return_value=_settings(coordinator_phone=""),
        ),
        patch("app.flows.message_dispatch.flags_repo.create") as flag_create,
        patch("app.flows.message_dispatch.messages_repo.create"),
        caplog.at_level("ERROR"),
    ):
        _handle_escalation(
            sender=_sender(),
            inbound_doc_id="m_in",
            provider=provider,
            reason="cut hand at Plum Forest",
            urgency="immediate",
            reply_body="The Farm Friend team will reach out shortly.",
        )
    # The flag is still written (nothing lost) ...
    assert flag_create.called
    # ... but no coordinator SMS was sent and the gap is logged loudly.
    assert all(m.to_phone != "" for m in provider.sent)
    assert any("COORDINATOR_PHONE is unset" in r.message for r in caplog.records)


def test_pilot_readiness_flags_missing_coordinator_phone() -> None:
    warnings = pilot_readiness_warnings(_settings(coordinator_phone=""))
    assert any("COORDINATOR_PHONE" in w for w in warnings)


def test_pilot_readiness_clean_when_configured() -> None:
    assert pilot_readiness_warnings(_settings()) == []


def test_pilot_readiness_flags_placeholder_from_number() -> None:
    warnings = pilot_readiness_warnings(_settings(telnyx_from_number="+15555550100"))
    assert any("TELNYX_FROM_NUMBER" in w for w in warnings)


def test_is_llm_timeout_matches_connection_and_timeout_families() -> None:
    class APITimeoutError(Exception):
        pass

    class APIConnectionError(Exception):
        pass

    class SubclassTimeout(TimeoutError):
        pass

    assert _is_llm_timeout(APITimeoutError())
    assert _is_llm_timeout(APIConnectionError())
    assert _is_llm_timeout(SubclassTimeout())
    assert _is_llm_timeout(TimeoutError())
    assert not _is_llm_timeout(ValueError("nope"))
