"""Deterministic hotkey parser.

Runs BEFORE any LLM call. The vast majority of inbound messages match one of
these patterns; matching here avoids paying the LLM cost and gives crisp,
predictable behavior for the common path. Only messages that don't match get
forwarded to the unified agent.

Parser is intentionally permissive on case/whitespace/punctuation; SMS users
type messily. We strip a single trailing period and treat "Yes!" or "yes "
the same as "YES".

Returns a `HotkeyMatch` (with structured payload) or `None`.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime

from app.repos.models import CANONICAL_ACTIVITIES, IntentLabel


@dataclass(frozen=True, slots=True)
class HotkeyMatch:
    intent: IntentLabel
    # Payload depends on intent. Documented per-intent below.
    payload: dict[str, object]
    confidence: float = 1.0


_YES_RE = re.compile(r"^\s*y(es)?(?:\s+(\d+))?\s*[!\.]?\s*$", re.IGNORECASE)
# YES <day-list> for window opps. The day list is captured raw; dispatch
# resolves labels against the opp's window. Supported labels (case-insensitive):
#   - weekday abbrevs MON/TUE/WED/THU/FRI/SAT/SUN (optional full forms)
#   - TODAY / TOMORROW
#   - month-day patterns: "JUN 4", "6/4"
# Separators: comma, " AND ", " & ", optional whitespace.
_YES_DAY_LIST_RE = re.compile(
    r"^\s*y(?:es)?\s+([^\s].+?)\s*[!\.]?\s*$", re.IGNORECASE,
)
_DAY_TOKEN_RE = re.compile(
    r"(?:"
    r"mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:r|rs|rsday)?|"
    r"fri(?:day)?|sat(?:urday)?|sun(?:day)?|"
    r"today|tomorrow|"
    r"(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)\s*\d{1,2}|"
    r"\d{1,2}/\d{1,2}"
    r")",
    re.IGNORECASE,
)
_MAYBE_RE = re.compile(r"^\s*maybe\s*[!\.\?]?\s*$", re.IGNORECASE)
_HELP_RE = re.compile(r"^\s*(help|info)\s*[!\.\?]?\s*$", re.IGNORECASE)
_STATUS_RE = re.compile(r"^\s*status\s*[!\.\?]?\s*$", re.IGNORECASE)
_CANCEL_RE = re.compile(r"^\s*cancel\s*[!\.]?\s*$", re.IGNORECASE)
_DROP_RE = re.compile(r"^\s*drop\s*[!\.]?\s*$", re.IGNORECASE)
_STOP_PLAIN_RE = re.compile(r"^\s*(stop|unsubscribe|quit|end)\s*[!\.]?\s*$", re.IGNORECASE)
_FLAG_RE = re.compile(r"^\s*flag\b.*$", re.IGNORECASE)
_JOIN_RE = re.compile(r"^\s*(join|start)\s*[!\.]?\s*$", re.IGNORECASE)
_MUTE_RE = re.compile(r"^\s*(mute|pass|skip)\s*[!\.]?\s*$", re.IGNORECASE)
_UNDO_RE = re.compile(r"^\s*undo\s*[!\.]?\s*$", re.IGNORECASE)
_PAUSE_RE = re.compile(r"^\s*pause\s*[!\.]?\s*$", re.IGNORECASE)
_RESUME_RE = re.compile(r"^\s*resume\s*[!\.]?\s*$", re.IGNORECASE)
# Farmer-approval gate on window-opp PROPOSED claims. Each proposal-to-farmer
# SMS includes a 4-letter token; the farmer replies `ACCEPT <TOKEN>` or
# `DECLINE <TOKEN>` to act on that specific proposal. See
# docs/agent-architecture-rethink.md §"Farmer approval gate".
_ACCEPT_RE = re.compile(
    r"^\s*accept\s+([A-Z]{4})\s*[!\.]?\s*$", re.IGNORECASE,
)
_DECLINE_RE = re.compile(
    r"^\s*decline\s+([A-Z]{4})\s*[!\.]?\s*$", re.IGNORECASE,
)
# Confirmation tokens drafted by the unified agent. Exactly 4 letters
# (uppercase A–Z, no digits, no hyphens) — i.e. a real word or a clear
# abbreviation. Hotkey precedence is handled in parse() so the explicit
# hotkey words above always win over this generic pattern. (Several
# 4-letter words collide with reserved hotkeys — STOP, QUIT, MUTE, FLAG,
# HELP, INFO, JOIN, UNDO — those are excluded by precedence order above
# and by _is_valid_token below.)
_TOKEN_RE = re.compile(r"^\s*([A-Z]{4})\s*[!\.]?\s*$")
# Affirmative variants accepted as a match for a live PENDING_CONFIRMATION.
_AFFIRMATIVE = frozenset({"YES", "OK", "OKAY", "SURE", "CONFIRM", "GO", "GO AHEAD", "YEP", "YEAH"})
_POST_EVENT_Y_RE = re.compile(r"^\s*y(es)?\s*[!\.]?\s*$", re.IGNORECASE)
_POST_EVENT_N_RE = re.compile(r"^\s*n(o)?\s*[!\.]?\s*$", re.IGNORECASE)
_STOP_ACTIVITY_RE = re.compile(r"^\s*stop\s+(.+?)\s*[!\.]?\s*$", re.IGNORECASE)
_UNAVAILABLE_RE = re.compile(r"^\s*unavailable(?:\s+(.+?))?\s*[!\.]?\s*$", re.IGNORECASE)
_INSIDER_RE = re.compile(
    r"^\s*insider\s+(?P<phone>\+?[\d\s\-\(\)]{7,})(?:\s+(?P<name>.+))?\s*$",
    re.IGNORECASE,
)


def parse(
    body: str,
    *,
    expecting_post_event_reply: bool = False,
    last_outbound_was_clarify: bool = False,
    known_activity_slugs: tuple[str, ...] = CANONICAL_ACTIVITIES,
    known_farm_names: tuple[str, ...] = (),
) -> HotkeyMatch | None:
    """Try to match `body` against a hotkey. Return None if nothing matches.

    `expecting_post_event_reply` flips how a bare "Y"/"N" is interpreted —
    in that context it's a check-in answer, not a claim/decline.

    `last_outbound_was_clarify` suppresses the YES-as-claim and MAYBE-as-soft-
    interest matches, so a YES reply to a yes/no-phrased clarify falls through
    to the agent (which will see the YES inbound + the CLARIFY context and
    promote to a confirm). Without this, YES/OK after a clarify would route
    to the claim hotkey and try to claim the opp the clarify was about. All
    other hotkeys (STOP/HELP/FLAG/MUTE/etc.) still match — compliance
    keywords must always work.
    """
    text = body.strip()
    if not text:
        return None

    # Post-event Y/N takes precedence when in that conversational mode.
    if expecting_post_event_reply:
        if _POST_EVENT_Y_RE.match(text):
            return HotkeyMatch(IntentLabel.POST_EVENT_OK, {})
        if _POST_EVENT_N_RE.match(text):
            return HotkeyMatch(IntentLabel.POST_EVENT_ISSUE, {})

    # FLAG must beat STOP because "flag this" shouldn't unsubscribe.
    if _FLAG_RE.match(text):
        reason = text[4:].strip(" :,-")
        return HotkeyMatch(IntentLabel.FLAG, {"reason": reason})

    if _HELP_RE.match(text):
        return HotkeyMatch(IntentLabel.HELP, {})

    if _JOIN_RE.match(text):
        return HotkeyMatch(IntentLabel.JOIN, {})

    if _MUTE_RE.match(text):
        return HotkeyMatch(IntentLabel.MUTE, {})

    if _STATUS_RE.match(text):
        return HotkeyMatch(IntentLabel.STATUS, {})

    if _CANCEL_RE.match(text):
        return HotkeyMatch(IntentLabel.CANCEL, {})

    if _DROP_RE.match(text):
        return HotkeyMatch(IntentLabel.DROP, {})

    if _STOP_PLAIN_RE.match(text):
        return HotkeyMatch(IntentLabel.STOP, {})

    if _UNDO_RE.match(text):
        return HotkeyMatch(IntentLabel.UNDO, {})

    if _PAUSE_RE.match(text):
        return HotkeyMatch(IntentLabel.PAUSE, {})

    if _RESUME_RE.match(text):
        return HotkeyMatch(IntentLabel.RESUME, {})

    # Farmer-approval gate: ACCEPT/DECLINE <TOKEN> for window-opp PROPOSED claims.
    accept_match = _ACCEPT_RE.match(text)
    if accept_match:
        return HotkeyMatch(
            IntentLabel.ACCEPT_PROPOSAL,
            {"token": accept_match.group(1).upper()},
        )
    decline_match = _DECLINE_RE.match(text)
    if decline_match:
        return HotkeyMatch(
            IntentLabel.DECLINE_PROPOSAL,
            {"token": decline_match.group(1).upper()},
        )

    # When the last outbound was a CLARIFY, suppress YES/MAYBE as claim/maybe
    # hotkeys. A YES reply to a yes/no-phrased clarify is the user agreeing
    # with the agent's guess, not claiming the clarified-about opp. Letting
    # this fall through to the agent gives it the chance to promote to a
    # proper confirm.
    yes_match = _YES_RE.match(text)
    if yes_match and not last_outbound_was_clarify:
        slots = int(yes_match.group(2)) if yes_match.group(2) else 1
        return HotkeyMatch(IntentLabel.CLAIM, {"slots": slots, "days": []})

    # YES <day-list> for window opps: "YES WED", "YES MON,WED", "YES MON AND WED".
    # Only fire if bare YES didn't match (it would have above) — the tail must
    # contain at least one recognizable day token.
    yes_day_match = (
        _YES_DAY_LIST_RE.match(text)
        if not last_outbound_was_clarify else None
    )
    if yes_day_match:
        tail = yes_day_match.group(1)
        days = [m.group(0).upper() for m in _DAY_TOKEN_RE.finditer(tail)]
        if days:
            return HotkeyMatch(IntentLabel.CLAIM, {"slots": len(days), "days": days})

    if _MAYBE_RE.match(text) and not last_outbound_was_clarify:
        return HotkeyMatch(IntentLabel.MAYBE, {})

    insider_match = _INSIDER_RE.match(text)
    if insider_match:
        phone_raw = insider_match.group("phone")
        name = (insider_match.group("name") or "").strip()
        return HotkeyMatch(
            IntentLabel.INSIDER,
            {"phone": _normalize_phone(phone_raw), "name": name},
        )

    # STOP <activity|farm>
    stop_act = _STOP_ACTIVITY_RE.match(text)
    if stop_act:
        tail = stop_act.group(1).strip().lower()
        for slug in known_activity_slugs:
            slug_l = slug.lower()
            # Exact match, slug-prefix-of-tail ("weeding" in "weeding shifts"),
            # or tail-as-stem-of-slug ("weed" → "weeding").
            if (
                tail == slug_l
                or tail == slug_l + "ing"
                or slug_l in tail.split()
                or slug_l.startswith(tail) and len(tail) >= 4
            ):
                return HotkeyMatch(IntentLabel.STOP_ACTIVITY, {"activity": slug})
        for farm in known_farm_names:
            if tail == farm.lower() or farm.lower() in tail:
                return HotkeyMatch(IntentLabel.STOP_FARM, {"farm_name": farm})
        # Unknown target — fall through to LLM rather than guess.

    unavailable_match = _UNAVAILABLE_RE.match(text)
    if unavailable_match:
        window = (unavailable_match.group(1) or "").strip()
        # We delegate window parsing to the unified agent (date phrases are
        # diverse) but still tag the intent so the agent knows we tried.
        return HotkeyMatch(IntentLabel.UNAVAILABLE, {"raw_window": window})

    return None


_PHONE_CLEANUP = re.compile(r"[^\d+]")


def _normalize_phone(raw: str) -> str:
    s = _PHONE_CLEANUP.sub("", raw)
    if not s.startswith("+"):
        if len(s) == 10:
            s = "+1" + s
        elif len(s) == 11 and s.startswith("1"):
            s = "+" + s
    return s


# ---------------------------------------------------------------------------
# Token-confirmation matching (PENDING_CONFIRMATION → execute)
# ---------------------------------------------------------------------------
# Hotkeys the agent must NEVER use as a confirmation token. Keep in sync with
# the parse() branches above. The unified agent prompt also lists these so the
# model knows to avoid them.
RESERVED_HOTKEY_TOKENS = frozenset({
    "STOP", "UNSUBSCRIBE", "QUIT", "END", "CANCEL",
    "HELP", "INFO",
    "JOIN", "START",
    "YES", "MAYBE", "MUTE", "FLAG", "STATUS", "DROP",
    "INSIDER", "UNAVAILABLE",
    "UNDO", "PAUSE", "RESUME",
    # Farmer-approval gate: ACCEPT/DECLINE are themselves hotkey verbs that
    # take a separate 4-letter target token. The verbs must not be confused
    # with confirmation tokens the unified agent might draft.
    "ACCEPT", "DECLINE",
    # Day labels would collide with the YES <day-list> grammar.
    "MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN",
})


def match_pending_token(*, body: str, pending: dict | None) -> bool:
    """True if `body` should be treated as confirmation of the pending action.

    Match rules (any of):
      1. body normalizes to the exact token on `pending`.
      2. body normalizes to one of the affirmative variants (YES/OK/...).
         The receipt sent on execute spells out what was done, so this loose
         match is safe.

    Returns False if no live pending action.
    """
    if not pending or not pending.get("token"):
        return False
    norm = body.strip().upper().rstrip("!.?")
    if norm in RESERVED_HOTKEY_TOKENS and norm not in {"YES", "UNDO"}:
        return False
    if norm == pending["token"]:
        return True
    return norm in _AFFIRMATIVE
