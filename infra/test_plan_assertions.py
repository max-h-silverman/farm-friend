#!/usr/bin/env python3
"""Tests for the stateful secret-cutover guard in plan-assertions.py."""

import importlib.util
import unittest
from pathlib import Path


SPEC = importlib.util.spec_from_file_location(
    "plan_assertions",
    Path(__file__).with_name("plan-assertions.py"),
)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("could not load plan-assertions.py")
PLAN_ASSERTIONS = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PLAN_ASSERTIONS)


class SecretCutoverChangesTest(unittest.TestCase):
    def test_accepts_each_approved_cutover_phase_and_the_completed_state(self) -> None:
        self.assertTrue(PLAN_ASSERTIONS.secret_cutover_changes_are_safe({}))
        self.assertTrue(
            PLAN_ASSERTIONS.secret_cutover_changes_are_safe(
                {
                    'google_secret_manager_secret.protected["admin-password-hash"]': ["create"],
                    'google_secret_manager_secret.app["magic-link-secret"]': ["delete"],
                }
            )
        )
        self.assertTrue(
            PLAN_ASSERTIONS.secret_cutover_changes_are_safe(
                {'google_secret_manager_secret.app["magic-link-secret"]': ["delete"]}
            )
        )

    def test_accepts_the_optional_key_containers_added_after_cutover(self) -> None:
        """F-069's geocoding key and F-078's SMTP password, each a CREATE of a container only.

        Both are added empty and take their version out of band, so neither passes a value
        through Terraform or its state. They can appear separately or together — the geocoding
        container already exists in production, so the SMTP apply plans that one alone.
        """
        geocoding = {
            'google_secret_manager_secret.protected["geocoding-api-key"]': ["create"],
        }
        smtp = {
            'google_secret_manager_secret.protected["smtp-password"]': ["create"],
        }
        self.assertTrue(PLAN_ASSERTIONS.secret_cutover_changes_are_safe(geocoding))
        self.assertTrue(PLAN_ASSERTIONS.secret_cutover_changes_are_safe(smtp))
        self.assertTrue(PLAN_ASSERTIONS.secret_cutover_changes_are_safe({**geocoding, **smtp}))

    def test_rejects_deleting_an_optional_key_container(self) -> None:
        """A CREATE is cheap to approve; a DELETE destroys every version inside the container.

        The allow-list must not be loosened into "any change to these two secrets".
        """
        self.assertFalse(
            PLAN_ASSERTIONS.secret_cutover_changes_are_safe(
                {'google_secret_manager_secret.protected["smtp-password"]': ["delete"]}
            )
        )

    def test_allows_creating_the_empty_gmail_oauth_secret_containers(self) -> None:
        self.assertTrue(
            PLAN_ASSERTIONS.secret_cutover_changes_are_safe({
                'google_secret_manager_secret.protected["gmail-oauth-client-secret"]': ["create"],
                'google_secret_manager_secret.protected["gmail-oauth-refresh-token"]': ["create"],
            })
        )
        self.assertFalse(
            PLAN_ASSERTIONS.secret_cutover_changes_are_safe(
                {'google_secret_manager_secret.protected["geocoding-api-key"]': ["delete"]}
            )
        )

    def test_rejects_every_unrelated_secret_change(self) -> None:
        self.assertFalse(
            PLAN_ASSERTIONS.secret_cutover_changes_are_safe(
                {'google_secret_manager_secret.protected["database-url"]': ["delete"]}
            )
        )
        self.assertFalse(
            PLAN_ASSERTIONS.secret_cutover_changes_are_safe(
                {'google_secret_manager_secret.protected["extra"]': ["create"]}
            )
        )

    def test_gmail_delivery_rejects_any_remaining_smtp_setting(self) -> None:
        self.assertFalse(
            PLAN_ASSERTIONS.email_delivery_configuration_is_exclusive(
                {"EMAIL_PROVIDER": "gmail"},
                {"SMTP_PASSWORD", "GMAIL_OAUTH_CLIENT_SECRET", "GMAIL_OAUTH_REFRESH_TOKEN"},
            )
        )
        self.assertTrue(
            PLAN_ASSERTIONS.email_delivery_configuration_is_exclusive(
                {"EMAIL_PROVIDER": "gmail"},
                {"GMAIL_OAUTH_CLIENT_SECRET", "GMAIL_OAUTH_REFRESH_TOKEN"},
            )
        )

    def test_gmail_cutover_allows_only_replacing_smtp_password(self) -> None:
        before = {"SMTP_PASSWORD", "DATABASE_URL"}
        after = {"DATABASE_URL", "GMAIL_OAUTH_CLIENT_SECRET", "GMAIL_OAUTH_REFRESH_TOKEN"}
        self.assertTrue(
            PLAN_ASSERTIONS.dropped_secret_mounts_are_safe(
                before, after, {"EMAIL_PROVIDER": "gmail"}
            )
        )
        self.assertFalse(
            PLAN_ASSERTIONS.dropped_secret_mounts_are_safe(
                before | {"GEOCODING_API_KEY"}, after, {"EMAIL_PROVIDER": "gmail"}
            )
        )


if __name__ == "__main__":
    unittest.main()
