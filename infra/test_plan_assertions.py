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


if __name__ == "__main__":
    unittest.main()
