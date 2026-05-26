"""Farms collection + insiders subcollection."""

from __future__ import annotations

from datetime import UTC, datetime

from app.firebase_app import db

from ._base import model_to_dict, snapshot_to_model
from .models import FarmDoc, InsiderDoc


COLLECTION = "farms"
INSIDERS_SUB = "insiders"


def get_by_id(farm_id: str) -> FarmDoc | None:
    return snapshot_to_model(db.collection(COLLECTION).document(farm_id).get(), FarmDoc)


def get_by_owner(owner_user_id: str) -> FarmDoc | None:
    q = db.collection(COLLECTION).where("owner_user_id", "==", owner_user_id).limit(1)
    for snap in q.stream():
        return snapshot_to_model(snap, FarmDoc)
    return None


def create(doc: FarmDoc) -> FarmDoc:
    ref = db.collection(COLLECTION).document()
    ref.set(model_to_dict(doc))
    return doc.model_copy(update={"id": ref.id})


def add_insider(*, farm_id: str, volunteer_user_id: str) -> None:
    ref = (
        db.collection(COLLECTION)
        .document(farm_id)
        .collection(INSIDERS_SUB)
        .document(volunteer_user_id)
    )
    ref.set(
        {
            "volunteer_user_id": volunteer_user_id,
            "added_at": datetime.now(UTC),
        }
    )


def list_insiders(farm_id: str) -> list[InsiderDoc]:
    snaps = (
        db.collection(COLLECTION)
        .document(farm_id)
        .collection(INSIDERS_SUB)
        .stream()
    )
    return [snapshot_to_model(s, InsiderDoc) for s in snaps if s.exists]  # type: ignore[misc]


def list_all() -> list[FarmDoc]:
    return [snapshot_to_model(s, FarmDoc) for s in db.collection(COLLECTION).stream() if s.exists]  # type: ignore[misc]


def update_defaults(
    farm_id: str,
    *,
    typical_start_hour: int | None,
    typical_shift_duration_min: int | None,
    usual_days_of_week: list[int],
) -> None:
    """Set the onboarding-captured defaults the parser uses to fill gaps."""
    db.collection(COLLECTION).document(farm_id).update(
        {
            "typical_start_hour": typical_start_hour,
            "typical_shift_duration_min": typical_shift_duration_min,
            "usual_days_of_week": usual_days_of_week,
        }
    )
