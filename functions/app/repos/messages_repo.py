"""Message log. 90-day TTL is enforced by Firestore's TTL field on `ttl`."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from app.firebase_app import db

from ._base import model_to_dict, snapshot_to_model
from .models import IntentLabel, MessageDoc


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


def list_for_user_since(
    user_id: str, *, since: datetime, hard_cap: int = 20,
) -> list[MessageDoc]:
    """Messages for this user since `since`, newest first, hard-capped.

    Used by the unified-agent context builder to give the LLM enough thread
    history to handle multi-turn dialogs (clarify → answer → confirm) without
    bloating context with old unrelated conversations. The hard cap is a
    safety valve against a pathological burst of messages in the window.
    """
    q = (
        db.collection(COLLECTION)
        .where("user_id", "==", user_id)
        .where("created_at", ">=", since)
        .order_by("created_at", direction="DESCENDING")
        .limit(hard_cap)
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


# ---------------------------------------------------------------------------
# Refactor-introduced helpers (unified agent)
# ---------------------------------------------------------------------------
def latest_outbound_with_intent(
    user_id: str,
    intent_label: IntentLabel,
) -> MessageDoc | None:
    """Most recent outbound to this user with the given intent_label.

    Used by dispatch to find: the live PENDING_CONFIRMATION whose token might
    match an inbound, the live ACTION_RECEIPT whose UNDO window might be open,
    the prior CLARIFY for clarification-round counting.
    """
    q = (
        db.collection(COLLECTION)
        .where("user_id", "==", user_id)
        .where("direction", "==", "outbound")
        .where("intent_label", "==", intent_label.value)
        .order_by("created_at", direction="DESCENDING")
        .limit(1)
    )
    for s in q.stream():
        return snapshot_to_model(s, MessageDoc)
    return None


def count_clarifications_for_user_in_window(
    user_id: str,
    *,
    since: datetime,
) -> int:
    """Count CLARIFY outbounds to this user since `since`. Used by the soft
    per-user 5/24h clarification rail in dispatch."""
    q = (
        db.collection(COLLECTION)
        .where("user_id", "==", user_id)
        .where("direction", "==", "outbound")
        .where("intent_label", "==", IntentLabel.CLARIFY.value)
        .where("created_at", ">=", since)
    )
    return sum(1 for _ in q.stream())
