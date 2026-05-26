"""User-raised FLAGs on bad system replies."""

from __future__ import annotations

from datetime import UTC, datetime

from app.firebase_app import db

from ._base import model_to_dict, snapshot_to_model
from .models import FlagDoc


COLLECTION = "flags"


def create(doc: FlagDoc) -> FlagDoc:
    ref = db.collection(COLLECTION).document()
    ref.set(model_to_dict(doc))
    return doc.model_copy(update={"id": ref.id})


def list_open() -> list[FlagDoc]:
    q = db.collection(COLLECTION).where("resolved_at", "==", None)
    return [snapshot_to_model(s, FlagDoc) for s in q.stream() if s.exists]  # type: ignore[misc]


def resolve(flag_id: str) -> None:
    db.collection(COLLECTION).document(flag_id).update({"resolved_at": datetime.now(UTC)})


def is_user_flagged(user_id: str) -> bool:
    """True if the user has any open flag — auto-reply must pause for them."""
    q = (
        db.collection(COLLECTION)
        .where("flagged_by_user_id", "==", user_id)
        .where("resolved_at", "==", None)
        .limit(1)
    )
    return any(True for _ in q.stream())


def has_open_flag_for_message(message_id: str) -> bool:
    """True if there's already an unresolved flag tied to this message_id.
    Used by the stale-draft tick to keep itself idempotent."""
    q = (
        db.collection(COLLECTION)
        .where("message_id", "==", message_id)
        .where("resolved_at", "==", None)
        .limit(1)
    )
    return any(True for _ in q.stream())
