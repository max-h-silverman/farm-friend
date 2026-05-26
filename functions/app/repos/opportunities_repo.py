"""Opportunities collection + outreach/claims subcollections."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

from google.cloud.firestore import Increment, transactional

from app.firebase_app import db

from ._base import model_to_dict, snapshot_to_model
from .models import (
    ClaimDoc,
    ClaimStatus,
    OpportunityDoc,
    OpportunityKind,
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


def update_fields(opp_id: str, fields: dict) -> None:
    """Generic field update. Used by the clarification flow to merge new
    farmer-supplied details into a draft. The caller is responsible for
    only passing keys that map to OpportunityDoc fields."""
    if not fields:
        return
    db.collection(COLLECTION).document(opp_id).update(fields)


def list_recent_drafts_for_farm(*, farm_id: str, since: datetime) -> list[OpportunityDoc]:
    """Drafts created for this farm since `since`, newest first. Used by the
    clarification flow to find the draft a farmer's reply should merge into."""
    q = (
        db.collection(COLLECTION)
        .where("farm_id", "==", farm_id)
        .where("status", "==", OpportunityStatus.DRAFT.value)
        .where("created_at", ">=", since)
        .order_by("created_at", direction="DESCENDING")
        .limit(5)
    )
    return [snapshot_to_model(s, OpportunityDoc) for s in q.stream() if s.exists]  # type: ignore[misc]


def list_stale_drafts(*, older_than: datetime) -> list[OpportunityDoc]:
    """Drafts created before `older_than`. Used by the stale-draft cleanup
    tick to flag drafts that never completed clarification."""
    q = (
        db.collection(COLLECTION)
        .where("status", "==", OpportunityStatus.DRAFT.value)
        .where("created_at", "<", older_than)
    )
    return [snapshot_to_model(s, OpportunityDoc) for s in q.stream() if s.exists]  # type: ignore[misc]


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


def list_open_for_farm(farm_id: str) -> list[OpportunityDoc]:
    """Open + filling opportunities for a farm. Used by STATUS / EDIT / CANCEL
    handlers to enumerate what the farmer might be referring to."""
    q = (
        db.collection(COLLECTION)
        .where("farm_id", "==", farm_id)
        .where("status", "in", [OpportunityStatus.OPEN.value, OpportunityStatus.FILLING.value])
        .order_by("created_at", direction="DESCENDING")
    )
    return [snapshot_to_model(s, OpportunityDoc) for s in q.stream() if s.exists]  # type: ignore[misc]


def list_unfilled_started(*, now: datetime) -> list[OpportunityDoc]:
    """Open/filling shifts whose start time has passed and whose farmer
    hasn't been notified yet about the unfilled state. Pickups use
    deadline_at and are not returned here."""
    q = (
        db.collection(COLLECTION)
        .where("status", "in", [OpportunityStatus.OPEN.value, OpportunityStatus.FILLING.value])
        .where("farmer_notified_unfilled", "==", False)
        .where("starts_at", "<=", now)
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


# ---------------------------------------------------------------------------
# Transactional claim
# ---------------------------------------------------------------------------
@dataclass(frozen=True, slots=True)
class ClaimOutcome:
    """Result of `try_claim_in_transaction`.

    Tells the caller what actually happened so it can send the right SMS and
    fire the right farmer notifications — all outside the transaction so the
    transaction stays short and only writes Firestore.
    """
    granted_slots: int
    seats_filled_after: int
    headcount_needed: int
    status_after: OpportunityStatus
    just_filled: bool  # True iff this claim was the one that flipped to FULL
    is_waitlist: bool
    is_stale: bool    # opp was completed/cancelled/expired when we read it
    kind: OpportunityKind


def try_claim_in_transaction(
    *,
    opp_id: str,
    volunteer_user_id: str,
    requested_slots: int,
    now: datetime,
) -> ClaimOutcome:
    """Atomically: read the opp, decide seats, write claim + increment + status.

    Firestore retries on contention, so concurrent YES messages serialize and
    can't overshoot headcount_needed. All decisions inside the txn are made
    from the snapshot we read inside the txn (not from a stale in-memory doc).
    """
    opp_ref = db.collection(COLLECTION).document(opp_id)
    claim_ref = opp_ref.collection(CLAIMS_SUB).document(volunteer_user_id)
    txn = db.transaction()

    @transactional
    def _run(transaction) -> ClaimOutcome:
        snap = opp_ref.get(transaction=transaction)
        if not snap.exists:
            raise ValueError(f"opportunity {opp_id} not found")
        opp = snapshot_to_model(snap, OpportunityDoc)
        assert opp is not None

        if opp.status in (
            OpportunityStatus.COMPLETED,
            OpportunityStatus.CANCELLED,
            OpportunityStatus.EXPIRED,
        ):
            return ClaimOutcome(
                granted_slots=0,
                seats_filled_after=opp.seats_filled,
                headcount_needed=opp.headcount_needed,
                status_after=opp.status,
                just_filled=False,
                is_waitlist=False,
                is_stale=True,
                kind=opp.kind,
            )

        seats_left = opp.headcount_needed - opp.seats_filled
        if seats_left <= 0:
            transaction.set(
                claim_ref,
                model_to_dict(
                    ClaimDoc(
                        volunteer_user_id=volunteer_user_id,
                        slots=requested_slots,
                        claimed_at=now,
                        status=ClaimStatus.WAITLIST,
                    )
                ),
            )
            return ClaimOutcome(
                granted_slots=0,
                seats_filled_after=opp.seats_filled,
                headcount_needed=opp.headcount_needed,
                status_after=opp.status,
                just_filled=False,
                is_waitlist=True,
                is_stale=False,
                kind=opp.kind,
            )

        granted = min(requested_slots, seats_left)
        new_filled = opp.seats_filled + granted
        just_filled = new_filled >= opp.headcount_needed
        new_status: OpportunityStatus
        if just_filled:
            new_status = OpportunityStatus.FULL
        elif opp.status == OpportunityStatus.OPEN:
            new_status = OpportunityStatus.FILLING
        else:
            new_status = opp.status

        transaction.set(
            claim_ref,
            model_to_dict(
                ClaimDoc(
                    volunteer_user_id=volunteer_user_id,
                    slots=granted,
                    claimed_at=now,
                    status=ClaimStatus.CONFIRMED,
                )
            ),
        )
        update_payload: dict = {"seats_filled": Increment(granted)}
        if new_status != opp.status:
            update_payload["status"] = new_status.value
        transaction.update(opp_ref, update_payload)

        return ClaimOutcome(
            granted_slots=granted,
            seats_filled_after=new_filled,
            headcount_needed=opp.headcount_needed,
            status_after=new_status,
            just_filled=just_filled,
            is_waitlist=False,
            is_stale=False,
            kind=opp.kind,
        )

    return _run(txn)
