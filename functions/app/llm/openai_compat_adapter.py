"""OpenAI-compatible provider adapter.

Covers vLLM, Ollama, Groq, Together, Fireworks, DeepInfra — anything that
implements the OpenAI `/v1/chat/completions` API surface. We use the official
`openai` SDK with `base_url` swapped so we don't reinvent retries or pagination.

Structured output: prefers `response_format={"type": "json_schema", ...}` when
the underlying provider supports it (vLLM with guided_json, recent OpenAI-style
endpoints). Falls back to the same schema-in-system-prompt trick used by the
Anthropic adapter when the call rejects json_schema.

`cache_system_prompt` is a no-op here. Open-weight runtimes cache KV internally
but don't expose an explicit cache API.
"""

from __future__ import annotations

import json
from typing import Any

from openai import OpenAI
from openai import BadRequestError

from .client import LLMAdapter, LLMProviderError, Message


class OpenAICompatibleAdapter(LLMAdapter):
    def __init__(self, *, api_key: str, base_url: str) -> None:
        if not base_url:
            raise LLMProviderError("LLM_BASE_URL is required for openai-compatible provider")
        self._client = OpenAI(api_key=api_key or "no-key", base_url=base_url)

    def chat_json_raw(
        self,
        *,
        model: str,
        messages: list[Message],
        json_schema: dict[str, Any],
        cache_system_prompt: bool,  # noqa: ARG002 — accepted for interface parity
        max_tokens: int,
    ) -> str:
        chat_messages = [{"role": m.role, "content": m.content} for m in messages]

        # Try native json_schema response format first.
        try:
            resp = self._client.chat.completions.create(
                model=model,
                messages=chat_messages,
                max_tokens=max_tokens,
                response_format={
                    "type": "json_schema",
                    "json_schema": {
                        "name": json_schema.get("title", "Response"),
                        "schema": json_schema,
                        "strict": True,
                    },
                },
            )
            content = resp.choices[0].message.content or ""
            return content.strip()
        except BadRequestError:
            # Provider doesn't support json_schema — fall back to prompt injection.
            schema_directive = (
                "You MUST respond with a single JSON object that conforms exactly to "
                "the following JSON Schema. Output ONLY the JSON object — no prose, "
                "no markdown fences.\n\n"
                f"```json\n{json.dumps(json_schema, indent=2)}\n```"
            )
            patched = [
                {"role": "system", "content": schema_directive},
                *chat_messages,
            ]
            resp = self._client.chat.completions.create(
                model=model,
                messages=patched,
                max_tokens=max_tokens,
                response_format={"type": "json_object"},
            )
            content = resp.choices[0].message.content or ""
            content = content.strip()
            if content.startswith("```"):
                content = content.strip("`")
                if content.startswith("json"):
                    content = content[4:]
                content = content.strip()
            return content
