"""Users collection."""

from __future__ import annotations

from datetime import UTC, datetime

from app.firebase_app import db

from ._base import model_to_dict, snapshot_to_model
from .models import UserDoc, UserStatus


COLLECTION = "users"


def get_by_id(user_id: str) -> UserDoc | None:
    return snapshot_to_model(db.collection(COLLECTION).document(user_id).get(), UserDoc)


def get_by_phone(phone: str) -> UserDoc | None:
    q = db.collection(COLLECTION).where("phone", "==", phone).limit(1)
    for snap in q.stream():
        return snapshot_to_model(snap, UserDoc)
    return None


def create(doc: UserDoc) -> UserDoc:
    ref = db.collection(COLLECTION).document()
    ref.set(model_to_dict(doc))
    return doc.model_copy(update={"id": ref.id})


def set_status(user_id: str, status: UserStatus) -> None:
    db.collection(COLLECTION).document(user_id).update(
        {"status": status.value, "status_changed_at": datetime.now(UTC)}
    )


def list_active() -> list[UserDoc]:
    q = db.collection(COLLECTION).where("status", "==", UserStatus.ACTIVE.value)
    return [snapshot_to_model(s, UserDoc) for s in q.stream() if s.exists]  # type: ignore[misc]


def list_by_status(status: UserStatus) -> list[UserDoc]:
    q = db.collection(COLLECTION).where("status", "==", status.value)
    return [snapshot_to_model(s, UserDoc) for s in q.stream() if s.exists]  # type: ignore[misc]


def update_availability(
    user_id: str,
    *,
    available_days: list[int],
    available_start_hour: int | None,
    available_end_hour: int | None,
    max_commit_hours_per_week: int | None,
) -> None:
    """Set the volunteer availability captured at onboarding."""
    db.collection(COLLECTION).document(user_id).update(
        {
            "available_days": available_days,
            "available_start_hour": available_start_hour,
            "available_end_hour": available_end_hour,
            "max_commit_hours_per_week": max_commit_hours_per_week,
        }
    )
