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
        agent_review_admin_only=True,
        clarify_round_max=2,
        clarify_user_24h_max=5,
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


class _SequenceAdapter(LLMAdapter):
    """Returns a queued response per call; records how many calls happened."""

    def __init__(self, responses: list[str]) -> None:
        self._responses = list(responses)
        self.calls = 0
        self.last_messages: list[Message] = []

    def chat_json_raw(
        self,
        *,
        model: str,
        messages: list[Message],
        json_schema: dict[str, Any],
        cache_system_prompt: bool,
        max_tokens: int,
    ) -> str:
        self.calls += 1
        self.last_messages = messages
        idx = min(self.calls - 1, len(self._responses) - 1)
        return self._responses[idx]


def test_invalid_json_raises_provider_error_after_retry() -> None:
    adapter = _SequenceAdapter(["not json", "still not json"])
    client = LLMClient(adapter, _settings())
    with pytest.raises(LLMProviderError):
        client.chat_json(
            model_tier="fast",
            messages=[Message(role="user", content="x")],
            response_model=Person,
        )
    # First attempt + one repair retry.
    assert adapter.calls == 2


def test_json_repair_retry_recovers_bad_first_attempt() -> None:
    good = json.dumps({"name": "Alice", "age": 33})
    adapter = _SequenceAdapter(["Sure! Here you go: not-valid", good])
    client = LLMClient(adapter, _settings())
    result = client.chat_json(
        model_tier="fast",
        messages=[Message(role="system", content="sys"), Message(role="user", content="x")],
        response_model=Person,
    )
    assert result.name == "Alice"
    assert adapter.calls == 2
    # The repair prompt threaded the bad output back as an assistant turn.
    assert any(m.role == "assistant" for m in adapter.last_messages)


def test_valid_first_attempt_does_not_retry() -> None:
    adapter = _SequenceAdapter([json.dumps({"name": "Bo", "age": 7})])
    client = LLMClient(adapter, _settings())
    client.chat_json(
        model_tier="fast",
        messages=[Message(role="user", content="x")],
        response_model=Person,
    )
    assert adapter.calls == 1


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


def test_default_provider_is_mistral_on_deepinfra(monkeypatch) -> None:
    """With no env tuning, the current pilot trial is Mistral Small 3.2 on
    DeepInfra.

    NB: the Gemma-substitution problem is OLMo-specific — DeepInfra serves
    Mistral correctly under its HF repo id, so this path uses DeepInfra directly.
    """
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

    assert settings.llm_provider == "mistral-deepinfra"
    assert settings.llm_base_url == "https://api.deepinfra.com/v1/openai"
    assert settings.llm_model_strong == "mistralai/Mistral-Small-3.2-24B-Instruct-2506"
    assert settings.llm_model_fast == "mistralai/Mistral-Small-3.2-24B-Instruct-2506"
    assert settings.llm_timeout_ms == 20000
    assert settings.llm_temperature == 0.1


def test_olmo_openrouter_provider_uses_openrouter(monkeypatch) -> None:
    """`olmo-openrouter` remains available: real OLMo served via OpenRouter.

    DeepInfra's direct endpoint silently serves Gemma for the OLMo id (verified
    2026-05-30), so the OLMo path routes through OpenRouter instead.
    """
    monkeypatch.setenv("LLM_PROVIDER", "olmo-openrouter")
    for key in (
        "LLM_MODEL",
        "LLM_CLASSIFIER_MODEL",
        "LLM_MODEL_FAST",
        "LLM_MODEL_STRONG",
        "LLM_BASE_URL",
    ):
        monkeypatch.delenv(key, raising=False)

    settings = load_settings()

    assert settings.llm_provider == "olmo-openrouter"
    assert settings.llm_base_url == "https://openrouter.ai/api/v1"
    # OpenRouter uses the lowercase slug.
    assert settings.llm_model_strong == "allenai/olmo-3.1-32b-instruct"
    assert settings.llm_model_fast == "allenai/olmo-3.1-32b-instruct"


def test_olmo_local_provider_keeps_localhost_default(monkeypatch) -> None:
    """`olmo` (self-hosted) keeps the localhost endpoint + HF repo ids."""
    monkeypatch.setenv("LLM_PROVIDER", "olmo")
    for key in ("LLM_MODEL", "LLM_CLASSIFIER_MODEL", "LLM_BASE_URL"):
        monkeypatch.delenv(key, raising=False)

    settings = load_settings()

    assert settings.llm_provider == "olmo"
    assert settings.llm_base_url == "http://localhost:8000/v1"
    assert settings.llm_model_strong == "allenai/Olmo-3.1-32B-Instruct"


def test_openrouter_prefers_openrouter_key_then_falls_back(monkeypatch) -> None:
    monkeypatch.setenv("LLM_PROVIDER", "olmo-openrouter")
    monkeypatch.setenv("OPENROUTER_API_KEY", "or-key")
    monkeypatch.setenv("LLM_API_KEY", "generic-key")
    assert load_settings().llm_api_key == "or-key"

    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    assert load_settings().llm_api_key == "generic-key"


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
        agent_review_admin_only=True,
        clarify_round_max=2,
        clarify_user_24h_max=5,
        offer_default_ttl_days=7,
        proposal_auto_confirm_far_min=240,
        proposal_auto_confirm_close_min=60,
    )

    client = get_llm_client(settings)

    assert isinstance(client, LLMClient)


def test_openai_compatible_adapter_disables_sdk_retries(monkeypatch) -> None:
    captured: dict[str, Any] = {}

    class FakeOpenAI:
        def __init__(self, **kwargs: Any) -> None:
            captured.update(kwargs)

    monkeypatch.setattr("app.llm.openai_compat_adapter.OpenAI", FakeOpenAI)

    from app.llm.openai_compat_adapter import OpenAICompatibleAdapter

    OpenAICompatibleAdapter(
        api_key="key",
        base_url="https://example.test/v1",
        timeout_ms=8000,
        temperature=0.1,
    )

    assert captured["timeout"] == 8.0
    assert captured["max_retries"] == 0
