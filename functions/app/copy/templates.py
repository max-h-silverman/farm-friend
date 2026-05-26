"""SMS-facing copy. Keep wording here so it can be reviewed/A-B-tested
without touching business logic.

Functions render templates with `render(name, **kwargs)` returning a finalized
string. Templates are plain Python f-strings for now — Jinja is overkill for
single-paragraph SMS bodies.
"""

from __future__ import annotations


HELP_TEXT_VOLUNTEER = (
    "Farm Friend commands:\n"
    "YES — claim a shift (YES 2 for 2 slots)\n"
    "MAYBE — interested but not confirmed\n"
    "MUTE — silence followups on this shift only\n"
    "STOP <activity> — mute that activity (e.g. STOP weeding)\n"
    "STOP <farm> — mute a specific farm\n"
    "UNAVAILABLE <window> — silence everything for a while\n"
    "FLAG — report a wrong/confusing reply\n"
    "STOP — fully unsubscribe"
)

HELP_TEXT_FARMER = (
    "Farm Friend commands:\n"
    "Post a request in plain text (e.g. \"need 2 ppl tomorrow 10am to harvest greens\")\n"
    "STATUS — see your open posts and how they're filling\n"
    "EDIT — change a detail on an open post (just describe the change)\n"
    "CANCEL — cancel an open post\n"
    "INSIDER <phone> <name> — nominate a trusted volunteer\n"
    "FLAG — report a wrong/confusing reply\n"
    "HELP — show this list\n"
    "STOP — fully unsubscribe"
)

# Back-compat alias: callers that imported the old name continue to work; new
# code should prefer render_help(role) instead.
HELP_TEXT = HELP_TEXT_VOLUNTEER


def render_help(*, is_farmer: bool) -> str:
    return HELP_TEXT_FARMER if is_farmer else HELP_TEXT_VOLUNTEER


def render_intro_volunteer(*, name: str, vcard_url: str) -> str:
    return (
        f"Hi {name} — Farm Friend here, the volunteer coordinator for Vashon farms. "
        f"Save us as a contact: {vcard_url}\n"
        f"We'll text when a farm needs help. Reply YES to claim, MAYBE if uncertain, MUTE to skip. "
        f"HELP for commands, STOP to opt out."
    )


def render_intro_farmer(*, name: str, vcard_url: str) -> str:
    return (
        f"Hi {name} — Farm Friend here. Text us when you need volunteers and "
        f"we'll handle outreach.\n"
        f"Save us as a contact: {vcard_url}\n"
        f"Post in plain English (e.g. \"need 2 ppl tomorrow 10am to harvest greens\"). "
        f"STATUS, EDIT, CANCEL, HELP. STOP to opt out."
    )


def render_intro(*, name: str, vcard_url: str) -> str:
    """Back-compat shim. New code should use the role-specific renderers."""
    return render_intro_volunteer(name=name, vcard_url=vcard_url)


def render_shift_outreach(
    *,
    farm_name: str,
    activity: str,
    when_human: str,
    headcount: int,
    seats_remaining: int,
    requirements: str,
) -> str:
    people = "1 person" if seats_remaining == 1 else f"{seats_remaining} people"
    head = f"{farm_name} needs {people} for {activity} {when_human}."
    parts = [head]
    if requirements:
        parts.append(requirements)
    parts.append("YES to claim, MAYBE if uncertain, MUTE to skip.")
    return " ".join(parts)


def render_pickup_outreach(
    *,
    farm_name: str,
    produce: str,
    deadline_human: str,
    destination: str | None,
    vehicle_needed: bool | None,
) -> str:
    drop = f", drop at {destination}" if destination else ""
    parts = [f"{farm_name} has surplus to pick up {deadline_human}: {produce}{drop}."]
    if vehicle_needed:
        parts.append("Vehicle helpful.")
    parts.append("YES to claim, MAYBE if uncertain, MUTE to skip.")
    return " ".join(parts)


def render_claim_confirmed(*, farm_name: str, when_human: str, activity_or_produce: str) -> str:
    return (
        f"Confirmed: {farm_name}, {activity_or_produce}, {when_human}. "
        f"MUTE to stop followups on this one."
    )


def render_maybe_ack(*, farm_name: str) -> str:
    return (
        f"Noted as a MAYBE for {farm_name}. We'll hold a spot lightly; "
        f"reply YES to lock it in or MUTE to drop it."
    )


def render_shift_full(*, farm_name: str) -> str:
    return f"{farm_name} is filled. We'll hold you on the waitlist."


def render_pickup_already_claimed(*, farm_name: str) -> str:
    return f"{farm_name}'s pickup is already claimed. Thanks for the offer."


def render_mute_ack(*, what: str) -> str:
    return f"Muted: no more messages about {what}."


def render_stop_ack() -> str:
    return "Unsubscribed. We won't text you again. Reply START to rejoin."


def render_join_ack() -> str:
    return "Got your request — Max will review and get back to you shortly."


def render_post_event_checkin(*, when_human: str, kind_label: str) -> str:
    return (
        f"Yesterday's {kind_label} ({when_human}) — any issues? "
        f"Reply Y if all good, N if something went wrong."
    )


def render_post_event_followup() -> str:
    return "What happened? (no-show, wrong fit, other?)"


def render_flag_ack() -> str:
    return "Flagged for the coordinator. No more auto-replies on this thread until they review."


def render_fallback_ambiguous() -> str:
    return "Coordinator will follow up shortly."


def render_orphan_yes() -> str:
    return (
        "Got your YES but we're not sure which shift it's for. "
        "Coordinator will follow up shortly."
    )


def render_clarification(*, question: str) -> str:
    """Pass through the LLM's clarification question as-is. The question is
    expected to be the entire SMS — no framing prefix."""
    return question


def render_draft_complete(*, summary: str) -> str:
    return f"Quick confirmation: {summary}. Pinging insiders now."


def render_draft_cancelled() -> str:
    return "Cancelled. Text again when you're ready."


STALE_DRAFT_FLAG_REASON = (
    "Draft opportunity older than 2h still has missing required fields — "
    "farmer never finished the clarification dialog."
)


# ---- Farmer ↔ system: edits, cancels, status, milestones ------------------

def render_status_line(*, summary: str, filled: int, headcount: int, maybes: int) -> str:
    """One line of the STATUS response. The caller stitches lines together."""
    maybe_part = f" ({maybes} MAYBE)" if maybes else ""
    return f"{summary}: {filled}/{headcount} filled{maybe_part}"


def render_status_empty() -> str:
    return "No open posts."


def render_status_header(*, count: int) -> str:
    return "Your open posts:" if count > 1 else "Your open post:"


def render_edit_confirmed(*, summary: str) -> str:
    return f"Updated: {summary}. Confirmed volunteers notified."


def render_cancel_confirmed(*, summary: str) -> str:
    return f"Cancelled: {summary}. Confirmed volunteers notified."


def render_edit_headcount_too_low(*, currently_filled: int) -> str:
    return (
        f"{currently_filled} already confirmed — can't drop below that. "
        f"Reply with a higher number, or CANCEL to start over."
    )


def render_no_open_to_edit() -> str:
    return "No open posts to edit. Post a new one in plain text when ready."


def render_no_open_to_cancel() -> str:
    return "No open posts to cancel."


def render_which_opp_question(*, options: list[str]) -> str:
    """`options` is already rendered as 'plum harvest tomorrow' style strings."""
    numbered = "\n".join(f"{i+1}. {o}" for i, o in enumerate(options))
    return f"Which one?\n{numbered}\nReply with the number."


# ---- System → volunteers: change & cancel fan-out -------------------------

def render_opportunity_changed(*, farm_name: str, summary: str, what_changed: str) -> str:
    return (
        f"Update from {farm_name} on {summary}: {what_changed}. "
        f"Reply MUTE to drop, or YES to reconfirm."
    )


def render_opportunity_cancelled(*, farm_name: str, summary: str) -> str:
    return f"{farm_name} cancelled {summary}. Sorry for the change."


# ---- System → farmer: milestones -----------------------------------------

def render_first_claim(*, opp_summary: str, volunteer_name: str, filled: int, headcount: int) -> str:
    return f"First YES on {opp_summary}: {volunteer_name}. {filled}/{headcount} filled."


def render_tier_escalated(*, opp_summary: str) -> str:
    return f"No bites from insiders yet on {opp_summary}; opening to the broader pool."


def render_unfilled_at_start(*, opp_summary: str, filled: int, headcount: int) -> str:
    return (
        f"{opp_summary} is starting and only {filled}/{headcount} filled. "
        f"Letting you know in case you want to adjust."
    )
