#!/usr/bin/env python3
"""Refuse an F-056 bootstrap plan that does more than the safe secret setup."""

import json
import sys


SURVIVOR_KEYS = (
    "database-url",
    "phone-hash-salt",
    "telnyx-api-key",
    "deepinfra-api-key",
)
EXPECTED_MOVES = {
    f'google_secret_manager_secret.app["{key}"]': (
        f'google_secret_manager_secret.protected["{key}"]'
    )
    for key in SURVIVOR_KEYS
}
EXPECTED_CHANGES = {
    'google_secret_manager_secret.protected["admin-password-hash"]': ["create"],
}


def main() -> int:
    plan = json.load(sys.stdin)
    resource_changes = plan.get("resource_changes", [])
    moves = {
        item["previous_address"]: item["address"]
        for item in resource_changes
        if item.get("previous_address")
        and item.get("change", {}).get("actions") == ["no-op"]
    }
    changes = {
        item["address"]: item["change"]["actions"]
        for item in resource_changes
        if item.get("change", {}).get("actions") != ["no-op"]
    }
    if moves != EXPECTED_MOVES or changes != EXPECTED_CHANGES:
        print(
            f"bootstrap secret plan refused: moves={moves}, changes={changes}",
            file=sys.stderr,
        )
        return 1
    print(
        "bootstrap secret plan asserts four no-op survivor address moves and "
        "one new password-secret container"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
