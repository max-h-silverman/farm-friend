"""SMS-facing copy. Keep wording here so it can be reviewed/A-B-tested
without touching business logic.

Functions render templates with `render(name, **kwargs)` returning a finalized
string. Templates are plain Python f-strings for now — Jinja is overkill for
single-paragraph SMS bodies.
"""

from __future__ import annotations


HELP_TEXT = (
    "Farm Friend commands:\n"
    "YES — claim a shift (YES 2 for 2 slots)\n"
    "STOP <activity> — mute that activity (e.g. STOP weeding)\n"
    "STOP <farm> — mute a specific farm\n"
    "UNAVAILABLE <window> — silence everything for a while\n"
    "MUTE — silence followups on this shift only\n"
    "FLAG — report a wrong/confusing reply\n"
    "STOP — fully unsubscribe"
)


def render_intro(*, name: str, vcard_url: str) -> str:
    return (
        f"Hi {name}! This is Farm Friend, the volunteer coordinator for Vashon farms. "
        f"Save us as a contact so we don't look like a random number: {vcard_url}\n"
        f"We only text about volunteer shifts. Reply HELP for commands or STOP to opt out."
    )


def render_shift_outreach(
    *,
    farm_name: str,
    activity: str,
    when_human: str,
    headcount: int,
    seats_remaining: int,
    requirements: str,
) -> str:
    seats_text = "1 spot" if seats_remaining == 1 else f"{seats_remaining} spots"
    parts = [
        f"{farm_name} needs help: {activity} on {when_human}.",
        f"{seats_text} open (need {headcount}).",
    ]
    if requirements:
        parts.append(requirements)
    parts.append("Reply YES to claim, MUTE to skip this one.")
    return " ".join(parts)


def render_pickup_outreach(
    *,
    farm_name: str,
    produce: str,
    deadline_human: str,
    destination: str | None,
    vehicle_needed: bool | None,
) -> str:
    parts = [f"{farm_name} has surplus to pick up: {produce}."]
    parts.append(f"Needs to be picked up by {deadline_human}.")
    if destination:
        parts.append(f"Drop at: {destination}.")
    if vehicle_needed:
        parts.append("(vehicle/truck helpful)")
    parts.append("Reply YES to claim, MUTE to skip.")
    return " ".join(parts)


def render_claim_confirmed(*, farm_name: str, when_human: str, activity_or_produce: str) -> str:
    return (
        f"You're confirmed for {farm_name} — {activity_or_produce}, {when_human}. "
        f"Thanks! Reply MUTE to stop further messages about this one."
    )


def render_shift_full(*, farm_name: str) -> str:
    return f"Thanks! {farm_name} already filled this shift. We'll keep you on the waitlist."


def render_pickup_already_claimed(*, farm_name: str) -> str:
    return f"Thanks — {farm_name}'s pickup is already claimed. Appreciate the offer."


def render_mute_ack(*, what: str) -> str:
    return f"OK — you won't get further messages about {what}."


def render_stop_ack() -> str:
    return (
        "You've been unsubscribed from Farm Friend. We won't text you again. "
        "Reply START anytime to rejoin."
    )


def render_join_ack() -> str:
    return (
        "Thanks for your interest in Farm Friend! Max (the coordinator) will review "
        "and get back to you shortly."
    )


def render_post_event_checkin(*, when_human: str, kind_label: str) -> str:
    return (
        f"Quick check on yesterday's {kind_label} ({when_human}): any issues? "
        f"Reply Y if all good, N if something went wrong."
    )


def render_post_event_followup() -> str:
    return "Sorry to hear it. Briefly, what happened? (no-show, wrong fit, other?)"


def render_flag_ack() -> str:
    return (
        "Got it — flagged for the coordinator to review. No more auto-replies on this "
        "thread until they check in."
    )


def render_fallback_ambiguous() -> str:
    return (
        "Thanks for the message — let me check with the coordinator and get back to you "
        "shortly."
    )
