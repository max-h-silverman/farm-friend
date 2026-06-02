"""SMS-facing copy. Keep wording here so it can be reviewed/A-B-tested
without touching business logic.

Functions render templates with `render(name, **kwargs)` returning a finalized
string. Templates are plain Python f-strings for now — Jinja is overkill for
single-paragraph SMS bodies.

A2P 10DLC compliance: `render_help`, `render_stop_ack`, and `render_join_ack`
carry the required HELP/STOP/rates/frequency disclosures. Keep wording aligned
with the registered campaign and docs/sms-compliance-requirements.md.
"""

from __future__ import annotations


# The carrier-approved help reply. Single source of truth — both volunteers
# and farmers get this same text.
HELP_TEXT_COMPLIANCE = (
    "Farm Friend Vashon: Please reach out to max@myco.software or visit "
    "https://myco.software/farm-friend-vashon.html for help. Reply STOP to "
    "unsubscribe. Msg&data rates may apply."
)

# Back-compat aliases. Existing callsites for HELP_TEXT_VOLUNTEER and
# HELP_TEXT_FARMER keep working; both resolve to the compliance text.
HELP_TEXT_VOLUNTEER = HELP_TEXT_COMPLIANCE
HELP_TEXT_FARMER = HELP_TEXT_COMPLIANCE
HELP_TEXT = HELP_TEXT_COMPLIANCE


def render_help(*, is_farmer: bool = False) -> str:
    """Compliance-mandated reply. Same text for all roles — do NOT branch."""
    return HELP_TEXT_COMPLIANCE


def render_intro_volunteer(*, name: str, vcard_url: str) -> str:
    return (
        f"Hi {name} — Farm Friend Vashon here, the volunteer coordinator for "
        f"Vashon farms. Save us: {vcard_url}\n"
        f"We'll text when farms need help. YES claims, MAYBE if unsure, MUTE skips. "
        f"You can text days/times or work that fits. More detail helps, but rough answers are fine. "
        f"HELP for commands, STOP to opt out."
    )


def render_intro_farmer(*, name: str, vcard_url: str) -> str:
    return (
        f"Hi {name} — Farm Friend Vashon here. Text us when you need volunteers and "
        f"we'll handle outreach.\n"
        f"Save us: {vcard_url}\n"
        f"Post in plain English. More detail helps, but rough is OK: "
        f"day(s), time, length, people needed, and work type "
        f"(e.g. \"need 2 ppl tomorrow 10am for 3 hrs harvest\"). "
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
    head = f"Farm Friend Vashon: {farm_name} needs {people} for {activity} {when_human}."
    parts = [head]
    if requirements:
        parts.append(requirements)
    parts.append(
        "Reply YES to confirm, MAYBE if maybe available, MUTE to skip, "
        "or STOP to opt out."
    )
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
    parts = [
        f"Farm Friend Vashon: {farm_name} has surplus to pick up "
        f"{deadline_human}: {produce}{drop}."
    ]
    if vehicle_needed:
        parts.append("Vehicle helpful.")
    parts.append(
        "Reply YES to confirm, MAYBE if maybe available, MUTE to skip, "
        "or STOP to opt out."
    )
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
    """Compliance-mandated opt-out confirmation. Do NOT change without
    re-registering the Telnyx campaign."""
    return (
        "Farm Friend Vashon: You're unsubscribed and will receive no further "
        "messages. Reply JOIN to request to rejoin."
    )


def render_join_ack() -> str:
    """Compliance-mandated opt-in confirmation. Sent on JOIN/START.

    The coordinator-approval note can follow as a SECOND SMS (so the
    compliance language stays focused) — handled by the JOIN dispatch path.
    Keep this aligned with the Telnyx campaign registration.
    """
    return (
        "Farm Friend Vashon: You're signed up for local farm help and surplus "
        "pickup texts. We'll text only about this program, usually 0-6/week. "
        "Msg&data rates may apply. Texting is optional. Reply HELP for help "
        "or STOP to opt out."
    )


def render_join_pending_admin_note() -> str:
    """Follow-up SMS sent after the compliance opt-in text when the JOIN
    requester needs admin approval. Kept separate so the compliance copy
    above stays verbatim."""
    return "The Farm Friend team will review and approve your request shortly."


def render_confirmation_reminder_shift(
    *, farm_name: str, activity: str, when_human: str
) -> str:
    # DROP is a deterministic reminder-reply hotkey. We avoid CANCEL here
    # because CANCEL is a carrier opt-out keyword.
    return (
        f"Farm Friend Vashon: Reminder — you're scheduled to help with {activity} "
        f"at {farm_name} {when_human}. Reply DROP if you can't make it."
    )


def render_confirmation_reminder_pickup(
    *, farm_name: str, produce: str, deadline_human: str
) -> str:
    return (
        f"Farm Friend Vashon: Reminder — you're picking up {produce} from "
        f"{farm_name} {deadline_human}. Reply DROP if you can't make it."
    )


def render_volunteer_dropped_to_farmer(
    *, opp_summary: str, volunteer_name: str, filled: int, headcount: int
) -> str:
    return (
        f"{volunteer_name} dropped {opp_summary}. Now {filled}/{headcount} filled — "
        f"re-pinging the pool."
    )


def render_volunteer_drop_ack() -> str:
    return "Got it — you're off the list. Thanks for letting us know."


def render_post_event_checkin(*, when_human: str, kind_label: str) -> str:
    return (
        f"Yesterday's {kind_label} ({when_human}) — any issues? "
        f"Reply Y if all good, N if something went wrong."
    )


def render_post_event_followup() -> str:
    return "What happened? (no-show, wrong fit, other?)"


def render_flag_ack() -> str:
    """Compliance-mandated FLAG confirmation."""
    return (
        "Farm Friend Vashon: Thanks. This thread has been flagged for review, "
        "and automated replies are paused. Reply STOP to unsubscribe."
    )


def render_fallback_ambiguous() -> str:
    return "Farm Friend Vashon: Coordinator will follow up shortly."


def render_stuck_handoff() -> str:
    """User-facing copy when the system can't make progress on a message and is
    handing off to a person — agent call failure, the clarification cap, or an
    unexpected/unknown agent output. Distinct from `render_fallback_ambiguous`
    (the neutral handoff used for a real ESCALATE like injury/payment, where the
    agent usually supplies its own contextual reply): this one acknowledges the
    system is the one that got stuck, so the user isn't left in silence."""
    return (
        "Farm Friend Vashon: Sorry, I'm having trouble with this one — a VIGA "
        "coordinator will be in touch shortly."
    )


def render_orphan_yes() -> str:
    return (
        "Farm Friend Vashon: Got your YES but we're not sure which shift it's "
        "for. Coordinator will follow up shortly."
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


# ---- Window-opp proposals + farmer-approval gate -------------------------

def render_proposal_to_farmer(
    *,
    volunteer_name: str,
    day_human: str,
    opp_summary: str,
    token: str,
) -> str:
    """The SMS that goes to the farmer when a volunteer claims a specific day
    on a window opp. The farmer decides; volunteer is waiting.

    `day_human` is the resolved day (e.g. "Wed Jun 4 morning"); `opp_summary`
    is short ("weeding at Three Cedars"); `token` is the 4-letter ACCEPT/DECLINE
    target.
    """
    return (
        f"Farm Friend Vashon: {volunteer_name} wants {day_human} for your "
        f"{opp_summary}. Reply ACCEPT {token} or DECLINE {token}."
    )


def render_proposal_accepted_to_volunteer(
    *, farm_name: str, day_human: str, activity_or_produce: str
) -> str:
    """Volunteer sees this when the farmer ACCEPTs their proposal."""
    return (
        f"You're confirmed for {activity_or_produce} at {farm_name}, "
        f"{day_human}. MUTE to stop followups on this one."
    )


def render_proposal_declined_to_volunteer(
    *, farm_name: str, day_human: str
) -> str:
    """Volunteer sees this when the farmer DECLINEs their proposal. Non-blaming."""
    return (
        f"{farm_name} can't host you on {day_human} — schedule got fuller "
        f"than expected. Reply with another day if you'd like to try."
    )


def render_proposal_auto_confirmed_to_farmer(
    *, volunteer_name: str, day_human: str, opp_summary: str
) -> str:
    """Farmer sees this when a proposal auto-confirmed because they didn't
    decide in time."""
    return (
        f"Farm Friend Vashon: auto-accepted {volunteer_name} for "
        f"{day_human} on your {opp_summary} — you didn't reply in time. "
        f"Reply here if you need to reverse it."
    )


def render_window_outreach(
    *,
    farm_name: str,
    activity: str,
    window_human: str,
    headcount_open: bool,
    seats_remaining: int,
    requirements: str,
) -> str:
    """Outreach copy for a window opp. Mentions the window range and instructs
    the volunteer to reply with a specific day token."""
    if headcount_open:
        people = "any number of helpers"
    else:
        people = "1 person" if seats_remaining == 1 else f"{seats_remaining} people"
    head = (
        f"Farm Friend Vashon: {farm_name} needs {people} for {activity}, "
        f"{window_human}."
    )
    parts = [head]
    if requirements:
        parts.append(requirements)
    parts.append(
        "Reply YES <day> (e.g. YES WED), MAYBE if maybe available, MUTE to "
        "skip, or STOP to opt out."
    )
    return " ".join(parts)


def render_candidate_day_outreach(
    *,
    farm_name: str,
    activity: str,
    days: list[str],
    requirements: str,
) -> str:
    """Outreach for a candidate-day VOTING opp (docs/preferred-day-voting.md):
    list the workable days (with dates, optional "(farmer's pick)" hint) and ask
    the volunteer to vote with a day. Broadcast outreach → carries the STOP line."""
    day_list = "; ".join(days) if days else "a few days"
    head = f"Farm Friend Vashon: {farm_name} needs help with {activity}."
    parts = [head, f"Possible days: {day_list}."]
    if requirements:
        parts.append(requirements)
    parts.append(
        "Reply with a day (e.g. WED), ANY for any of them, MAYBE if unsure, "
        "MUTE to skip, or STOP to opt out."
    )
    return " ".join(parts)
