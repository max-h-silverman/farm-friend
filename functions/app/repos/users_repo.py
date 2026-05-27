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
    """Set the volunteer availability (onboarding or unified-agent update)."""
    db.collection(COLLECTION).document(user_id).update(
        {
            "available_days": available_days,
            "available_start_hour": available_start_hour,
            "available_end_hour": available_end_hour,
            "max_commit_hours_per_week": max_commit_hours_per_week,
        }
    )


def update_activity_preferences(user_id: str, preferences: list[str]) -> None:
    """Set the full activity_preferences list. Caller decides add/remove semantics."""
    db.collection(COLLECTION).document(user_id).update(
        {"activity_preferences": preferences}
    )


def set_last_agent_initiated_outbound_at(user_id: str, at: datetime) -> None:
    """Stamp the timestamp used by the 48h agent-nudge budget gate."""
    db.collection(COLLECTION).document(user_id).update(
        {"last_agent_initiated_outbound_at": at}
    )


def is_within_agent_nudge_budget(
    user_id: str,
    *,
    now: datetime,
    window_hours: int,
) -> bool:
    """True if we may send another agent-initiated nudge to this user.

    "Within budget" means: never nudged before, OR the last nudge was longer
    ago than `window_hours`. Scheduled flows the user consented to (post-event
    check-in, confirmation reminder) are NOT counted — they don't update this
    timestamp.
    """
    from datetime import timedelta
    user = get_by_id(user_id)
    if user is None or user.last_agent_initiated_outbound_at is None:
        return True
    return (now - user.last_agent_initiated_outbound_at) >= timedelta(hours=window_hours)
