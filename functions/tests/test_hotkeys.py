"""Hotkey parser unit tests.

The hotkey parser is the most-hit code path in the app — a YES/STOP/HELP
hits it before any LLM call. Catching regressions here is high-leverage.
"""

from __future__ import annotations

import pytest

from app.agent.hotkeys import HotkeyMatch, parse
from app.repos.models import IntentLabel


@pytest.mark.parametrize(
    "text",
    [
        "YES",
        "yes",
        "Yes.",
        " yes!",
        "Y",
        "y",
    ],
)
def test_bare_yes_is_claim(text: str) -> None:
    m = parse(text)
    assert m is not None
    assert m.intent is IntentLabel.CLAIM
    assert m.payload["slots"] == 1


@pytest.mark.parametrize("text,slots", [("YES 2", 2), ("yes 3", 3), ("Y 5", 5)])
def test_yes_n_slots(text: str, slots: int) -> None:
    m = parse(text)
    assert m is not None
    assert m.intent is IntentLabel.CLAIM
    assert m.payload["slots"] == slots


@pytest.mark.parametrize("text", ["STOP", "stop", "STOP.", "Unsubscribe", "quit", "cancel"])
def test_plain_stop_unsubscribes(text: str) -> None:
    m = parse(text)
    assert m is not None
    assert m.intent is IntentLabel.STOP


@pytest.mark.parametrize("text", ["HELP", "help", "help?", "Help."])
def test_help(text: str) -> None:
    m = parse(text)
    assert m is not None
    assert m.intent is IntentLabel.HELP


def test_flag_with_reason_captures_reason() -> None:
    m = parse("FLAG that wasn't the right time")
    assert m is not None
    assert m.intent is IntentLabel.FLAG
    assert "wasn't the right time" in m.payload["reason"]


def test_flag_beats_stop_substring() -> None:
    # Defensive: "flag" doesn't contain "stop" but a hypothetical "stop flagging"
    # shouldn't match FLAG. Verify the regex is anchored.
    m = parse("stop flagging me")
    # This isn't a clean STOP either — should fall through.
    assert m is None or m.intent is not IntentLabel.FLAG


def test_mute_synonyms() -> None:
    for word in ("MUTE", "mute", "pass", "skip"):
        m = parse(word)
        assert m is not None and m.intent is IntentLabel.MUTE


def test_stop_activity_known_slug() -> None:
    m = parse("STOP weeding")
    assert m is not None
    assert m.intent is IntentLabel.STOP_ACTIVITY
    assert m.payload["activity"] == "weeding"


def test_stop_activity_with_gerund_variant() -> None:
    # "STOP weed" should still resolve to "weeding".
    m = parse("STOP weed")
    assert m is not None
    assert m.intent is IntentLabel.STOP_ACTIVITY
    assert m.payload["activity"] == "weeding"


def test_stop_unknown_target_falls_through_to_llm() -> None:
    m = parse("STOP yelling at me")
    assert m is None  # delegated to LLM classifier rather than guessed


def test_stop_farm_known_name() -> None:
    m = parse("STOP Plum Forest", known_farm_names=("Plum Forest", "Sea Breeze"))
    assert m is not None
    assert m.intent is IntentLabel.STOP_FARM
    assert m.payload["farm_name"] == "Plum Forest"


def test_join() -> None:
    m = parse("JOIN")
    assert m is not None and m.intent is IntentLabel.JOIN


def test_unavailable_with_window_captures_raw() -> None:
    m = parse("UNAVAILABLE next two weeks")
    assert m is not None
    assert m.intent is IntentLabel.UNAVAILABLE
    assert "next two weeks" in m.payload["raw_window"]


def test_insider_with_phone_and_name() -> None:
    m = parse("INSIDER +12065551212 Alice Cooper")
    assert m is not None
    assert m.intent is IntentLabel.INSIDER
    assert m.payload["phone"] == "+12065551212"
    assert m.payload["name"] == "Alice Cooper"


def test_insider_with_raw_phone_normalizes() -> None:
    m = parse("INSIDER (206) 555-1212 Bob")
    assert m is not None
    assert m.intent is IntentLabel.INSIDER
    assert m.payload["phone"] == "+12065551212"


def test_post_event_y_yields_post_event_intent_only_in_that_mode() -> None:
    # Without post-event mode, bare Y is a claim.
    m = parse("Y")
    assert m is not None and m.intent is IntentLabel.CLAIM
    # With post-event mode, bare Y answers the check-in.
    m2 = parse("Y", expecting_post_event_reply=True)
    assert m2 is not None and m2.intent is IntentLabel.POST_EVENT_OK


def test_post_event_n_yields_post_event_issue() -> None:
    m = parse("N", expecting_post_event_reply=True)
    assert m is not None and m.intent is IntentLabel.POST_EVENT_ISSUE


def test_freeform_does_not_match() -> None:
    # The classifier handles these, not the hotkey parser.
    assert parse("count me in") is None
    assert parse("what time is it?") is None
    assert parse("depends on the weather") is None


def test_empty_message_returns_none() -> None:
    assert parse("") is None
    assert parse("   ") is None
