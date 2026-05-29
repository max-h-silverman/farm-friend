"""LLMClient unit tests with a fake adapter."""

from __future__ import annotations

import json
from typing import Any

import pytest
from pydantic import BaseModel

from app.config import Settings, load_settings
from app.llm.client import LLMAdapter, LLMClient, LLMProviderError, Message, get_llm_client


class _FakeAdapter(LLMAdapter):
    def __init__(self, response: str) -> None:
        self.response = response
        self.last_call: dict[str, Any] = {}

    def chat_json_raw(
        self,
        *,
        model: str,
        messages: list[Message],
        json_schema: dict[str, Any],
        cache_system_prompt: bool,
        max_tokens: int,
    ) -> str:
        self.last_call = {
            "model": model,
            "messages": messages,
            "json_schema": json_schema,
            "cache_system_prompt": cache_system_prompt,
            "max_tokens": max_tokens,
        }
        return self.response


class Person(BaseModel):
    name: str
    age: int


def _settings() -> Settings:
    return Settings(
        llm_provider="anthropic",
        llm_model_fast="model-fast",
        llm_model_strong="model-strong",
        llm_base_url="",
        llm_api_key="",
        llm_timeout_ms=20000,
        llm_temperature=0.1,
        anthropic_api_key="key",
        telnyx_api_key="",
        telnyx_public_key="",
        telnyx_from_number="",
        vcard_url="",
        coordinator_phone="",
        agent_review_interval_min=30,
        agent_nudge_budget_hours=48,
        agent_nudge_per_opp_max=2,
        agent_review_per_tick_max=3,
        clarify_round_max=2,
        clarify_user_24h_max=5,
        undo_window_min=5,
        offer_default_ttl_days=7,
        proposal_auto_confirm_far_min=240,
        proposal_auto_confirm_close_min=60,
    )


def test_chat_json_validates_to_pydantic() -> None:
    adapter = _FakeAdapter(json.dumps({"name": "Alice", "age": 33}))
    client = LLMClient(adapter, _settings())
    result = client.chat_json(
        model_tier="fast",
        messages=[Message(role="user", content="x")],
        response_model=Person,
    )
    assert result.name == "Alice"
    assert result.age == 33
    assert adapter.last_call["model"] == "model-fast"


def test_strong_tier_uses_strong_model() -> None:
    adapter = _FakeAdapter(json.dumps({"name": "Bob", "age": 50}))
    client = LLMClient(adapter, _settings())
    client.chat_json(
        model_tier="strong",
        messages=[Message(role="user", content="x")],
        response_model=Person,
    )
    assert adapter.last_call["model"] == "model-strong"


def test_invalid_json_raises_provider_error() -> None:
    adapter = _FakeAdapter("not json at all")
    client = LLMClient(adapter, _settings())
    with pytest.raises(LLMProviderError):
        client.chat_json(
            model_tier="fast",
            messages=[Message(role="user", content="x")],
            response_model=Person,
        )


def test_schema_mismatch_raises_provider_error() -> None:
    adapter = _FakeAdapter(json.dumps({"name": "Alice"}))  # missing age
    client = LLMClient(adapter, _settings())
    with pytest.raises(LLMProviderError):
        client.chat_json(
            model_tier="fast",
            messages=[Message(role="user", content="x")],
            response_model=Person,
        )


def test_cache_flag_propagates_to_adapter() -> None:
    adapter = _FakeAdapter(json.dumps({"name": "Alice", "age": 1}))
    client = LLMClient(adapter, _settings())
    client.chat_json(
        model_tier="fast",
        messages=[Message(role="system", content="sys"), Message(role="user", content="x")],
        response_model=Person,
        cache_system_prompt=True,
    )
    assert adapter.last_call["cache_system_prompt"] is True


def test_olmo_defaults_map_to_coordinator_and_classifier_models(monkeypatch) -> None:
    for key in (
        "LLM_PROVIDER",
        "LLM_MODEL",
        "LLM_CLASSIFIER_MODEL",
        "LLM_MODEL_FAST",
        "LLM_MODEL_STRONG",
        "LLM_BASE_URL",
        "LLM_TIMEOUT_MS",
        "LLM_TEMPERATURE",
    ):
        monkeypatch.delenv(key, raising=False)

    settings = load_settings()

    assert settings.llm_provider == "olmo"
    assert settings.llm_base_url == "http://localhost:8000/v1"
    assert settings.llm_model_strong == "allenai/Olmo-3.1-32B-Instruct"
    assert settings.llm_model_fast == "allenai/Olmo-3-7B-Instruct"
    assert settings.llm_timeout_ms == 20000
    assert settings.llm_temperature == 0.1


def test_legacy_model_tier_env_vars_override_olmo_aliases(monkeypatch) -> None:
    monkeypatch.setenv("LLM_PROVIDER", "olmo")
    monkeypatch.setenv("LLM_MODEL", "coordinator-alias")
    monkeypatch.setenv("LLM_CLASSIFIER_MODEL", "classifier-alias")
    monkeypatch.setenv("LLM_MODEL_STRONG", "strong-override")
    monkeypatch.setenv("LLM_MODEL_FAST", "fast-override")

    settings = load_settings()

    assert settings.llm_model_strong == "strong-override"
    assert settings.llm_model_fast == "fast-override"


def test_openai_compatible_keeps_legacy_defaults(monkeypatch) -> None:
    monkeypatch.setenv("LLM_PROVIDER", "openai-compatible")
    for key in (
        "LLM_MODEL",
        "LLM_CLASSIFIER_MODEL",
        "LLM_MODEL_FAST",
        "LLM_MODEL_STRONG",
        "LLM_BASE_URL",
    ):
        monkeypatch.delenv(key, raising=False)

    settings = load_settings()

    assert settings.llm_base_url == "https://api.deepinfra.com/v1/openai"
    assert settings.llm_model_strong == "meta-llama/Llama-3.3-70B-Instruct"
    assert settings.llm_model_fast == "meta-llama/Llama-3.3-70B-Instruct"


def test_anthropic_keeps_legacy_defaults(monkeypatch) -> None:
    monkeypatch.setenv("LLM_PROVIDER", "anthropic")
    for key in (
        "LLM_MODEL",
        "LLM_CLASSIFIER_MODEL",
        "LLM_MODEL_FAST",
        "LLM_MODEL_STRONG",
        "LLM_BASE_URL",
    ):
        monkeypatch.delenv(key, raising=False)

    settings = load_settings()

    assert settings.llm_base_url == ""
    assert settings.llm_model_strong == "claude-sonnet-4-6"
    assert settings.llm_model_fast == "claude-haiku-4-5-20251001"


def test_factory_accepts_olmo_provider() -> None:
    settings = Settings(
        llm_provider="olmo",
        llm_model_fast="classifier",
        llm_model_strong="coordinator",
        llm_base_url="http://localhost:8000/v1",
        llm_api_key="local-key",
        llm_timeout_ms=20000,
        llm_temperature=0.1,
        anthropic_api_key="",
        telnyx_api_key="",
        telnyx_public_key="",
        telnyx_from_number="",
        vcard_url="",
        coordinator_phone="",
        agent_review_interval_min=30,
        agent_nudge_budget_hours=48,
        agent_nudge_per_opp_max=2,
        agent_review_per_tick_max=3,
        clarify_round_max=2,
        clarify_user_24h_max=5,
        undo_window_min=5,
        offer_default_ttl_days=7,
        proposal_auto_confirm_far_min=240,
        proposal_auto_confirm_close_min=60,
    )

    client = get_llm_client(settings)

    assert isinstance(client, LLMClient)
