"""F-056 source tripwire for protected Secret Manager lifecycle moves."""

from pathlib import Path
import re
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

        self.assertIn("initial_secret_changes", plan_assertions)
        self.assertIn("post_provision_secret_changes", plan_assertions)
        self.assertIn('google_secret_manager_secret.protected["admin-password-hash"]', plan_assertions)
        self.assertIn('google_secret_manager_secret.app["magic-link-secret"]', plan_assertions)


if __name__ == "__main__":
    unittest.main()
