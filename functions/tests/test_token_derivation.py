"""Confirmation tokens are derived deterministically from the action, never
taken from the model. This removes the small-model failure mode where the
agent emits an invalid or colliding 4-letter token.
"""

from __future__ import annotations

from app.flows.message_dispatch import _token_for_action


def test_default_action_token_is_yes() -> None:
    for action in (
        "claim_opportunity",
        "record_maybe",
        "drop_confirmed_claim",
        "cancel_opportunity",
        "edit_opportunity",
        "create_opportunity",
        "record_offer",
        "set_availability",
        "farmer_decide_on_proposal",
    ):
        assert _token_for_action(action) == "YES"


def test_undo_action_token_is_undo() -> None:
    assert _token_for_action("undo_last") == "UNDO"


def test_unknown_action_defaults_to_yes() -> None:
    assert _token_for_action(None) == "YES"
    assert _token_for_action("something_new") == "YES"
