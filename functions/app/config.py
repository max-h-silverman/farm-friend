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

LLM defaults: the code default is `mistral-deepinfra` (Mistral Small 3.2 24B, a
pragmatic open-weight option). Real Ai2 OLMo remains the constitution's #1
ethical benchmark but is NOT currently servable by any hosted provider (no live
OpenRouter endpoint for the instruct slug; DeepInfra substitutes Gemma) — the
only way to run it today is self-hosting (`LLM_PROVIDER=olmo`). Anthropic Sonnet
4.6 is the fallback (`LLM_PROVIDER=anthropic`). The active model is configuration,
never a product assumption — see CLAUDE.md → "Project Constitution" and "Stack →
LLM". The set of selectable providers lives in OPENAI_COMPATIBLE_PROVIDERS + the
branches in load_settings() below; that is the single source of truth for routing.
"""

from __future__ import annotations

import os
from dataclasses import dataclass

from firebase_functions.params import SecretParam, StringParam

# Secrets — set via `firebase functions:secrets:set`
# LLM_API_KEY is the generic OSS-provider key (self-hosted / DeepInfra / etc.).
# OPENROUTER_API_KEY is the key for the olmo-openrouter path (currently
# non-functional — see the OpenRouter note below); it falls back to LLM_API_KEY
# if unset so a single key can serve both if desired.
# ANTHROPIC_API_KEY remains bound for the optional legacy provider.
LLM_API_KEY = SecretParam("LLM_API_KEY")
OPENROUTER_API_KEY = SecretParam("OPENROUTER_API_KEY")
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
    OPENROUTER_API_KEY,
    ANTHROPIC_API_KEY,
    TELNYX_API_KEY,
    TELNYX_PUBLIC_KEY,
    SMOKE_TEST_TOKEN,
]

# --- OLMo model IDs, per provider ---
# OpenRouter uses lowercase slugs; self-hosted vLLM/SGLang uses the HF repo id.
OLMO_OPENROUTER_MODEL = "allenai/olmo-3.1-32b-instruct"
OLMO_SELFHOST_COORDINATOR_MODEL = "allenai/Olmo-3.1-32B-Instruct"
OLMO_SELFHOST_CLASSIFIER_MODEL = "allenai/Olmo-3-7B-Instruct"
DEFAULT_OLMO_BASE_URL = "http://localhost:8000/v1"

# --- OpenRouter OLMo path — NOT CURRENTLY SERVABLE (verified 2026-05-31) ---
# OLMo is NOT reachable via any hosted provider right now:
#   - DeepInfra silently substitutes Gemma for an OLMo id (see DeepInfra note
#     below) — OLMo never actually runs there.
#   - OpenRouter lists the `allenai/olmo-3.1-32b-instruct` slug but with ZERO
#     live provider endpoints: a real call returns HTTP 404 "No endpoints found".
#     The only OLMo with a live OpenRouter provider is `allenai/olmo-3-32b-think`
#     (a Think variant — verbose reasoning + latency we deliberately avoid for
#     concise SMS/JSON coordination; see docs/architecture.md "LLM portability").
# OLMo remains the constitution's #1 ethical benchmark, but as of now the only
# way to actually run it is self-hosting (`LLM_PROVIDER=olmo`, below). The
# `olmo-openrouter` branch is kept wired so it works the moment a provider lists
# an OLMo *instruct* model again — until then it will 404. Do NOT set it as the
# pilot default. Key comes from OPENROUTER_API_KEY (falls back to LLM_API_KEY).
DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"

# --- DeepInfra (generic OpenAI-compatible) ---
# Retained for non-OLMo OSS models that DeepInfra genuinely serves (Llama, Gemma,
# Mistral). Do NOT point an OLMo model id here — it silently substitutes Gemma
# (see above); the Gemma substitution is OLMo-specific, other open weights serve
# correctly.
DEFAULT_DEEPINFRA_BASE_URL = "https://api.deepinfra.com/v1/openai"

# --- Mistral via DeepInfra (pilot trial) ---
# Mistral Small 3.2 (24B) is a pragmatic, non-dominant open-weight option (see
# CLAUDE.md → Project Constitution). DeepInfra serves it correctly under its HF
# repo id. `LLM_PROVIDER=mistral-deepinfra` selects this with no further tuning;
# key comes from LLM_API_KEY. Portable: the same model id works on any neutral
# OpenAI-compatible provider by switching to `openai-compatible` + LLM_BASE_URL.
MISTRAL_DEEPINFRA_MODEL = "mistralai/Mistral-Small-3.2-24B-Instruct-2506"
DEFAULT_OPENAI_COMPAT_BASE_URL = DEFAULT_DEEPINFRA_BASE_URL
DEFAULT_OPENAI_COMPAT_MODEL = "meta-llama/Llama-3.3-70B-Instruct"
DEFAULT_ANTHROPIC_FAST_MODEL = "claude-haiku-4-5-20251001"
DEFAULT_ANTHROPIC_STRONG_MODEL = "claude-sonnet-4-6"

# Providers that speak the OpenAI `/v1/chat/completions` protocol and route
# through the OpenAICompatibleAdapter. Anthropic is the only non-member.
OPENAI_COMPATIBLE_PROVIDERS = frozenset(
    {"openai-compatible", "olmo", "olmo-openrouter", "mistral-deepinfra"}
)


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
    llm_timeout_ms: int
    llm_temperature: float
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
    agent_review_admin_only: bool         # pilot safety: force ALL review proposals to admin worklist
    agent_window_posts_enabled: bool      # pilot safety: when False, strip agent-emitted window_end_at (single-day posts only)
    day_voting_enabled: bool              # candidate-day voting (docs/preferred-day-voting.md); kill-switch, default ON
    clarify_round_max: int                # auto-escalate after this many consecutive CLARIFY rounds
    clarify_user_24h_max: int             # soft cap: CLARIFY outbounds per user per 24h
    offer_default_ttl_days: int           # default expires_at for OfferDoc when no latest_at given
    # --- Farmer-approval gate (window opps) ---
    proposal_auto_confirm_far_min: int    # auto-confirm after this many minutes when claim is >24h out
    proposal_auto_confirm_close_min: int  # auto-confirm after this many minutes when claim is <24h out


def load_settings() -> Settings:
    """Resolve all settings. Call inside a function invocation, not at import."""
    llm_provider = _env("LLM_PROVIDER", "mistral-deepinfra")
    if llm_provider == "anthropic":
        default_coordinator_model = DEFAULT_ANTHROPIC_STRONG_MODEL
        default_classifier_model = DEFAULT_ANTHROPIC_FAST_MODEL
    elif llm_provider == "openai-compatible":
        default_coordinator_model = DEFAULT_OPENAI_COMPAT_MODEL
        default_classifier_model = DEFAULT_OPENAI_COMPAT_MODEL
    elif llm_provider == "mistral-deepinfra":
        # Mistral Small 3.2 (24B) on DeepInfra — one tier serves both for the
        # pilot trial; no separate lightweight model configured yet.
        default_coordinator_model = MISTRAL_DEEPINFRA_MODEL
        default_classifier_model = MISTRAL_DEEPINFRA_MODEL
    elif llm_provider == "olmo-openrouter":
        # OLMo via OpenRouter — lowercase slug. CURRENTLY NON-FUNCTIONAL: the
        # instruct slug has no live OpenRouter endpoint and 404s (see note above).
        # Branch kept so it works if a provider lists OLMo instruct again.
        default_coordinator_model = OLMO_OPENROUTER_MODEL
        default_classifier_model = OLMO_OPENROUTER_MODEL
    else:
        # `olmo` = self-hosted vLLM/SGLang; uses the HF repo ids.
        default_coordinator_model = OLMO_SELFHOST_COORDINATOR_MODEL
        default_classifier_model = OLMO_SELFHOST_CLASSIFIER_MODEL

    coordinator_model = _env("LLM_MODEL", default_coordinator_model)
    classifier_model = _env("LLM_CLASSIFIER_MODEL", default_classifier_model)

    # API key resolution. On the OpenRouter path, prefer OPENROUTER_API_KEY
    # (env or secret) and fall back to LLM_API_KEY so a single key can serve
    # both. Other OpenAI-compatible providers use LLM_API_KEY directly.
    if llm_provider == "olmo-openrouter":
        llm_api_key = (
            _env("OPENROUTER_API_KEY")
            or _secret(OPENROUTER_API_KEY)
            or _env("LLM_API_KEY")
            or _secret(LLM_API_KEY)
        )
    else:
        llm_api_key = _env("LLM_API_KEY") or _secret(LLM_API_KEY)
    if llm_provider == "olmo-openrouter":
        # OpenRouter base URL. Note: the OLMo instruct slug currently has no live
        # endpoint here and will 404 (see the OpenRouter note near the top).
        default_base_url = DEFAULT_OPENROUTER_BASE_URL
    elif llm_provider == "olmo":
        default_base_url = DEFAULT_OLMO_BASE_URL
    elif llm_provider in ("openai-compatible", "mistral-deepinfra"):
        default_base_url = DEFAULT_OPENAI_COMPAT_BASE_URL
    else:
        default_base_url = ""
    return Settings(
        # Plain env. Defaults select the mistral-deepinfra path (set above).
        # Whatever the provider, we use non-Think instruct models for concise
        # SMS coordination output. Overrides:
        # - LLM_MODEL / LLM_MODEL_STRONG override the coordinator (strong) tier.
        # - LLM_CLASSIFIER_MODEL / LLM_MODEL_FAST override the lightweight tier.
        # - LLM_PROVIDER=openai-compatible for any other OpenAI-compatible host.
        # - LLM_PROVIDER=anthropic selects the Anthropic adapter (fallback).
        # - LLM_PROVIDER=olmo (self-host) is the only way to run real OLMo today.
        llm_provider=llm_provider,
        llm_model_fast=_env(
            "LLM_MODEL_FAST", classifier_model
        ),
        llm_model_strong=_env(
            "LLM_MODEL_STRONG", coordinator_model
        ),
        llm_base_url=_env(
            "LLM_BASE_URL", default_base_url
        ),
        llm_api_key=llm_api_key,
        llm_timeout_ms=int(_env("LLM_TIMEOUT_MS", "20000")),
        llm_temperature=float(_env("LLM_TEMPERATURE", "0.1")),
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
        # The proactive review tick coordinates autonomously (sends user-facing
        # nudges), per "full functionality at small scale" (2026-06-01). The
        # flag is RETAINED as an emergency kill-switch: set
        # AGENT_REVIEW_ADMIN_ONLY=1 to route every proposal back to the admin
        # worklist if the coordinator misbehaves in production. The day-voting
        # carve-out (board_review) lets day-vote farmer nudges go direct even
        # when this is on. Default OFF (autonomous). See docs/preferred-day-voting.md.
        agent_review_admin_only=_env("AGENT_REVIEW_ADMIN_ONLY", "0").lower()
        in {"1", "true", "yes"},
        # Multi-day window posts are ON (full functionality at small scale).
        # Flag RETAINED as a kill-switch: set AGENT_WINDOW_POSTS_ENABLED=0 to
        # strip agent-emitted window_end_at (single-day posts only) if the
        # window subsystem misbehaves. See docs/preferred-day-voting.md.
        agent_window_posts_enabled=_env("AGENT_WINDOW_POSTS_ENABLED", "1").lower()
        not in {"0", "false", "no"},
        # Candidate-day voting (docs/preferred-day-voting.md). ON by default;
        # kill-switch via DAY_VOTING_ENABLED=0 (agent stops emitting
        # candidate-day opps; dispatch treats day tokens as today).
        day_voting_enabled=_env("DAY_VOTING_ENABLED", "1").lower()
        not in {"0", "false", "no"},
        clarify_round_max=int(_env("CLARIFY_ROUND_MAX", "2")),
        clarify_user_24h_max=int(_env("CLARIFY_USER_24H_MAX", "5")),
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


def pilot_readiness_warnings(settings: Settings | None = None) -> list[str]:
    """Return a list of human-readable warnings for config that must be set
    before real users rely on the system.

    Surfaced by the `health` endpoint so a deploy can be sanity-checked, and
    logged at webhook startup. Empty list means pilot-ready on these checks.
    These are deliberately about *operational safety*, not feature config.
    """
    s = settings or load_settings()
    warnings: list[str] = []
    if not s.coordinator_phone:
        warnings.append(
            "COORDINATOR_PHONE is unset — IMMEDIATE escalations (injury/safety) "
            "will be flagged but NOT texted to the coordinator in real time."
        )
    if not s.telnyx_from_number or s.telnyx_from_number == "+15555550100":
        warnings.append(
            "TELNYX_FROM_NUMBER is unset or still the placeholder — outbound SMS "
            "will fail or originate from the wrong number."
        )
    if s.llm_provider in OPENAI_COMPATIBLE_PROVIDERS and not s.llm_base_url:
        warnings.append("LLM_BASE_URL is empty for an OpenAI-compatible provider.")
    return warnings
