"""Seed the Firestore data needed for the end-to-end smoke test.

Creates: a test farmer user, a farm owned by them, a test volunteer user,
and an insider link between them.

Usage:
    # First, get a service-account key from the Firebase Console:
    #   Project Settings -> Service accounts -> Generate new private key
    # Save the JSON file somewhere private (don't commit it).
    GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json \
        python functions/scripts/seed_smoke_test.py \
            --farmer-phone +12065551234 \
            --volunteer-phone +12065556789

The script is idempotent on the (phone, role) tuple — re-running won't
duplicate users.
"""

from __future__ import annotations

import argparse
import sys
from datetime import UTC, datetime

import firebase_admin
from firebase_admin import firestore


def _ensure_app() -> None:
    if not firebase_admin._apps:
        firebase_admin.initialize_app()


def _get_or_create_user(db, *, phone: str, name: str, role: str) -> str:
    existing = (
        db.collection("users").where("phone", "==", phone).limit(1).get()
    )
    for snap in existing:
        print(f"  found existing user {snap.id} for {phone} (role={snap.get('role')})")
        return snap.id

    doc_ref = db.collection("users").document()
    doc_ref.set(
        {
            "phone": phone,
            "name": name,
            "role": role,
            "status": "active",
            "created_at": datetime.now(UTC),
        }
    )
    print(f"  created user {doc_ref.id} (role={role}, phone={phone})")
    return doc_ref.id


def _get_or_create_farm(db, *, name: str, owner_user_id: str) -> str:
    existing = (
        db.collection("farms")
        .where("owner_user_id", "==", owner_user_id)
        .limit(1)
        .get()
    )
    for snap in existing:
        print(f"  found existing farm {snap.id} ({snap.get('name')})")
        return snap.id

    doc_ref = db.collection("farms").document()
    doc_ref.set(
        {
            "name": name,
            "owner_user_id": owner_user_id,
            "location": "Vashon Island, WA",
            "activity_tags": [],
            "insider_window_minutes": 180,
            "pickup_insider_window_minutes": 30,
            "created_at": datetime.now(UTC),
        }
    )
    print(f"  created farm {doc_ref.id} ({name})")
    return doc_ref.id


def _add_insider(db, *, farm_id: str, volunteer_user_id: str) -> None:
    ref = (
        db.collection("farms")
        .document(farm_id)
        .collection("insiders")
        .document(volunteer_user_id)
    )
    if ref.get().exists:
        print(f"  insider link already exists ({volunteer_user_id} -> {farm_id})")
        return
    ref.set(
        {
            "volunteer_user_id": volunteer_user_id,
            "added_at": datetime.now(UTC),
        }
    )
    print(f"  added insider {volunteer_user_id} -> farm {farm_id}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--farmer-phone",
        required=True,
        help="E.164 phone number for the test farmer (e.g. +12065551234)",
    )
    parser.add_argument(
        "--farmer-name",
        default="Test Farmer",
        help="Display name for the test farmer",
    )
    parser.add_argument(
        "--farm-name",
        default="Test Farm",
        help="Name of the test farm",
    )
    parser.add_argument(
        "--volunteer-phone",
        required=True,
        help="E.164 phone number for the test volunteer",
    )
    parser.add_argument(
        "--volunteer-name",
        default="Test Volunteer",
        help="Display name for the test volunteer",
    )
    args = parser.parse_args()

    _ensure_app()
    db = firestore.client()

    print("Seeding farmer...")
    farmer_id = _get_or_create_user(
        db, phone=args.farmer_phone, name=args.farmer_name, role="farmer"
    )

    print("Seeding farm...")
    farm_id = _get_or_create_farm(db, name=args.farm_name, owner_user_id=farmer_id)

    print("Seeding volunteer...")
    volunteer_id = _get_or_create_user(
        db, phone=args.volunteer_phone, name=args.volunteer_name, role="volunteer"
    )

    print("Linking volunteer as insider of farm...")
    _add_insider(db, farm_id=farm_id, volunteer_user_id=volunteer_id)

    print()
    print("== Seed complete ==")
    print(f"  farmer_id    = {farmer_id}    ({args.farmer_phone})")
    print(f"  farm_id      = {farm_id}      ({args.farm_name})")
    print(f"  volunteer_id = {volunteer_id} ({args.volunteer_phone})")
    print()
    print("Next: fire a simulated inbound SMS from the farmer's phone")
    print("(see scripts/fire_inbound_sms.py).")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(130)
