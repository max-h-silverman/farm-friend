"""Volunteer offers — proactive availability signals from volunteers.

An offer is recorded when a volunteer texts in something like "anyone need
tilling Friday?". Lives until matched to an opportunity, expired, or
cancelled. The review tick scans open offers to suggest matches when an
opp opens up that fits.

Created by the unified-agent refactor; not present in v1.
"""

from __future__ import annotations

from datetime import UTC, datetime

from app.firebase_app import db

from ._base import model_to_dict, snapshot_to_model
from .models import OfferDoc


COLLECTION = "offers"


def create(doc: OfferDoc) -> OfferDoc:
    ref = db.collection(COLLECTION).document()
    ref.set(model_to_dict(doc))
    return doc.model_copy(update={"id": ref.id})


def get_by_id(offer_id: str) -> OfferDoc | None:
    return snapshot_to_model(db.collection(COLLECTION).document(offer_id).get(), OfferDoc)


def list_open_for_volunteer(volunteer_user_id: str) -> list[OfferDoc]:
    q = (
        db.collection(COLLECTION)
        .where("volunteer_user_id", "==", volunteer_user_id)
        .where("status", "==", "open")
    )
    return [snapshot_to_model(s, OfferDoc) for s in q.stream() if s.exists]  # type: ignore[misc]


def list_open_matching(
    *,
    activity: str | None = None,
    starts_at: datetime | None = None,
) -> list[OfferDoc]:
    """Find open offers that *might* match an opp.

    Activity match is exact on the canonical slug. Time match is loose: we
    require the offer's window (if set) to contain `starts_at`. Returns
    candidates; the caller decides whether to actually surface a suggestion.
    """
    q = db.collection(COLLECTION).where("status", "==", "open")
    out: list[OfferDoc] = []
    for snap in q.stream():
        offer = snapshot_to_model(snap, OfferDoc)
        if offer is None:
            continue
        if activity and activity not in offer.activity_tags:
            continue
        if starts_at is not None:
            if offer.earliest_at is not None and starts_at < offer.earliest_at:
                continue
            if offer.latest_at is not None and starts_at > offer.latest_at:
                continue
        out.append(offer)
    return out


def list_open_aged(since: datetime) -> list[OfferDoc]:
    """Open offers created before `since` — used by the review tick to find
    offers that have been sitting unmatched and should be surfaced to admin."""
    q = (
        db.collection(COLLECTION)
        .where("status", "==", "open")
        .where("created_at", "<", since)
    )
    return [snapshot_to_model(s, OfferDoc) for s in q.stream() if s.exists]  # type: ignore[misc]


def set_status(
    offer_id: str,
    *,
    status: str,
    matched_opportunity_id: str | None = None,
) -> None:
    update: dict = {"status": status, "status_changed_at": datetime.now(UTC)}
    if matched_opportunity_id is not None:
        update["matched_opportunity_id"] = matched_opportunity_id
    db.collection(COLLECTION).document(offer_id).update(update)


def expire_past(now: datetime) -> int:
    """Mark offers whose expires_at has passed as expired. Returns the count.

    Called from the review tick or a dedicated maintenance tick — the choice
    is left to the caller; either is correct.
    """
    q = (
        db.collection(COLLECTION)
        .where("status", "==", "open")
        .where("expires_at", "<", now)
    )
    count = 0
    for snap in q.stream():
        snap.reference.update({"status": "expired", "status_changed_at": now})
        count += 1
    return count
