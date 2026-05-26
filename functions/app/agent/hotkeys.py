"""Deterministic hotkey parser.

Runs BEFORE any LLM call. The vast majority of inbound messages match one of
these patterns; matching here avoids paying the LLM cost and gives crisp,
predictable behavior for the common path. Only messages that don't match get
forwarded to the LLM classifier.

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
_MAYBE_RE = re.compile(r"^\s*maybe\s*[!\.\?]?\s*$", re.IGNORECASE)
_HELP_RE = re.compile(r"^\s*help\s*[!\.\?]?\s*$", re.IGNORECASE)
_STATUS_RE = re.compile(r"^\s*status\s*[!\.\?]?\s*$", re.IGNORECASE)
_CANCEL_RE = re.compile(r"^\s*cancel\s*[!\.]?\s*$", re.IGNORECASE)
_STOP_PLAIN_RE = re.compile(r"^\s*(stop|unsubscribe|quit|end)\s*[!\.]?\s*$", re.IGNORECASE)
_FLAG_RE = re.compile(r"^\s*flag\b.*$", re.IGNORECASE)
_JOIN_RE = re.compile(r"^\s*(join|start)\s*[!\.]?\s*$", re.IGNORECASE)
_MUTE_RE = re.compile(r"^\s*(mute|pass|skip)\s*[!\.]?\s*$", re.IGNORECASE)
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
    known_activity_slugs: tuple[str, ...] = CANONICAL_ACTIVITIES,
    known_farm_names: tuple[str, ...] = (),
) -> HotkeyMatch | None:
    """Try to match `body` against a hotkey. Return None if nothing matches.

    `expecting_post_event_reply` flips how a bare "Y"/"N" is interpreted —
    in that context it's a check-in answer, not a claim/decline.
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

    if _STOP_PLAIN_RE.match(text):
        return HotkeyMatch(IntentLabel.STOP, {})

    yes_match = _YES_RE.match(text)
    if yes_match:
        slots = int(yes_match.group(2)) if yes_match.group(2) else 1
        return HotkeyMatch(IntentLabel.CLAIM, {"slots": slots})

    if _MAYBE_RE.match(text):
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
        # We delegate window parsing to the LLM (date phrases are diverse) but
        # still tag the intent so the classifier knows we tried.
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
