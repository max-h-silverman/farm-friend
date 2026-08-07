"""F-056 source tripwire for protected Secret Manager lifecycle moves."""

from pathlib import Path
import importlib.util
import json
import re
import subprocess
import sys
import unittest


ROOT = Path(__file__).parent


class SecretLifecycleSourceTest(unittest.TestCase):
    def test_moves_surviving_secrets_out_of_the_old_protected_collection(self) -> None:
        secrets = (ROOT / "secrets.tf").read_text()
        service_references = (ROOT / "services.tf").read_text()
        iam_references = (ROOT / "iam.tf").read_text()
        output_references = (ROOT / "outputs.tf").read_text()
        plan_assertions = (ROOT / "plan-assertions.py").read_text()

        self.assertRegex(
            secrets,
            r'resource "google_secret_manager_secret" "protected"\s*\{',
        )
        self.assertRegex(secrets, r'prevent_destroy\s*=\s*true')
        self.assertNotRegex(
            secrets,
            r'resource "google_secret_manager_secret" "app"\s*\{',
        )

        for key in (
            "database-url",
            "phone-hash-salt",
            "telnyx-api-key",
            "deepinfra-api-key",
        ):
            self.assertRegex(
                secrets,
                rf'moved\s*\{{\s*from\s*=\s*google_secret_manager_secret\.app\["{key}"\]\s*'
                rf'to\s*=\s*google_secret_manager_secret\.protected\["{key}"\]\s*\}}',
            )

        self.assertNotIn('google_secret_manager_secret.app["magic-link-secret"]', secrets)
        for source in (service_references, iam_references, output_references):
            self.assertNotIn("google_secret_manager_secret.app", source)
            self.assertIn("google_secret_manager_secret.protected", source)

        # Anchored to the ADDRESSES the guard allow-lists, never to the local variable names
        # holding them. This assertion previously named `initial_secret_changes` and
        # `post_provision_secret_changes`; commit 737b39b renamed those locals to `initial` and
        # `post_provision` and this tripwire has been RED ever since — unnoticed because it is a
        # standalone Python file that `npm test` never runs. A name is not the construct.
        self.assertIn('google_secret_manager_secret.protected["admin-password-hash"]', plan_assertions)
        self.assertIn('google_secret_manager_secret.app["magic-link-secret"]', plan_assertions)

        # The guard itself must still REFUSE. Asserting the source mentions an address proves
        # only that someone wrote it down; these call the predicate.
        spec = importlib.util.spec_from_file_location(
            "plan_assertions_lifecycle", ROOT / "plan-assertions.py"
        )
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)

        self.assertTrue(
            module.secret_cutover_changes_are_safe(
                {
                    'google_secret_manager_secret.protected["admin-password-hash"]': ["create"],
                    'google_secret_manager_secret.app["magic-link-secret"]': ["delete"],
                }
            )
        )
        # Destroying a protected survivor takes every version inside it with it, and
        # `phone-hash-salt` can never be re-derived.
        for key in ("database-url", "phone-hash-salt", "telnyx-api-key", "deepinfra-api-key"):
            self.assertFalse(
                module.secret_cutover_changes_are_safe(
                    {f'google_secret_manager_secret.protected["{key}"]': ["delete"]}
                ),
                f"deleting {key} must never be an approved secret change",
            )

    def test_bootstrap_plan_uses_only_the_safe_exclusions(self) -> None:
        runbook = (ROOT.parent / "docs" / "RUNBOOK.md").read_text()
        plan_command = re.search(
            r"tofu plan (?P<command>.*?) -out=/tmp/f056-password-secret\.tfplan",
            runbook,
            re.DOTALL,
        )

        self.assertIsNotNone(plan_command)
        command = plan_command.group("command")
        self.assertNotIn("-target", command)
        self.assertEqual(command.count("-exclude="), 4)
        self.assertEqual(
            re.findall(r"-exclude='([^']+)'", command),
            [
                'google_secret_manager_secret.app["magic-link-secret"]',
                "google_cloud_run_v2_service.web",
                "google_cloud_run_v2_service.worker",
                "google_secret_manager_secret_iam_member.runtime_reads",
            ],
        )
        self.assertIn("python3 bootstrap-secret-plan-assertions.py", runbook)
        self.assertNotIn("target-secret-plan-assertions.py", runbook)

    def test_bootstrap_plan_assertion_requires_the_four_no_op_moves(self) -> None:
        assertion_script = ROOT / "bootstrap-secret-plan-assertions.py"
        self.assertTrue(assertion_script.exists())
        survivor_keys = (
            "database-url",
            "phone-hash-salt",
            "telnyx-api-key",
            "deepinfra-api-key",
        )
        resource_changes = [
            {
                "address": f'google_secret_manager_secret.protected["{key}"]',
                "previous_address": f'google_secret_manager_secret.app["{key}"]',
                "change": {"actions": ["no-op"]},
            }
            for key in survivor_keys
        ]
        resource_changes.append(
            {
                "address": 'google_secret_manager_secret.protected["admin-password-hash"]',
                "change": {"actions": ["create"]},
            }
        )

        accepted = subprocess.run(
            [sys.executable, assertion_script],
            input=json.dumps({"resource_changes": resource_changes}),
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(accepted.returncode, 0, accepted.stderr)

        missing_move = subprocess.run(
            [sys.executable, assertion_script],
            input=json.dumps({"resource_changes": resource_changes[1:]}),
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(missing_move.returncode, 1)

        collateral_change = subprocess.run(
            [sys.executable, assertion_script],
            input=json.dumps(
                {
                    "resource_changes": resource_changes
                    + [
                        {
                            "address": "google_cloud_run_v2_service.web",
                            "change": {"actions": ["update"]},
                        }
                    ]
                }
            ),
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(collateral_change.returncode, 1)


if __name__ == "__main__":
    unittest.main()
