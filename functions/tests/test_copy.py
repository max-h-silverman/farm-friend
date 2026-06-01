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
    assert "days/times" in body
    assert "rough answers are fine" in body
    assert "STOP" in body


def test_farmer_intro_mentions_farmer_actions() -> None:
    body = templates.render_intro_farmer(name="Iris", vcard_url="https://x.test/v.vcf")
    assert "Iris" in body
    assert "More detail helps" in body
    assert "day(s), time, length, people needed, and work type" in body
    assert "STATUS" in body
    assert "CANCEL" in body
    assert "STOP" in body


def test_help_is_compliance_text() -> None:
    """The carrier-approved help reply is the same for both roles."""
    farmer = templates.render_help(is_farmer=True)
    volunteer = templates.render_help(is_farmer=False)
    assert farmer == volunteer
    # Required by docs/sms-compliance-requirements.md §"Help Message":
    assert "Farm Friend Vashon" in farmer
    assert "max@myco.software" in farmer
    assert "https://myco.software/farm-friend-vashon.html" in farmer
    assert "STOP" in farmer
    assert "Msg&data rates may apply" in farmer


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
    # Compliance: program name + STOP opt-out path on every operational alert.
    assert "Farm Friend Vashon" in body
    assert "Plum Forest" in body
    assert "weeding" in body
    assert "Thu 9a-12p" in body
    assert "YES" in body
    assert "MAYBE" in body
    assert "MUTE" in body
    assert "STOP" in body  # opt-out path required
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
    assert "Farm Friend Vashon" in body
    assert "Sea Breeze" in body
    assert "zucchini" in body
    assert "Vashon Food Bank" in body
    assert "vehicle" in body.lower() or "truck" in body.lower()
    assert "YES" in body
    assert "MAYBE" in body
    assert "STOP" in body


def test_post_event_checkin_has_y_n_prompt() -> None:
    body = templates.render_post_event_checkin(when_human="yesterday", kind_label="shift")
    assert "Y" in body and "N" in body


def test_help_includes_contact_path() -> None:
    body = templates.HELP_TEXT
    assert "max@myco.software" in body
    assert "https://myco.software/farm-friend-vashon.html" in body
    assert "STOP" in body


# ---------------------------------------------------------------------------
# Compliance copy — keep these aligned with the Telnyx campaign registration.
# Source of truth: docs/sms-compliance-requirements.md.
# ---------------------------------------------------------------------------
def test_stop_ack_matches_compliance_text() -> None:
    body = templates.render_stop_ack()
    assert body == (
        "Farm Friend Vashon: You're unsubscribed and will receive no further "
        "messages. Reply JOIN to request to rejoin."
    )


def test_join_ack_matches_compliance_text() -> None:
    body = templates.render_join_ack()
    assert "Farm Friend Vashon: You're signed up" in body
    assert "local farm help and surplus pickup texts" in body
    assert "We'll text only about this program" in body
    assert "0-6/week" in body
    assert "Msg&data rates may apply" in body
    assert "Texting is optional" in body
    assert "Reply HELP for help or STOP to opt out" in body


def test_flag_ack_matches_compliance_text() -> None:
    body = templates.render_flag_ack()
    assert body == (
        "Farm Friend Vashon: Thanks. This thread has been flagged for review, "
        "and automated replies are paused. Reply STOP to unsubscribe."
    )


def test_confirmation_reminder_uses_DROP_not_CANCEL() -> None:
    """CANCEL is a compliance opt-out keyword; volunteer drops use DROP."""
    body = templates.render_confirmation_reminder_shift(
        farm_name="Three Cedars", activity="harvest", when_human="Friday 9am",
    )
    assert "DROP" in body
    assert "CANCEL" not in body
    assert "Farm Friend Vashon" in body
    # Confirmation reminders are direct acknowledgments of an existing
    # commitment, not a new opt-in solicitation — no STOP line.
    assert "STOP" not in body


def test_auto_confirm_notice_does_not_use_cancel_for_reversal() -> None:
    body = templates.render_proposal_auto_confirmed_to_farmer(
        volunteer_name="Alex",
        day_human="Wed 6/3 morning",
        opp_summary="weeding window",
    )
    assert "CANCEL" not in body
    assert "Reply here if you need to reverse it." in body


def test_intro_volunteer_uses_program_name_vashon() -> None:
    body = templates.render_intro_volunteer(name="Alex", vcard_url="https://x.test/v.vcf")
    assert "Farm Friend Vashon" in body


def test_intro_farmer_uses_program_name_vashon() -> None:
    body = templates.render_intro_farmer(name="Iris", vcard_url="https://x.test/v.vcf")
    assert "Farm Friend Vashon" in body


def test_orphan_yes_includes_program_name_no_stop() -> None:
    body = templates.render_orphan_yes()
    assert "Farm Friend Vashon" in body
    # Direct reply to a user inbound — no STOP line.
    assert "STOP" not in body


def test_fallback_ambiguous_includes_program_name_no_stop() -> None:
    body = templates.render_fallback_ambiguous()
    assert "Farm Friend Vashon" in body
    # Direct reply to a user inbound — no STOP line.
    assert "STOP" not in body


def test_stuck_handoff_is_warm_and_names_coordinator() -> None:
    body = templates.render_stuck_handoff()
    assert "Farm Friend Vashon" in body
    assert "coordinator" in body.lower()
    # Direct reply to a user inbound — no STOP line.
    assert "STOP" not in body
    # Acknowledges the system is stuck (the whole point — not silent).
    assert body.strip() != ""
