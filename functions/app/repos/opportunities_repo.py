"""Opportunities collection + outreach/claims subcollections."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timedelta

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


log = logging.getLogger(__name__)


COLLECTION = "opportunities"
OUTREACH_SUB = "outreach"
CLAIMS_SUB = "claims"


def _parent_exists(opp_id: str) -> bool:
    """True iff the opportunity doc actually exists.

    Used as a guard before subcollection writes so we don't create phantom
    parents — docs that have no fields but hold a path because a child was
    written under them. Phantoms show up in the Firebase console as italic
    `(missing)` entries and pollute collection listings; they also slip
    past `.stream()` queries in some SDK versions.
    """
    return db.collection(COLLECTION).document(opp_id).get().exists


def _claim_doc_id(*, volunteer_user_id: str, scheduled_for_at: datetime | None) -> str:
    """Pick the claim subcollection doc id.

    Single-day opp (no scheduled_for_at): `{volunteer_user_id}`.
    Window opp: `{volunteer_user_id}_{YYYY-MM-DD}` — lets one volunteer
    claim multiple days on the same opp without collision.

    The date component is the LOCAL Vashon date of `scheduled_for_at`. This
    matters because a 9am Vashon shift on Wed is 16:00 UTC Wed — same UTC
    date as the local date — but an early-evening shift (say 6pm Vashon
    Wed) is 1:00 UTC Thu, which would split a "Wed shift" across two
    Firestore doc IDs if we used the UTC date. We always want the
    farmer's intuition ("Wed shift") to map to a single doc.
    """
    if scheduled_for_at is None:
        return volunteer_user_id
    from app.flows._time import to_local
    local = to_local(scheduled_for_at)
    return f"{volunteer_user_id}_{local.date().isoformat()}"


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
    only passing keys that map to OpportunityDoc fields.

    Stamps `last_updated_at` automatically so the stale-draft tick can use
    activity (not creation time) as its staleness clock.
    """
    if not fields:
        return
    from datetime import UTC, datetime as _dt
    payload = {**fields, "last_updated_at": _dt.now(UTC)}
    db.collection(COLLECTION).document(opp_id).update(payload)


def append_media_urls(opp_id: str, media_urls: list[str]) -> list[str]:
    """Append farmer-supplied media URLs to an opportunity, preserving order.

    We read/merge instead of using ArrayUnion so duplicate URLs are removed
    deterministically and the existing order remains stable for outbound MMS.
    Returns the URLs that were newly added.
    """
    if not media_urls:
        return []
    opp = get_by_id(opp_id)
    if opp is None:
        return []
    existing = set(opp.media_urls)
    newly_added = [url for url in media_urls if url and url not in existing]
    if not newly_added:
        return []
    merged = _merge_unique_urls(opp.media_urls, media_urls)
    update_fields(opp_id, {"media_urls": merged})
    return newly_added


def _merge_unique_urls(existing: list[str], incoming: list[str]) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for url in [*existing, *incoming]:
        if not url or url in seen:
            continue
        seen.add(url)
        out.append(url)
    return out


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
    """Drafts whose last activity is before `older_than`. Used by the
    stale-draft tick to flag drafts the farmer has gone quiet on.

    The staleness clock is `last_updated_at` if set, falling back to
    `created_at` for legacy drafts written before that field existed.
    Filtering uses `created_at < older_than` as the Firestore query (cheap),
    then we filter in-app on `last_updated_at` so we don't drop drafts
    that are old by creation but recently touched.
    """
    q = (
        db.collection(COLLECTION)
        .where("status", "==", OpportunityStatus.DRAFT.value)
        .where("created_at", "<", older_than)
    )
    out: list[OpportunityDoc] = []
    for snap in q.stream():
        if not snap.exists:
            continue
        opp = snapshot_to_model(snap, OpportunityDoc)
        if opp is None:
            continue
        # last_updated_at supersedes created_at when present.
        clock = opp.last_updated_at or opp.created_at
        if clock < older_than:
            out.append(opp)
    return out


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


def increment_agent_nudges_sent(opp_id: str, *, by: int = 1) -> None:
    """Atomic increment of the per-opp nudge counter. Called after a review-tick
    AGENT_NUDGE outbound for this opp has successfully sent (safe_send returned
    a non-None provider id). The 2-per-opp cap is enforced in dispatch by
    reading the current value before drafting."""
    db.collection(COLLECTION).document(opp_id).update({"agent_nudges_sent": Increment(by)})


def list_due_for_escalation(*, now: datetime) -> list[OpportunityDoc]:
    """Opportunities whose escalation timer has fired and still need help."""
    q = (
        db.collection(COLLECTION)
        .where("status", "in", [OpportunityStatus.OPEN.value, OpportunityStatus.FILLING.value])
        .where("next_escalation_at", "<=", now)
    )
    return [snapshot_to_model(s, OpportunityDoc) for s in q.stream() if s.exists]  # type: ignore[misc]


def list_due_for_post_event(*, now: datetime) -> list[OpportunityDoc]:
    """Completed-or-past opportunities whose post-event checkin should fire now.

    Single-day path: uses the legacy `post_event_checkin_sent` opp-level flag.
    Window opps continue to appear here on their last-day checkin time (set
    when the opp was created) but per-day idempotency is delegated to the
    `post_event_pings` sidecar — see `list_window_opps_in_progress` for the
    catch-up surface.
    """
    q = (
        db.collection(COLLECTION)
        .where("post_event_checkin_sent", "==", False)
        .where("post_event_checkin_at", "<=", now)
    )
    return [snapshot_to_model(s, OpportunityDoc) for s in q.stream() if s.exists]  # type: ignore[misc]


def list_window_opps_in_progress(*, now: datetime) -> list[OpportunityDoc]:
    """Window opps whose first day has started — the tick walks per-day claims
    against the sidecar to decide what's still to ping.

    Query is `kind=shift AND starts_at <= now`; we filter window-only in app
    code because Firestore can't reliably distinguish "field is set" from
    "field is missing" on legacy docs without extra indexing. Pilot scale
    makes the in-memory filter fine.
    """
    q = (
        db.collection(COLLECTION)
        .where("kind", "==", OpportunityKind.SHIFT.value)
        .where("starts_at", "<=", now)
    )
    out: list[OpportunityDoc] = []
    for snap in q.stream():
        if not snap.exists:
            continue
        opp = snapshot_to_model(snap, OpportunityDoc)
        if opp is None or opp.window_end_at is None:
            continue
        out.append(opp)
    return out


def list_upcoming_window_opps(*, now: datetime) -> list[OpportunityDoc]:
    """Window opps whose first day is still in the future.

    Used by the proposal auto-confirm tick: PROPOSED claims can age before the
    first day of the window starts, so the in-progress query is not enough.
    """
    q = (
        db.collection(COLLECTION)
        .where("kind", "==", OpportunityKind.SHIFT.value)
        .where("starts_at", ">=", now)
    )
    out: list[OpportunityDoc] = []
    for snap in q.stream():
        if not snap.exists:
            continue
        opp = snapshot_to_model(snap, OpportunityDoc)
        if opp is None or opp.window_end_at is None:
            continue
        out.append(opp)
    return out


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


def list_opps_due_for_confirmation(
    *,
    now: datetime,
    shift_lead_time: timedelta,
    pickup_lead_time: timedelta,
) -> list[OpportunityDoc]:
    """Opportunities whose event is within the confirmation-reminder window.

    Single-day shifts: `now <= starts_at <= now + shift_lead_time`.
    Pickups:           `now <= deadline_at <= now + pickup_lead_time`.
    Window shifts:     anything where any day in the window is within the
                       lead time — gated below by checking each CONFIRMED
                       claim's `scheduled_for_at`.

    Returns OPEN/FILLING/FULL opps. The caller iterates each opp's confirmed
    claims and decides per-claim whether the lead-time window applies.
    """
    # Single-day shifts: starts_at falls in the window. Window shifts whose
    # FIRST day is within the lead time also match; window shifts whose only
    # in-window day is later get caught by the all-active-window query below.
    shift_q = (
        db.collection(COLLECTION)
        .where("kind", "==", OpportunityKind.SHIFT.value)
        .where(
            "status", "in",
            [OpportunityStatus.OPEN.value, OpportunityStatus.FILLING.value, OpportunityStatus.FULL.value],
        )
        .where("starts_at", ">=", now)
        .where("starts_at", "<=", now + shift_lead_time)
    )
    # Window shifts whose window_end_at is in the future and whose starts_at
    # is in the past — i.e. windows currently in flight, where any of the
    # remaining days could be reaching the lead-time window. Filtering by
    # individual day happens in `_process_opp` via claim.scheduled_for_at.
    window_active_q = (
        db.collection(COLLECTION)
        .where("kind", "==", OpportunityKind.SHIFT.value)
        .where(
            "status", "in",
            [OpportunityStatus.OPEN.value, OpportunityStatus.FILLING.value, OpportunityStatus.FULL.value],
        )
        .where("window_end_at", ">=", now)
        .where("starts_at", "<=", now + shift_lead_time)
    )
    pickup_q = (
        db.collection(COLLECTION)
        .where("kind", "==", OpportunityKind.PICKUP.value)
        .where(
            "status", "in",
            [OpportunityStatus.OPEN.value, OpportunityStatus.FILLING.value, OpportunityStatus.FULL.value],
        )
        .where("deadline_at", ">=", now)
        .where("deadline_at", "<=", now + pickup_lead_time)
    )
    seen: set[str] = set()
    results: list[OpportunityDoc] = []
    for q in (shift_q, window_active_q, pickup_q):
        for snap in q.stream():
            if not snap.exists or snap.id in seen:
                continue
            seen.add(snap.id)
            opp = snapshot_to_model(snap, OpportunityDoc)
            if opp is not None:
                results.append(opp)
    return results


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
    """Append an outreach-log entry. No-ops with a warning if the parent
    opportunity doc no longer exists (prevents phantom-parent creation —
    see `_parent_exists`)."""
    if not _parent_exists(opp_id):
        log.warning(
            "log_outreach skipped: parent opportunity %s does not exist", opp_id,
        )
        return
    ref = db.collection(COLLECTION).document(opp_id).collection(OUTREACH_SUB).document()
    ref.set(model_to_dict(entry))


def list_outreach(opp_id: str) -> list[OutreachLogDoc]:
    snaps = db.collection(COLLECTION).document(opp_id).collection(OUTREACH_SUB).stream()
    return [snapshot_to_model(s, OutreachLogDoc) for s in snaps if s.exists]  # type: ignore[misc]


# ---------------------------------------------------------------------------
# Claims
# ---------------------------------------------------------------------------
def upsert_claim(*, opp_id: str, claim: ClaimDoc) -> None:
    """Write a claim doc. Doc id derives from (volunteer_user_id, scheduled_for_at)
    via _claim_doc_id so window-opp claims for different days coexist.

    No-ops with a warning if the parent opportunity doc no longer exists
    (prevents phantom-parent creation — see `_parent_exists`).
    """
    if not _parent_exists(opp_id):
        log.warning(
            "upsert_claim skipped: parent opportunity %s does not exist", opp_id,
        )
        return
    doc_id = _claim_doc_id(
        volunteer_user_id=claim.volunteer_user_id,
        scheduled_for_at=claim.scheduled_for_at,
    )
    ref = (
        db.collection(COLLECTION)
        .document(opp_id)
        .collection(CLAIMS_SUB)
        .document(doc_id)
    )
    ref.set(model_to_dict(claim))


def get_claim(
    *,
    opp_id: str,
    volunteer_user_id: str,
    scheduled_for_at: datetime | None = None,
) -> ClaimDoc | None:
    """Fetch a claim doc. For window opps, pass `scheduled_for_at` to disambiguate.
    For single-day opps, leave it None and we look up by volunteer_user_id alone."""
    doc_id = _claim_doc_id(
        volunteer_user_id=volunteer_user_id,
        scheduled_for_at=scheduled_for_at,
    )
    snap = (
        db.collection(COLLECTION)
        .document(opp_id)
        .collection(CLAIMS_SUB)
        .document(doc_id)
        .get()
    )
    return snapshot_to_model(snap, ClaimDoc)


def get_claim_by_doc_id(*, opp_id: str, claim_doc_id: str) -> ClaimDoc | None:
    """Fetch a claim when the caller already has the exact subcollection doc id."""
    snap = (
        db.collection(COLLECTION)
        .document(opp_id)
        .collection(CLAIMS_SUB)
        .document(claim_doc_id)
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
# Candidate-day voting (docs/preferred-day-voting.md)
# ---------------------------------------------------------------------------
def add_day_vote(
    *,
    opp_id: str,
    volunteer_user_id: str,
    scheduled_for_at: datetime,
) -> None:
    """Record a soft DAY_VOTE for one candidate day. Idempotent per
    (volunteer, day) via the day-scoped claim doc id; re-voting the same day
    is a harmless overwrite. Holds no seat — does not touch seats_filled /
    seats_held. Resolution to CONFIRMED happens at farmer lock-in."""
    from datetime import UTC
    upsert_claim(
        opp_id=opp_id,
        claim=ClaimDoc(
            volunteer_user_id=volunteer_user_id,
            status=ClaimStatus.DAY_VOTE,
            scheduled_for_at=scheduled_for_at,
            claimed_at=datetime.now(UTC),
        ),
    )


def list_day_votes(opp_id: str) -> list[ClaimDoc]:
    """All DAY_VOTE claims for an opp (across all candidate days)."""
    q = (
        db.collection(COLLECTION)
        .document(opp_id)
        .collection(CLAIMS_SUB)
        .where("status", "==", ClaimStatus.DAY_VOTE.value)
    )
    return [snapshot_to_model(s, ClaimDoc) for s in q.stream() if s.exists]  # type: ignore[misc]


def day_vote_tally(opp_id: str) -> dict[str, int]:
    """Count of DAY_VOTEs per candidate day, keyed by the LOCAL Vashon ISO
    date (matching `_claim_doc_id`'s day component). Greedy assignment reads
    this; the highest count (preference breaks ties) is the lock candidate."""
    from app.flows._time import to_local
    tally: dict[str, int] = {}
    for vote in list_day_votes(opp_id):
        if vote.scheduled_for_at is None:
            continue
        day_key = to_local(vote.scheduled_for_at).date().isoformat()
        tally[day_key] = tally.get(day_key, 0) + 1
    return tally


def mark_confirmation_sent(
    *,
    opp_id: str,
    volunteer_user_id: str,
    at: datetime,
    scheduled_for_at: datetime | None = None,
) -> None:
    """Stamp `confirmation_sent_at` on a single claim. Used by the confirmation
    tick to avoid double-pinging. Pass `scheduled_for_at` for window claims."""
    doc_id = _claim_doc_id(
        volunteer_user_id=volunteer_user_id,
        scheduled_for_at=scheduled_for_at,
    )
    ref = (
        db.collection(COLLECTION)
        .document(opp_id)
        .collection(CLAIMS_SUB)
        .document(doc_id)
    )
    ref.update({"confirmation_sent_at": at})


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
    scheduled_for_at: datetime | None = None,
    target_status: ClaimStatus = ClaimStatus.CONFIRMED,
) -> ClaimOutcome:
    """Atomically: read the opp, decide seats, write claim + increment + status.

    Two modes:
      - `target_status=CONFIRMED` (single-day opps, default): increments
        `seats_filled` and `seats_held`; flips FULL when `seats_filled` hits
        `headcount_needed`. Capacity gated by `headcount_needed - seats_filled`.
      - `target_status=PROPOSED` (window-opp claims awaiting farmer ACCEPT):
        increments `seats_held` only — `seats_filled` and FULL transitions
        stay gated on farmer-confirmed claims. Capacity gated by
        `headcount_needed - seats_held` (don't propose more than the farmer
        asked for, even before they decide).

    For window opps, `scheduled_for_at` MUST be set; it scopes the claim doc
    id and is persisted on the claim. For single-day opps, leave None.

    Firestore retries on contention, so concurrent YES messages serialize and
    can't overshoot capacity. All decisions inside the txn are made from the
    snapshot we read inside the txn (not from a stale in-memory doc).
    """
    opp_ref = db.collection(COLLECTION).document(opp_id)
    claim_doc_id = _claim_doc_id(
        volunteer_user_id=volunteer_user_id, scheduled_for_at=scheduled_for_at,
    )
    claim_ref = opp_ref.collection(CLAIMS_SUB).document(claim_doc_id)
    txn = db.transaction()
    is_proposal = target_status == ClaimStatus.PROPOSED

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

        # Capacity counter differs by mode: PROPOSED gates on seats_held so
        # we don't over-propose; CONFIRMED gates on seats_filled.
        capacity_used = opp.seats_held if is_proposal else opp.seats_filled
        seats_left = opp.headcount_needed - capacity_used
        if seats_left <= 0:
            transaction.set(
                claim_ref,
                model_to_dict(
                    ClaimDoc(
                        volunteer_user_id=volunteer_user_id,
                        slots=requested_slots,
                        claimed_at=now,
                        status=ClaimStatus.WAITLIST,
                        scheduled_for_at=scheduled_for_at,
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
        # seats_filled only moves on CONFIRMED claims. PROPOSED claims move
        # seats_held alone — farmer ACCEPT promotes them to CONFIRMED and
        # bumps seats_filled at that point.
        if is_proposal:
            new_filled = opp.seats_filled
            just_filled = False
        else:
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
                    status=target_status,
                    scheduled_for_at=scheduled_for_at,
                )
            ),
        )
        update_payload: dict = {"seats_held": Increment(granted)}
        if not is_proposal:
            update_payload["seats_filled"] = Increment(granted)
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


@dataclass(frozen=True, slots=True)
class DropOutcome:
    dropped: bool                         # False if the claim wasn't CONFIRMED to begin with
    seats_filled_after: int
    headcount_needed: int
    status_after: OpportunityStatus
    reopened: bool                        # True iff status flipped FULL -> FILLING / OPEN -> FILLING


def drop_confirmed_claim_in_transaction(
    *,
    opp_id: str,
    volunteer_user_id: str,
    now: datetime,
    scheduled_for_at: datetime | None = None,
) -> DropOutcome:
    """Atomically drop a CONFIRMED claim: set status=DROPPED, decrement
    seats_filled AND seats_held, and unwind opp status (FULL -> FILLING) if
    applicable. If the claim doesn't exist or isn't CONFIRMED, returns
    dropped=False.

    For window opps, pass `scheduled_for_at` to target the right per-day claim.
    """
    opp_ref = db.collection(COLLECTION).document(opp_id)
    claim_doc_id = _claim_doc_id(
        volunteer_user_id=volunteer_user_id, scheduled_for_at=scheduled_for_at,
    )
    claim_ref = opp_ref.collection(CLAIMS_SUB).document(claim_doc_id)
    txn = db.transaction()

    @transactional
    def _run(transaction) -> DropOutcome:
        opp_snap = opp_ref.get(transaction=transaction)
        claim_snap = claim_ref.get(transaction=transaction)
        if not opp_snap.exists or not claim_snap.exists:
            opp = snapshot_to_model(opp_snap, OpportunityDoc)
            return DropOutcome(
                dropped=False,
                seats_filled_after=opp.seats_filled if opp else 0,
                headcount_needed=opp.headcount_needed if opp else 0,
                status_after=opp.status if opp else OpportunityStatus.OPEN,
                reopened=False,
            )
        opp = snapshot_to_model(opp_snap, OpportunityDoc)
        claim = snapshot_to_model(claim_snap, ClaimDoc)
        assert opp is not None and claim is not None
        if claim.status != ClaimStatus.CONFIRMED:
            return DropOutcome(
                dropped=False,
                seats_filled_after=opp.seats_filled,
                headcount_needed=opp.headcount_needed,
                status_after=opp.status,
                reopened=False,
            )

        slots = max(1, claim.slots)
        new_filled = max(0, opp.seats_filled - slots)
        # Unwind status. A dropped seat from FULL means we're back to FILLING
        # (someone was already filled, so it's not OPEN). FILLING stays FILLING.
        new_status: OpportunityStatus
        if opp.status == OpportunityStatus.FULL:
            new_status = OpportunityStatus.FILLING
        else:
            new_status = opp.status
        reopened = new_status != opp.status

        transaction.update(claim_ref, {"status": ClaimStatus.DROPPED.value})
        update_payload: dict = {
            "seats_filled": Increment(-slots),
            "seats_held": Increment(-slots),
        }
        if reopened:
            update_payload["status"] = new_status.value
        transaction.update(opp_ref, update_payload)

        return DropOutcome(
            dropped=True,
            seats_filled_after=new_filled,
            headcount_needed=opp.headcount_needed,
            status_after=new_status,
            reopened=reopened,
        )

    return _run(txn)


# ---------------------------------------------------------------------------
# Proposal decisions (window-opp farmer-approval gate)
# ---------------------------------------------------------------------------
@dataclass(frozen=True, slots=True)
class ProposalDecisionOutcome:
    """Result of accept/decline against a PROPOSED claim."""
    found: bool                              # False if doc missing or not PROPOSED
    was_already_decided: bool                # True if already CONFIRMED or DROPPED
    seats_filled_after: int
    seats_held_after: int
    headcount_needed: int
    status_after: OpportunityStatus
    just_filled: bool                        # accept only: did this flip to FULL?
    slots: int                               # the claim's slots count


def accept_proposal_in_transaction(
    *,
    opp_id: str,
    claim_doc_id: str,
    now: datetime,
) -> ProposalDecisionOutcome:
    """Atomically promote a PROPOSED claim to CONFIRMED.

    `claim_doc_id` is the full subcollection doc id (composite for window opps,
    bare volunteer_user_id for single-day). The caller looks it up via the
    proposal token's persisted reference.

    Increments `seats_filled` (PROPOSED→CONFIRMED promotion); `seats_held` is
    unchanged because the claim already counted there as PROPOSED. Flips opp
    status to FULL when seats_filled hits headcount_needed.
    """
    opp_ref = db.collection(COLLECTION).document(opp_id)
    claim_ref = opp_ref.collection(CLAIMS_SUB).document(claim_doc_id)
    txn = db.transaction()

    @transactional
    def _run(transaction) -> ProposalDecisionOutcome:
        opp_snap = opp_ref.get(transaction=transaction)
        claim_snap = claim_ref.get(transaction=transaction)
        if not opp_snap.exists or not claim_snap.exists:
            opp = snapshot_to_model(opp_snap, OpportunityDoc)
            return ProposalDecisionOutcome(
                found=False,
                was_already_decided=False,
                seats_filled_after=opp.seats_filled if opp else 0,
                seats_held_after=opp.seats_held if opp else 0,
                headcount_needed=opp.headcount_needed if opp else 0,
                status_after=opp.status if opp else OpportunityStatus.OPEN,
                just_filled=False,
                slots=0,
            )
        opp = snapshot_to_model(opp_snap, OpportunityDoc)
        claim = snapshot_to_model(claim_snap, ClaimDoc)
        assert opp is not None and claim is not None
        if claim.status != ClaimStatus.PROPOSED:
            return ProposalDecisionOutcome(
                found=True,
                was_already_decided=True,
                seats_filled_after=opp.seats_filled,
                seats_held_after=opp.seats_held,
                headcount_needed=opp.headcount_needed,
                status_after=opp.status,
                just_filled=False,
                slots=claim.slots,
            )

        slots = max(1, claim.slots)
        new_filled = opp.seats_filled + slots
        just_filled = new_filled >= opp.headcount_needed
        new_status: OpportunityStatus
        if just_filled:
            new_status = OpportunityStatus.FULL
        elif opp.status == OpportunityStatus.OPEN:
            new_status = OpportunityStatus.FILLING
        else:
            new_status = opp.status

        transaction.update(claim_ref, {"status": ClaimStatus.CONFIRMED.value})
        update_payload: dict = {"seats_filled": Increment(slots)}
        if new_status != opp.status:
            update_payload["status"] = new_status.value
        transaction.update(opp_ref, update_payload)

        return ProposalDecisionOutcome(
            found=True,
            was_already_decided=False,
            seats_filled_after=new_filled,
            seats_held_after=opp.seats_held,
            headcount_needed=opp.headcount_needed,
            status_after=new_status,
            just_filled=just_filled,
            slots=slots,
        )

    return _run(txn)


def decline_proposal_in_transaction(
    *,
    opp_id: str,
    claim_doc_id: str,
    now: datetime,
) -> ProposalDecisionOutcome:
    """Atomically drop a PROPOSED claim (farmer declined).

    Decrements `seats_held` (the proposed seat is released) but leaves
    `seats_filled` unchanged because PROPOSED never counted there.
    """
    opp_ref = db.collection(COLLECTION).document(opp_id)
    claim_ref = opp_ref.collection(CLAIMS_SUB).document(claim_doc_id)
    txn = db.transaction()

    @transactional
    def _run(transaction) -> ProposalDecisionOutcome:
        opp_snap = opp_ref.get(transaction=transaction)
        claim_snap = claim_ref.get(transaction=transaction)
        if not opp_snap.exists or not claim_snap.exists:
            opp = snapshot_to_model(opp_snap, OpportunityDoc)
            return ProposalDecisionOutcome(
                found=False,
                was_already_decided=False,
                seats_filled_after=opp.seats_filled if opp else 0,
                seats_held_after=opp.seats_held if opp else 0,
                headcount_needed=opp.headcount_needed if opp else 0,
                status_after=opp.status if opp else OpportunityStatus.OPEN,
                just_filled=False,
                slots=0,
            )
        opp = snapshot_to_model(opp_snap, OpportunityDoc)
        claim = snapshot_to_model(claim_snap, ClaimDoc)
        assert opp is not None and claim is not None
        if claim.status != ClaimStatus.PROPOSED:
            return ProposalDecisionOutcome(
                found=True,
                was_already_decided=True,
                seats_filled_after=opp.seats_filled,
                seats_held_after=opp.seats_held,
                headcount_needed=opp.headcount_needed,
                status_after=opp.status,
                just_filled=False,
                slots=claim.slots,
            )

        slots = max(1, claim.slots)
        new_held = max(0, opp.seats_held - slots)

        transaction.update(claim_ref, {"status": ClaimStatus.DROPPED.value})
        transaction.update(opp_ref, {"seats_held": Increment(-slots)})

        return ProposalDecisionOutcome(
            found=True,
            was_already_decided=False,
            seats_filled_after=opp.seats_filled,
            seats_held_after=new_held,
            headcount_needed=opp.headcount_needed,
            status_after=opp.status,
            just_filled=False,
            slots=slots,
        )

    return _run(txn)


def list_proposed_claims(opp_id: str) -> list[ClaimDoc]:
    """All PROPOSED claims on an opp. Used by tick_proposals for auto-confirm."""
    q = (
        db.collection(COLLECTION)
        .document(opp_id)
        .collection(CLAIMS_SUB)
        .where("status", "==", ClaimStatus.PROPOSED.value)
    )
    return [snapshot_to_model(s, ClaimDoc) for s in q.stream() if s.exists]  # type: ignore[misc]
