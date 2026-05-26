"""Message log. 90-day TTL is enforced by Firestore's TTL field on `ttl`."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from app.firebase_app import db

from ._base import model_to_dict, snapshot_to_model
from .models import MessageDoc


COLLECTION = "messages"
DEFAULT_TTL_DAYS = 90


def create(doc: MessageDoc) -> MessageDoc:
    if doc.ttl is None:
        doc = doc.model_copy(update={"ttl": doc.created_at + timedelta(days=DEFAULT_TTL_DAYS)})
    ref = db.collection(COLLECTION).document()
    ref.set(model_to_dict(doc))
    return doc.model_copy(update={"id": ref.id})


def get_by_id(message_id: str) -> MessageDoc | None:
    return snapshot_to_model(db.collection(COLLECTION).document(message_id).get(), MessageDoc)


def list_for_user(user_id: str, *, limit: int = 50) -> list[MessageDoc]:
    q = (
        db.collection(COLLECTION)
        .where("user_id", "==", user_id)
        .order_by("created_at", direction="DESCENDING")
        .limit(limit)
    )
    return [snapshot_to_model(s, MessageDoc) for s in q.stream() if s.exists]  # type: ignore[misc]


def list_for_opportunity(opp_id: str, *, limit: int = 200) -> list[MessageDoc]:
    q = (
        db.collection(COLLECTION)
        .where("opportunity_id", "==", opp_id)
        .order_by("created_at", direction="DESCENDING")
        .limit(limit)
    )
    return [snapshot_to_model(s, MessageDoc) for s in q.stream() if s.exists]  # type: ignore[misc]


def exists_by_provider_msg_id(provider_msg_id: str) -> bool:
    """True if any message (inbound or outbound) with this provider_msg_id is
    already on file. Used to make the inbound webhook idempotent against
    Telnyx retries that double-deliver the same SMS."""
    if not provider_msg_id:
        return False
    q = (
        db.collection(COLLECTION)
        .where("provider_msg_id", "==", provider_msg_id)
        .limit(1)
    )
    return any(True for _ in q.stream())


def latest_outbound_for_user(user_id: str) -> MessageDoc | None:
    """Used to determine which opportunity a YES is in reply to."""
    q = (
        db.collection(COLLECTION)
        .where("user_id", "==", user_id)
        .where("direction", "==", "outbound")
        .order_by("created_at", direction="DESCENDING")
        .limit(1)
    )
    for s in q.stream():
        return snapshot_to_model(s, MessageDoc)
    return None


def count_outbound_since(since: datetime) -> int:
    q = (
        db.collection(COLLECTION)
        .where("direction", "==", "outbound")
        .where("created_at", ">=", since)
    )
    return sum(1 for _ in q.stream())
