"""Anthropic adapter.

Translates the internal OpenAI-format `messages` list + JSON schema into a
call to Anthropic's Messages API. Honors `cache_system_prompt` via Anthropic's
cache_control mechanism on the system block — critical for keeping cost down
on the hot agent paths (parser, classifier).

We deliberately do not depend on `litellm` or similar omnibus libraries; this
adapter is intentionally small and pinned to one provider's API surface.
"""

from __future__ import annotations

import json
from typing import Any

from anthropic import Anthropic

from .client import LLMAdapter, LLMProviderError, Message


class AnthropicAdapter(LLMAdapter):
    def __init__(self, *, api_key: str) -> None:
        if not api_key:
            raise LLMProviderError("ANTHROPIC_API_KEY is required for anthropic provider")
        self._client = Anthropic(api_key=api_key)

    def chat_json_raw(
        self,
        *,
        model: str,
        messages: list[Message],
        json_schema: dict[str, Any],
        cache_system_prompt: bool,
        max_tokens: int,
    ) -> str:
        # Separate system messages from the user/assistant turns.
        system_parts: list[dict[str, Any]] = []
        turn_messages: list[dict[str, str]] = []
        for m in messages:
            if m.role == "system":
                block: dict[str, Any] = {"type": "text", "text": m.content}
                if cache_system_prompt:
                    block["cache_control"] = {"type": "ephemeral"}
                system_parts.append(block)
            elif m.role in ("user", "assistant"):
                turn_messages.append({"role": m.role, "content": m.content})
            else:
                raise LLMProviderError(f"Unsupported role: {m.role!r}")

        # We can't pass a `response_format=json_schema` to Anthropic directly,
        # so we inject the schema into the system prompt and instruct the model
        # to emit ONLY valid JSON matching it. With Claude this is reliable.
        schema_directive = (
            "You MUST respond with a single JSON object that conforms exactly to "
            "the following JSON Schema. Output ONLY the JSON object — no prose, "
            "no markdown fences, no explanations.\n\n"
            f"```json\n{json.dumps(json_schema, indent=2)}\n```"
        )
        system_parts.append({"type": "text", "text": schema_directive})

        resp = self._client.messages.create(
            model=model,
            max_tokens=max_tokens,
            system=system_parts,
            messages=turn_messages,
        )

        # Collect text content blocks.
        parts: list[str] = []
        for block in resp.content:
            if getattr(block, "type", None) == "text":
                parts.append(block.text)
        text = "".join(parts).strip()

        # Strip accidental markdown fences if the model added them.
        if text.startswith("```"):
            text = text.strip("`")
            if text.startswith("json"):
                text = text[4:]
            text = text.strip()

        return text
