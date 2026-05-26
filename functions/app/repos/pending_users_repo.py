"""Pending user approvals — the one manual gate in the system."""

from __future__ import annotations

from datetime import UTC, datetime

from app.firebase_app import db

from ._base import model_to_dict, snapshot_to_model
from .models import PendingUserDoc


COLLECTION = "pending_users"


def get_by_id(pending_id: str) -> PendingUserDoc | None:
    return snapshot_to_model(db.collection(COLLECTION).document(pending_id).get(), PendingUserDoc)


def get_by_phone(phone: str) -> PendingUserDoc | None:
    q = (
        db.collection(COLLECTION)
        .where("phone", "==", phone)
        .where("status", "==", "pending")
        .limit(1)
    )
    for snap in q.stream():
        return snapshot_to_model(snap, PendingUserDoc)
    return None


def create(doc: PendingUserDoc) -> PendingUserDoc:
    ref = db.collection(COLLECTION).document()
    ref.set(model_to_dict(doc))
    return doc.model_copy(update={"id": ref.id})


def mark_approved(pending_id: str) -> None:
    db.collection(COLLECTION).document(pending_id).update(
        {"status": "approved", "resolved_at": datetime.now(UTC)}
    )


def mark_rejected(pending_id: str) -> None:
    db.collection(COLLECTION).document(pending_id).update(
        {"status": "rejected", "resolved_at": datetime.now(UTC)}
    )


def list_pending() -> list[PendingUserDoc]:
    q = (
        db.collection(COLLECTION)
        .where("status", "==", "pending")
        .order_by("created_at", direction="DESCENDING")
    )
    return [snapshot_to_model(s, PendingUserDoc) for s in q.stream() if s.exists]  # type: ignore[misc]
