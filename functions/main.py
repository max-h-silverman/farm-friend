"""Firebase Functions entrypoint.

This file is what the Firebase deploy tooling scans for decorated functions.
Keep it thin: register endpoints + schedules here, but put the actual logic in
the `app/` package so it's importable and testable on its own.
"""

from __future__ import annotations

from firebase_functions import https_fn, options, scheduler_fn
from firebase_functions.options import MemoryOption

from app.config import ALL_SECRETS
from app.flows import board_review as board_review_flow
from app.flows import confirmations as confirmations_flow
from app.flows import outreach as outreach_flow
from app.flows import post_event as post_event_flow
from app.flows import message_dispatch
from app.firebase_app import db  # noqa: F401 — triggers eager init at runtime (see firebase_app.py)

# Default region. us-west1 is closest to Vashon Island.
options.set_global_options(region="us-west1", memory=MemoryOption.MB_512)


# ----------------------------------------------------------------------------
# Inbound SMS webhook
# ----------------------------------------------------------------------------
@https_fn.on_request(
    secrets=ALL_SECRETS,
    min_instances=1,  # avoid cold-start retries from Telnyx
    timeout_sec=30,
)
def inbound_sms(req: https_fn.Request) -> https_fn.Response:
    """Telnyx webhook target. Verifies signature, normalizes, dispatches."""
    return message_dispatch.handle_inbound_webhook(req)


# ----------------------------------------------------------------------------
# Health check
# ----------------------------------------------------------------------------
@https_fn.on_request()
def health(req: https_fn.Request) -> https_fn.Response:
    return https_fn.Response("ok", status=200)


# ----------------------------------------------------------------------------
# Scheduled jobs
# ----------------------------------------------------------------------------
@scheduler_fn.on_schedule(
    schedule="every 5 minutes",
    secrets=ALL_SECRETS,
    timezone=scheduler_fn.Timezone("America/Los_Angeles"),
)
def tick_outreach(event: scheduler_fn.ScheduledEvent) -> None:
    """Scan open opportunities; escalate tiers whose ping window has elapsed."""
    outreach_flow.run_escalation_tick()


@scheduler_fn.on_schedule(
    schedule="every 15 minutes",
    secrets=ALL_SECRETS,
    timezone=scheduler_fn.Timezone("America/Los_Angeles"),
)
def tick_post_event(event: scheduler_fn.ScheduledEvent) -> None:
    """Send 'any issues?' check-ins for events whose checkin time has arrived."""
    post_event_flow.run_checkin_tick()


@scheduler_fn.on_schedule(
    schedule="every 30 minutes",
    secrets=ALL_SECRETS,
    timezone=scheduler_fn.Timezone("America/Los_Angeles"),
)
def tick_stale_drafts(event: scheduler_fn.ScheduledEvent) -> None:
    """Flag draft opportunities that never finished clarification."""
    outreach_flow.run_stale_draft_tick()


@scheduler_fn.on_schedule(
    schedule="every 15 minutes",
    secrets=ALL_SECRETS,
    timezone=scheduler_fn.Timezone("America/Los_Angeles"),
)
def tick_confirmations(event: scheduler_fn.ScheduledEvent) -> None:
    """Send pre-event confirmation reminders to volunteers with confirmed claims."""
    confirmations_flow.run_confirmation_tick()


@scheduler_fn.on_schedule(
    schedule="every 15 minutes",
    secrets=ALL_SECRETS,
    timezone=scheduler_fn.Timezone("America/Los_Angeles"),
)
def tick_unfilled_at_start(event: scheduler_fn.ScheduledEvent) -> None:
    """Notify farmers of shifts that started while still unfilled. Fires
    once per opportunity."""
    from app.flows import farmer_ops as _farmer_ops
    from app.messaging import get_messaging_provider
    _farmer_ops.run_unfilled_at_start_tick(get_messaging_provider())


@scheduler_fn.on_schedule(
    schedule="every 30 minutes",
    secrets=ALL_SECRETS,
    timezone=scheduler_fn.Timezone("America/Los_Angeles"),
)
def tick_agent_review(event: scheduler_fn.ScheduledEvent) -> None:
    """Proactive coordinator-on-the-board review tick. Runs the unified agent
    in review mode against current board state. Quiet-hours-gated. See
    docs/refactor-unified-agent.md §"Proactive review"."""
    board_review_flow.run_board_review_tick()


# Admin callable functions are registered in app/admin/callables.py and
# re-exported here by name so the Firebase deploy tooling sees them.
from app.admin.callables import (  # noqa: E402
    approve_pending_user,
    suspend_user,
    resolve_flag,
    set_admin_claim,
    simulate_inbound_sms,
    update_farm_defaults,
    update_user_availability,
)

__all__ = [
    "inbound_sms",
    "health",
    "tick_outreach",
    "tick_post_event",
    "tick_stale_drafts",
    "tick_unfilled_at_start",
    "tick_confirmations",
    "tick_agent_review",
    "approve_pending_user",
    "suspend_user",
    "resolve_flag",
    "set_admin_claim",
    "simulate_inbound_sms",
    "update_farm_defaults",
    "update_user_availability",
]
