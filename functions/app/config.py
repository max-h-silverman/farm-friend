"""Centralized config + secret handles.

Three kinds of config, separated deliberately:

1. **Secrets** (Cloud Secret Manager via SecretParam). These rotate, are
   sensitive, and must be bound to every function that needs them. The LLM
   API key (LLM_API_KEY for OSS providers, ANTHROPIC_API_KEY for the legacy
   Anthropic adapter), Telnyx credentials, and the smoke-test token qualify.

2. **Deploy-time param** (StringParam). One: TELNYX_FROM_NUMBER. It varies by
   environment and we want to prompt on first deploy and persist after.

3. **Plain env vars** (os.environ). Everything else — model names, thresholds,
   URLs with sensible defaults. Set via `.env.<project>` for deploys, `.env`
   for emulator, or not at all (defaults apply). These do NOT prompt at deploy
   time. To change them, edit `.env.farm-friend-vashon` and re-deploy.

LLM defaults: the v1.1 default is an open-weight model (Llama 3.3 70B Instruct
on DeepInfra). Anthropic Sonnet 4.6 is still supported by setting
LLM_PROVIDER=anthropic; pass-rate parity was verified by the live eval. See
CLAUDE.md → "LLM portability".
"""

from __future__ import annotations

import os
from dataclasses import dataclass

from firebase_functions.params import SecretParam, StringParam

# Secrets — set via `firebase functions:secrets:set`
# LLM_API_KEY is the OSS-provider key (DeepInfra / Together / Fireworks / Groq).
# ANTHROPIC_API_KEY remains bound for the optional legacy provider.
LLM_API_KEY = SecretParam("LLM_API_KEY")
ANTHROPIC_API_KEY = SecretParam("ANTHROPIC_API_KEY")
TELNYX_API_KEY = SecretParam("TELNYX_API_KEY")
TELNYX_PUBLIC_KEY = SecretParam("TELNYX_PUBLIC_KEY")
SMOKE_TEST_TOKEN = SecretParam("SMOKE_TEST_TOKEN")

# The one deploy-time param worth prompting for: which phone number to send from.
TELNYX_FROM_NUMBER = StringParam(
    "TELNYX_FROM_NUMBER",
    description="Your Telnyx phone number in E.164 (e.g. +12065551234)",
    default="+15555550100",
)

# All secrets, for binding via `secrets=[...]` on functions that need them.
ALL_SECRETS = [
    LLM_API_KEY,
    ANTHROPIC_API_KEY,
    TELNYX_API_KEY,
    TELNYX_PUBLIC_KEY,
    SMOKE_TEST_TOKEN,
]


def _env(key: str, default: str = "") -> str:
    return os.environ.get(key, default)


def _secret(param: SecretParam) -> str:
    """Read a secret param. Returns "" outside a function invocation (during
    deploy-time analyzer runs, etc.)."""
    try:
        return param.value()
    except Exception:
        return ""


def _string_param(param: StringParam) -> str:
    try:
        return param.value()
    except Exception:
        return ""


@dataclass(frozen=True, slots=True)
class Settings:
    llm_provider: str
    llm_model_fast: str
    llm_model_strong: str
    llm_base_url: str
    llm_api_key: str
    anthropic_api_key: str
    telnyx_api_key: str
    telnyx_public_key: str
    telnyx_from_number: str
    vcard_url: str
    coordinator_phone: str
    # --- Refactor-introduced (unified agent) ---
    agent_review_interval_min: int        # tick_agent_review cadence
    agent_nudge_budget_hours: int         # per-user min spacing between AGENT_NUDGE outbounds
    agent_nudge_per_opp_max: int          # lifetime cap on AGENT_NUDGE outbounds per opp
    agent_review_per_tick_max: int        # max user-facing nudges per review tick
    clarify_round_max: int                # auto-escalate after this many consecutive CLARIFY rounds
    clarify_user_24h_max: int             # soft cap: CLARIFY outbounds per user per 24h
    undo_window_min: int                  # how long after ACTION_RECEIPT the UNDO hotkey is honored
    offer_default_ttl_days: int           # default expires_at for OfferDoc when no latest_at given
    # --- Farmer-approval gate (window opps) ---
    proposal_auto_confirm_far_min: int    # auto-confirm after this many minutes when claim is >24h out
    proposal_auto_confirm_close_min: int  # auto-confirm after this many minutes when claim is <24h out


def load_settings() -> Settings:
    """Resolve all settings. Call inside a function invocation, not at import."""
    return Settings(
        # Plain env. Defaults select the OSS path (DeepInfra + Llama 3.3 70B).
        # Set LLM_PROVIDER=anthropic to fall back to Sonnet 4.6.
        # NOTE: with the unified-agent refactor, only model_tier="strong" is
        # actually used in production (run_agent and run_review_agent both
        # request the strong tier). LLM_MODEL_FAST is kept for adapter
        # compatibility and any future fast-path additions; we set both to
        # the same model so a misrouted call doesn't 404.
        llm_provider=_env("LLM_PROVIDER", "openai-compatible"),
        llm_model_fast=_env(
            "LLM_MODEL_FAST", "meta-llama/Llama-3.3-70B-Instruct"
        ),
        llm_model_strong=_env(
            "LLM_MODEL_STRONG", "meta-llama/Llama-3.3-70B-Instruct"
        ),
        llm_base_url=_env(
            "LLM_BASE_URL", "https://api.deepinfra.com/v1/openai"
        ),
        llm_api_key=_env("LLM_API_KEY") or _secret(LLM_API_KEY),
        vcard_url=_env(
            "VCARD_URL", "https://farm-friend-vashon.web.app/farmfriend.vcf"
        ),
        coordinator_phone=_env("COORDINATOR_PHONE", ""),
        # Refactor-introduced settings (unified agent). Defaults match the
        # design doc; override in .env.<project> if a pilot reveals a need.
        agent_review_interval_min=int(_env("AGENT_REVIEW_INTERVAL_MIN", "30")),
        agent_nudge_budget_hours=int(_env("AGENT_NUDGE_BUDGET_HOURS", "48")),
        agent_nudge_per_opp_max=int(_env("AGENT_NUDGE_PER_OPP_MAX", "2")),
        agent_review_per_tick_max=int(_env("AGENT_REVIEW_PER_TICK_MAX", "3")),
        clarify_round_max=int(_env("CLARIFY_ROUND_MAX", "2")),
        clarify_user_24h_max=int(_env("CLARIFY_USER_24H_MAX", "5")),
        undo_window_min=int(_env("UNDO_WINDOW_MIN", "5")),
        offer_default_ttl_days=int(_env("OFFER_DEFAULT_TTL_DAYS", "7")),
        # Proposal auto-confirm timers. Defaults from the rethink doc: 4h for
        # claims >24h out, 1h for claims <24h out. Tune from admin metrics once
        # we have real pilot data.
        proposal_auto_confirm_far_min=int(_env("PROPOSAL_AUTO_CONFIRM_FAR_MIN", "240")),
        proposal_auto_confirm_close_min=int(_env("PROPOSAL_AUTO_CONFIRM_CLOSE_MIN", "60")),
        # Deploy-time param
        telnyx_from_number=_env("TELNYX_FROM_NUMBER") or _string_param(TELNYX_FROM_NUMBER),
        # Secrets
        anthropic_api_key=_env("ANTHROPIC_API_KEY") or _secret(ANTHROPIC_API_KEY),
        telnyx_api_key=_env("TELNYX_API_KEY") or _secret(TELNYX_API_KEY),
        telnyx_public_key=_env("TELNYX_PUBLIC_KEY") or _secret(TELNYX_PUBLIC_KEY),
    )
