"""Smoke tests for SMS copy templates — make sure they render and include
the essential information. Wording can drift; structure shouldn't."""

from __future__ import annotations

from app.copy import templates


def test_intro_includes_name_and_vcard_url() -> None:
    body = templates.render_intro(name="Alice", vcard_url="https://x.test/v.vcf")
    assert "Alice" in body
    assert "https://x.test/v.vcf" in body
    assert "STOP" in body  # TCPA requirement


def test_shift_outreach_has_action_prompt() -> None:
    body = templates.render_shift_outreach(
        farm_name="Plum Forest",
        activity="weeding",
        when_human="Thu 9am",
        headcount=3,
        seats_remaining=2,
        requirements="",
    )
    assert "Plum Forest" in body
    assert "weeding" in body
    assert "Thu 9am" in body
    assert "YES" in body


def test_pickup_outreach_mentions_destination_when_provided() -> None:
    body = templates.render_pickup_outreach(
        farm_name="Sea Breeze",
        produce="20 lbs zucchini",
        deadline_human="by sunset today",
        destination="Vashon Food Bank",
        vehicle_needed=True,
    )
    assert "Sea Breeze" in body
    assert "zucchini" in body
    assert "Vashon Food Bank" in body
    assert "vehicle" in body.lower() or "truck" in body.lower()


def test_post_event_checkin_has_y_n_prompt() -> None:
    body = templates.render_post_event_checkin(when_human="yesterday", kind_label="shift")
    assert "Y" in body and "N" in body


def test_help_lists_main_commands() -> None:
    body = templates.HELP_TEXT
    for cmd in ("YES", "STOP", "MUTE", "FLAG"):
        assert cmd in body
