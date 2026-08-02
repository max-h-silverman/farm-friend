#!/usr/bin/env python3
"""Refuse a targeted F-056 secret-container plan with any collateral action."""

import json
import sys


EXPECTED = {
    'google_secret_manager_secret.protected["admin-password-hash"]': ["create"],
}


def main() -> int:
    plan = json.load(sys.stdin)
    changes = {
        item["address"]: item["change"]["actions"]
        for item in plan.get("resource_changes", [])
        if item.get("change", {}).get("actions") != ["no-op"]
    }
    if changes != EXPECTED:
        print(f"targeted secret plan refused: changes={changes}", file=sys.stderr)
        return 1
    print("targeted secret plan asserts one new password-secret container only")
    return 0


if __name__ == "__main__":
    sys.exit(main())
