"""Fire a simulated inbound SMS at the deployed inbound_sms function.

This bypasses Telnyx entirely — we craft a Telnyx-shaped webhook payload and
POST it directly to the function. The function's signature verifier will
REJECT this in production (we don't have Telnyx's private key to sign with).

To make this work for smoke testing, we temporarily skip signature verification
when an `X-Smoke-Test-Token` header matches a value also stored as a Firebase
config. See app/flows/message_dispatch.py for the bypass branch.

Usage:
    python functions/scripts/fire_inbound_sms.py \
        --url https://us-west1-farm-friend-vashon.cloudfunctions.net/inbound_sms \
        --from +12065551234 \
        --to +15555550100 \
        --body "need 2 ppl tomorrow 10am to harvest greens"
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import UTC, datetime
from uuid import uuid4

import httpx


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", required=True, help="Deployed inbound_sms function URL")
    parser.add_argument("--from", dest="from_phone", required=True, help="Sender E.164")
    parser.add_argument(
        "--to",
        dest="to_phone",
        default="+15555550100",
        help="Recipient (your Telnyx number) E.164",
    )
    parser.add_argument("--body", required=True, help="SMS text body")
    args = parser.parse_args()

    smoke_token = os.environ.get("SMOKE_TEST_TOKEN")
    if not smoke_token:
        print(
            "ERROR: SMOKE_TEST_TOKEN env var not set.\n"
            "Set the same value here AND as a Firebase secret (see README).",
            file=sys.stderr,
        )
        sys.exit(2)

    payload = {
        "data": {
            "event_type": "message.received",
            "payload": {
                "id": f"smoke-{uuid4()}",
                "from": {"phone_number": args.from_phone},
                "to": [{"phone_number": args.to_phone}],
                "text": args.body,
                "received_at": datetime.now(UTC).isoformat(),
            },
        },
    }
    body_bytes = json.dumps(payload).encode("utf-8")

    resp = httpx.post(
        args.url,
        content=body_bytes,
        headers={
            "Content-Type": "application/json",
            "X-Smoke-Test-Token": smoke_token,
        },
        timeout=60.0,
    )
    print(f"Status: {resp.status_code}")
    print(f"Body: {resp.text}")


if __name__ == "__main__":
    main()
