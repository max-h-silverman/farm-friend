"""Per-(opp, date) post-event check-in tracking.

A single-day opp has one post-event ping; that's tracked by the legacy
`OpportunityDoc.post_event_checkin_sent` flag and `post_event_checkin_at`
timestamp on the opp itself. Multi-day window opps need one ping per
day-that-had-a-confirmed-claim, so we use this sidecar collection:

  opportunities/{oppId}/post_event_pings/{YYYY-MM-DD}

The doc id is the ISO date in Vashon-local terms. Presence of the doc means
"we sent the check-in for that day"; absence means "still to do."
"""

from __future__ import annotations

from datetime import datetime

from app.firebase_app import db


COLLECTION = "opportunities"
SUB = "post_event_pings"


def has_ping(*, opp_id: str, date_iso: str) -> bool:
    """True if a ping doc exists for this opp+date."""
    snap = (
        db.collection(COLLECTION)
        .document(opp_id)
        .collection(SUB)
        .document(date_iso)
        .get()
    )
    return snap.exists


def record_ping(*, opp_id: str, date_iso: str, sent_at: datetime) -> None:
    """Idempotent: writes a ping doc for opp+date. The doc id is the date
    so concurrent ticks can't double-write."""
    ref = (
        db.collection(COLLECTION)
        .document(opp_id)
        .collection(SUB)
        .document(date_iso)
    )
    ref.set({"sent_at": sent_at})
