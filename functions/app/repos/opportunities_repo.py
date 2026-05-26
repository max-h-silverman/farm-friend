"""Opportunities collection + outreach/claims subcollections."""

from __future__ import annotations

from datetime import datetime

from google.cloud.firestore import Increment

from app.firebase_app import db

from ._base import model_to_dict, snapshot_to_model
from .models import (
    ClaimDoc,
    ClaimStatus,
    OpportunityDoc,
    OpportunityStatus,
    OutreachLogDoc,
    OutreachTier,
)


COLLECTION = "opportunities"
OUTREACH_SUB = "outreach"
CLAIMS_SUB = "claims"


def get_by_id(opp_id: str) -> OpportunityDoc | None:
    return snapshot_to_model(db.collection(COLLECTION).document(opp_id).get(), OpportunityDoc)


def create(doc: OpportunityDoc) -> OpportunityDoc:
    ref = db.collection(COLLECTION).document()
    ref.set(model_to_dict(doc))
    return doc.model_copy(update={"id": ref.id})


def update_status(opp_id: str, status: OpportunityStatus) -> None:
    db.collection(COLLECTION).document(opp_id).update({"status": status.value})


def set_next_escalation(opp_id: str, *, at: datetime | None, tier: OutreachTier) -> None:
    db.collection(COLLECTION).document(opp_id).update(
        {
            "next_escalation_at": at,
            "current_tier": tier.value,
        }
    )


def increment_seats(opp_id: str, *, by: int) -> None:
    db.collection(COLLECTION).document(opp_id).update({"seats_filled": Increment(by)})


def mark_post_event_sent(opp_id: str) -> None:
    db.collection(COLLECTION).document(opp_id).update({"post_event_checkin_sent": True})


def list_due_for_escalation(*, now: datetime) -> list[OpportunityDoc]:
    """Opportunities whose escalation timer has fired and still need help."""
    q = (
        db.collection(COLLECTION)
        .where("status", "in", [OpportunityStatus.OPEN.value, OpportunityStatus.FILLING.value])
        .where("next_escalation_at", "<=", now)
    )
    return [snapshot_to_model(s, OpportunityDoc) for s in q.stream() if s.exists]  # type: ignore[misc]


def list_due_for_post_event(*, now: datetime) -> list[OpportunityDoc]:
    """Completed-or-past opportunities whose post-event checkin should fire now."""
    q = (
        db.collection(COLLECTION)
        .where("post_event_checkin_sent", "==", False)
        .where("post_event_checkin_at", "<=", now)
    )
    return [snapshot_to_model(s, OpportunityDoc) for s in q.stream() if s.exists]  # type: ignore[misc]


# ---------------------------------------------------------------------------
# Outreach log
# ---------------------------------------------------------------------------
def log_outreach(*, opp_id: str, entry: OutreachLogDoc) -> None:
    ref = db.collection(COLLECTION).document(opp_id).collection(OUTREACH_SUB).document()
    ref.set(model_to_dict(entry))


def list_outreach(opp_id: str) -> list[OutreachLogDoc]:
    snaps = db.collection(COLLECTION).document(opp_id).collection(OUTREACH_SUB).stream()
    return [snapshot_to_model(s, OutreachLogDoc) for s in snaps if s.exists]  # type: ignore[misc]


# ---------------------------------------------------------------------------
# Claims
# ---------------------------------------------------------------------------
def upsert_claim(*, opp_id: str, claim: ClaimDoc) -> None:
    ref = (
        db.collection(COLLECTION)
        .document(opp_id)
        .collection(CLAIMS_SUB)
        .document(claim.volunteer_user_id)
    )
    ref.set(model_to_dict(claim))


def get_claim(*, opp_id: str, volunteer_user_id: str) -> ClaimDoc | None:
    snap = (
        db.collection(COLLECTION)
        .document(opp_id)
        .collection(CLAIMS_SUB)
        .document(volunteer_user_id)
        .get()
    )
    return snapshot_to_model(snap, ClaimDoc)


def list_confirmed_claims(opp_id: str) -> list[ClaimDoc]:
    q = (
        db.collection(COLLECTION)
        .document(opp_id)
        .collection(CLAIMS_SUB)
        .where("status", "==", ClaimStatus.CONFIRMED.value)
    )
    return [snapshot_to_model(s, ClaimDoc) for s in q.stream() if s.exists]  # type: ignore[misc]


def list_all_claims(opp_id: str) -> list[ClaimDoc]:
    snaps = db.collection(COLLECTION).document(opp_id).collection(CLAIMS_SUB).stream()
    return [snapshot_to_model(s, ClaimDoc) for s in snaps if s.exists]  # type: ignore[misc]
