"""LLM portability layer.

A single entrypoint, `LLMClient.chat_json`, that returns validated JSON
matching a Pydantic model. Provider selection is config-driven; the primary
open-model path is OLMo through an OpenAI-compatible endpoint. See CLAUDE.md →
"LLM portability" for the rationale.

`cache_system_prompt` is a hint: honored by the Anthropic adapter via
cache-control headers, no-op on OpenAI-compatible providers (their runtimes
cache internally but don't expose explicit cache APIs).
"""

from __future__ import annotations

import json
from typing import Any, Protocol, TypeVar

from pydantic import BaseModel, ValidationError

from app.config import Settings, load_settings

T = TypeVar("T", bound=BaseModel)


class Message(BaseModel):
    role: str  # "system" | "user" | "assistant"
    content: str


class LLMProviderError(Exception):
    """Raised when the LLM provider returns an unrecoverable error or invalid output."""


class LLMAdapter(Protocol):
    """Provider adapter contract — both Anthropic and OpenAI-compatible implement this."""

    def chat_json_raw(
        self,
        *,
        model: str,
        messages: list[Message],
        json_schema: dict[str, Any],
        cache_system_prompt: bool,
        max_tokens: int,
    ) -> str:
        """Return raw JSON string from the model. Caller validates against schema."""
        ...


class LLMClient:
    """Public LLM interface used by all agent tasks.

    Two model tiers: `fast` (lightweight classifier/background work) and
    `strong` (coordinator-quality dialogue/planning). Agent code declares which
    tier it wants; the actual model name is config-driven.
    """

    def __init__(self, adapter: LLMAdapter, settings: Settings) -> None:
        self._adapter = adapter
        self._settings = settings

    def chat_json(
        self,
        *,
        model_tier: str,  # "fast" | "strong"
        messages: list[Message],
        response_model: type[T],
        cache_system_prompt: bool = False,
        max_tokens: int = 1024,
    ) -> T:
        model = (
            self._settings.llm_model_strong if model_tier == "strong"
            else self._settings.llm_model_fast
        )
        schema = response_model.model_json_schema()
        raw = self._adapter.chat_json_raw(
            model=model,
            messages=messages,
            json_schema=schema,
            cache_system_prompt=cache_system_prompt,
            max_tokens=max_tokens,
        )
        try:
            data = json.loads(raw)
            return response_model.model_validate(data)
        except (json.JSONDecodeError, ValidationError) as e:
            raise LLMProviderError(
                f"Model output did not conform to {response_model.__name__}: {e}\nRaw: {raw[:500]}"
            ) from e


def get_llm_client(settings: Settings | None = None) -> LLMClient:
    """Factory. Selects adapter from settings.llm_provider."""
    s = settings or load_settings()
    if s.llm_provider == "anthropic":
        from .anthropic_adapter import AnthropicAdapter
        return LLMClient(AnthropicAdapter(api_key=s.anthropic_api_key), s)
    elif s.llm_provider in {"openai-compatible", "olmo"}:
        from .openai_compat_adapter import OpenAICompatibleAdapter
        return LLMClient(
            OpenAICompatibleAdapter(
                api_key=s.llm_api_key or "no-key",
                base_url=s.llm_base_url,
                timeout_ms=s.llm_timeout_ms,
                temperature=s.llm_temperature,
            ),
            s,
        )
    else:
        raise ValueError(f"Unknown LLM_PROVIDER: {s.llm_provider!r}")
