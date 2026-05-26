"""Seed Firestore with a realistic-sized test dataset for the admin UI and
the System Test panel.

Every document this script writes carries `test_data: true` so it can be
swept up later with `--teardown`. Phone numbers come from the +1 (555) 0100-
0199 fictional-use range, so they cannot ring a real person if outreach
ever leaks past the FakeMessagingProvider.

Usage:
    GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json \
        python functions/scripts/seed_test_data.py

    # wipe everything tagged test_data=true:
    GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json \
        python functions/scripts/seed_test_data.py --teardown

The seed is idempotent on user phone — re-running won't duplicate users,
but it WILL re-link insiders if they were removed.
"""

from __future__ import annotations

import argparse
import sys
from datetime import UTC, datetime

import firebase_admin
from firebase_admin import firestore


# Fictional-use range: +1 (555) 0100 - 0199. Never dialable.
FARMERS = [
    {"phone": "+15550100001", "name": "Iris Calder",   "farm": "Calder Hollow"},
    {"phone": "+15550100002", "name": "Tom Berenger",  "farm": "Three Cedars"},
    {"phone": "+15550100003", "name": "Maya Olsen",    "farm": "Salt Marsh Farm"},
]

VOLUNTEERS = [
    {"phone": "+15550101001", "name": "Alex Park"},
    {"phone": "+15550101002", "name": "Brigid Shaw"},
    {"phone": "+15550101003", "name": "Cole Ramirez"},
    {"phone": "+15550101004", "name": "Devi Patel"},
    {"phone": "+15550101005", "name": "Eli Brooks"},
    {"phone": "+15550101006", "name": "Fiona Tan"},
    {"phone": "+15550101007", "name": "Gus Halloran"},
    {"phone": "+15550101008", "name": "Hana Yuen"},
    {"phone": "+15550101009", "name": "Ivan Petrov"},
    {"phone": "+15550101010", "name": "Joon Lim"},
    {"phone": "+15550101011", "name": "Kira Novak"},
    {"phone": "+15550101012", "name": "Luca Moretti"},
    {"phone": "+15550101013", "name": "Mira Castillo"},
    {"phone": "+15550101014", "name": "Niko Schaefer"},
    {"phone": "+15550101015", "name": "Otto Vance"},
]

# Insider assignments by name. Some volunteers are insiders for more than one
# farm; most farms have 3-4 insiders.
INSIDERS = {
    "Calder Hollow":   ["Alex Park", "Brigid Shaw", "Cole Ramirez", "Devi Patel"],
    "Three Cedars":    ["Devi Patel", "Eli Brooks", "Fiona Tan", "Gus Halloran"],
    "Salt Marsh Farm": ["Hana Yuen", "Ivan Petrov", "Joon Lim", "Alex Park"],
}


def _ensure_app() -> None:
    if not firebase_admin._apps:
        firebase_admin.initialize_app()


def _get_or_create_user(db, *, phone: str, name: str, role: str) -> str:
    existing = (
        db.collection("users").where("phone", "==", phone).limit(1).get()
    )
    for snap in existing:
        print(f"  found existing user {snap.id} for {phone} ({snap.get('name')})")
        return snap.id

    ref = db.collection("users").document()
    ref.set(
        {
            "phone": phone,
            "name": name,
            "role": role,
            "status": "active",
            "created_at": datetime.now(UTC),
            "test_data": True,
        }
    )
    print(f"  created user {ref.id} ({name}, {role}, {phone})")
    return ref.id


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

    ref = db.collection("farms").document()
    ref.set(
        {
            "name": name,
            "owner_user_id": owner_user_id,
            "location": "Vashon Island, WA",
            "activity_tags": [],
            "insider_window_minutes": 180,
            "pickup_insider_window_minutes": 30,
            "created_at": datetime.now(UTC),
            "test_data": True,
        }
    )
    print(f"  created farm {ref.id} ({name})")
    return ref.id


def _link_insider(db, *, farm_id: str, volunteer_user_id: str) -> None:
    ref = (
        db.collection("farms")
        .document(farm_id)
        .collection("insiders")
        .document(volunteer_user_id)
    )
    if ref.get().exists:
        return
    ref.set(
        {
            "volunteer_user_id": volunteer_user_id,
            "added_at": datetime.now(UTC),
            "test_data": True,
        }
    )
    print(f"  linked insider {volunteer_user_id} -> farm {farm_id}")


def seed(db) -> None:
    print(f"Seeding {len(FARMERS)} farmers + farms...")
    farm_ids_by_name: dict[str, str] = {}
    for f in FARMERS:
        farmer_id = _get_or_create_user(
            db, phone=f["phone"], name=f["name"], role="farmer"
        )
        farm_ids_by_name[f["farm"]] = _get_or_create_farm(
            db, name=f["farm"], owner_user_id=farmer_id
        )

    print(f"\nSeeding {len(VOLUNTEERS)} volunteers...")
    volunteer_ids_by_name: dict[str, str] = {}
    for v in VOLUNTEERS:
        volunteer_ids_by_name[v["name"]] = _get_or_create_user(
            db, phone=v["phone"], name=v["name"], role="volunteer"
        )

    print("\nLinking insiders...")
    for farm_name, insider_names in INSIDERS.items():
        farm_id = farm_ids_by_name[farm_name]
        for vname in insider_names:
            vid = volunteer_ids_by_name[vname]
            _link_insider(db, farm_id=farm_id, volunteer_user_id=vid)

    print("\n== Seed complete ==")
    print(f"  farms:      {len(farm_ids_by_name)}")
    print(f"  volunteers: {len(volunteer_ids_by_name)}")
    insider_count = sum(len(v) for v in INSIDERS.values())
    print(f"  insider links: {insider_count}")


def teardown(db) -> None:
    """Delete every doc tagged test_data=true.

    Order matters: insider subcollections first (they reference farms), then
    farms, then users. Messages/opportunities/claims created by the System
    Test panel are NOT tagged test_data and aren't touched here — clean
    those by hand if needed.
    """
    print("Deleting insider subcollections under test farms...")
    farms = list(db.collection("farms").where("test_data", "==", True).get())
    insider_deleted = 0
    for f in farms:
        for ins in f.reference.collection("insiders").get():
            ins.reference.delete()
            insider_deleted += 1
    print(f"  deleted {insider_deleted} insider links")

    print("Deleting test farms...")
    for f in farms:
        f.reference.delete()
    print(f"  deleted {len(farms)} farms")

    print("Deleting test users...")
    users = list(db.collection("users").where("test_data", "==", True).get())
    for u in users:
        u.reference.delete()
    print(f"  deleted {len(users)} users")

    print("\n== Teardown complete ==")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--teardown",
        action="store_true",
        help="Delete all docs tagged test_data=true instead of seeding.",
    )
    args = parser.parse_args()

    _ensure_app()
    db = firestore.client()

    if args.teardown:
        teardown(db)
    else:
        seed(db)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(130)
