"""OpenAI-compatible provider adapter.

Covers vLLM, Ollama, Groq, Together, Fireworks, DeepInfra — anything that
implements the OpenAI `/v1/chat/completions` API surface. We use the official
`openai` SDK with `base_url` swapped so we don't reinvent retries or pagination.

Structured output: there are three response_format strategies and providers
honor them inconsistently:

  1. `json_schema` with `strict: true` — strongly enforced (OpenAI proper,
     vLLM guided_json). Best when it works.
  2. `json_schema` with strict ignored — accepted by the API but the model
     produces freeform output anyway (observed on DeepInfra + Llama 3.3 70B).
     Detectable by parsing the response; we fall back if so.
  3. `json_object` + schema-in-system-prompt — universal fallback. Works on
     anything that supports `json_object`.

The adapter tries (1) → detects (2) → falls back to (3). Strategy can also
be forced via env var `LLM_FORCE_JSON_OBJECT=1` for providers known to
mishandle json_schema.

`cache_system_prompt` is a no-op here. Open-weight runtimes cache KV internally
but don't expose an explicit cache API.
"""

from __future__ import annotations

import json
import os
from typing import Any

from openai import OpenAI
from openai import BadRequestError

from .client import LLMAdapter, LLMProviderError, Message


class OpenAICompatibleAdapter(LLMAdapter):
    def __init__(self, *, api_key: str, base_url: str) -> None:
        if not base_url:
            raise LLMProviderError("LLM_BASE_URL is required for openai-compatible provider")
        self._client = OpenAI(api_key=api_key or "no-key", base_url=base_url)
        # Detect providers we already know mishandle json_schema. DeepInfra
        # accepts the request but doesn't enforce the schema; Llama models will
        # write prose or code instead. Skipping straight to the json_object path
        # saves a wasted round-trip and reduces tail latency.
        self._force_json_object = (
            os.environ.get("LLM_FORCE_JSON_OBJECT", "").lower() in {"1", "true", "yes"}
            or "deepinfra" in base_url.lower()
        )

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

        if not self._force_json_object:
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
                content = _strip_fences((resp.choices[0].message.content or "").strip())
                # Validate the provider actually honored json_schema. If not,
                # fall through to the json_object + prompt-injection path.
                if _looks_like_json_object(content):
                    return content
            except BadRequestError:
                # Provider doesn't support json_schema at all — fall back.
                pass

        # Fallback: concatenate the schema directive INTO the existing system
        # message rather than prepending a second one; some providers handle
        # only the first system message and would otherwise drop the agent's
        # prompt.
        schema_directive = (
            "\n\n---\nYou MUST respond with a single JSON object that conforms "
            "exactly to the following JSON Schema. Output ONLY the JSON object "
            "— no prose, no markdown fences, no code blocks, no commentary. "
            "Your first character must be `{`.\n\n"
            f"```json\n{json.dumps(json_schema, indent=2)}\n```"
        )
        patched: list[dict[str, str]] = []
        appended = False
        for m in chat_messages:
            if m["role"] == "system" and not appended:
                patched.append({"role": "system", "content": m["content"] + schema_directive})
                appended = True
            else:
                patched.append(m)
        if not appended:
            patched.insert(0, {"role": "system", "content": schema_directive.lstrip()})
        resp = self._client.chat.completions.create(
            model=model,
            messages=patched,
            max_tokens=max_tokens,
            response_format={"type": "json_object"},
        )
        return _strip_fences((resp.choices[0].message.content or "").strip())


def _looks_like_json_object(text: str) -> bool:
    """Cheap sanity check that the model returned a JSON object (not prose,
    not code). We don't fully parse here — the caller already does
    `json.loads` + pydantic validation — we just check whether the bytes
    look like the right shape so we know whether to fall back."""
    if not text:
        return False
    s = text.lstrip()
    return s.startswith("{")


def _strip_fences(text: str) -> str:
    """Strip accidental ```json fences if the model added them despite being
    told not to. Cheaper than a re-prompt."""
    if text.startswith("```"):
        text = text.strip("`")
        if text.startswith("json"):
            text = text[4:]
        text = text.strip()
    return text
