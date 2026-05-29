"""LLMClient unit tests with a fake adapter."""

from __future__ import annotations

import json
from typing import Any

import pytest
from pydantic import BaseModel

from app.config import Settings
from app.llm.client import LLMAdapter, LLMClient, LLMProviderError, Message


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
