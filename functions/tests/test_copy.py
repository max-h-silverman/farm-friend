"""Smoke tests for SMS copy templates — make sure they render and include
the essential information. Wording can drift; structure shouldn't."""

from __future__ import annotations

from app.copy import templates


def test_intro_includes_name_and_vcard_url() -> None:
    body = templates.render_intro(name="Alice", vcard_url="https://x.test/v.vcf")
    assert "Alice" in body
    assert "https://x.test/v.vcf" in body
    assert "STOP" in body  # TCPA requirement


def test_volunteer_intro_mentions_volunteer_actions() -> None:
    body = templates.render_intro_volunteer(name="Alex", vcard_url="https://x.test/v.vcf")
    assert "Alex" in body
    assert "YES" in body
    assert "STOP" in body


def test_farmer_intro_mentions_farmer_actions() -> None:
    body = templates.render_intro_farmer(name="Iris", vcard_url="https://x.test/v.vcf")
    assert "Iris" in body
    assert "STATUS" in body
    assert "CANCEL" in body
    assert "STOP" in body


def test_help_is_role_aware() -> None:
    farmer = templates.render_help(is_farmer=True)
    volunteer = templates.render_help(is_farmer=False)
    assert "STATUS" in farmer
    assert "CANCEL" in farmer
    assert "STATUS" not in volunteer  # volunteers don't see STATUS
    assert "YES" in volunteer
    assert "MAYBE" in volunteer


def test_status_renders_lines_and_empty() -> None:
    assert templates.render_status_empty() == "No open posts."
    line = templates.render_status_line(
        summary="plum harvest tomorrow 10a-1p",
        filled=1,
        headcount=2,
        maybes=1,
    )
    assert "1/2" in line
    assert "MAYBE" in line


def test_edit_headcount_too_low_states_floor() -> None:
    body = templates.render_edit_headcount_too_low(currently_filled=3)
    assert "3" in body
    assert "CANCEL" in body


def test_opportunity_changed_includes_what_changed() -> None:
    body = templates.render_opportunity_changed(
        farm_name="Three Cedars",
        summary="plum harvest tomorrow 10a-1p",
        what_changed="time is now 11a-2p",
    )
    assert "Three Cedars" in body
    assert "time is now 11a-2p" in body


def test_opportunity_cancelled_names_farm() -> None:
    body = templates.render_opportunity_cancelled(
        farm_name="Three Cedars", summary="plum harvest tomorrow 10a-1p"
    )
    assert "Three Cedars" in body
    assert "cancelled" in body.lower()


def test_first_claim_includes_filled_count() -> None:
    body = templates.render_first_claim(
        opp_summary="plum harvest tomorrow 10a-1p",
        volunteer_name="Alex Park",
        filled=1,
        headcount=3,
    )
    assert "Alex Park" in body
    assert "1/3" in body


def test_shift_outreach_has_action_prompt() -> None:
    body = templates.render_shift_outreach(
        farm_name="Plum Forest",
        activity="weeding",
        when_human="Thu 9a-12p",
        headcount=3,
        seats_remaining=2,
        requirements="",
    )
    assert "Plum Forest" in body
    assert "weeding" in body
    assert "Thu 9a-12p" in body
    assert "YES" in body
    assert "MAYBE" in body
    # singular/plural phrasing
    assert "people" in body


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
    assert "MAYBE" in body


def test_post_event_checkin_has_y_n_prompt() -> None:
    body = templates.render_post_event_checkin(when_human="yesterday", kind_label="shift")
    assert "Y" in body and "N" in body


def test_help_lists_main_commands() -> None:
    body = templates.HELP_TEXT
    for cmd in ("YES", "STOP", "MUTE", "FLAG"):
        assert cmd in body
