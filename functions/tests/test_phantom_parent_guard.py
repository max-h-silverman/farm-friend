"""Tests for the phantom-parent guard on opportunity subcollection writes.

Background: in Firestore, writing to `parent/{id}/sub/{doc}` creates a
phantom parent at `parent/{id}` if the parent doesn't exist. The phantom
has no fields but holds the path; it shows up in the console as an italic
`(missing)` entry and clutters collection listings.

`upsert_claim` and `log_outreach` now call `_parent_exists` first and
no-op with a warning when the parent is missing.
"""

from __future__ import annotations

from datetime import UTC, datetime
from unittest.mock import MagicMock, patch

from app.repos.models import (
    ClaimDoc,
    ClaimStatus,
    OutreachLogDoc,
    OutreachTier,
)


def _fake_db(*, parent_exists: bool):
    """Build a fake db whose `.get().exists` reflects `parent_exists`,
    and whose subcollection writes record themselves on a list for the
    test to assert on."""
    fake_db = MagicMock()
    parent_doc = MagicMock()
    parent_snap = MagicMock()
    parent_snap.exists = parent_exists
    parent_doc.get.return_value = parent_snap

    # Record subcollection writes so tests can assert they didn't fire.
    writes: list[str] = []
    sub_ref = MagicMock()
    sub_doc = MagicMock()
    def _record_set(_):
        writes.append("set")
    sub_doc.set.side_effect = _record_set
    sub_ref.document.return_value = sub_doc
    parent_doc.collection.return_value = sub_ref

    coll = MagicMock()
    coll.document.return_value = parent_doc
    fake_db.collection.return_value = coll
    fake_db._writes = writes  # expose for assertion
    return fake_db


# ---------------------------------------------------------------------------
# upsert_claim guard
# ---------------------------------------------------------------------------
def test_upsert_claim_skips_when_parent_missing():
    from app.repos import opportunities_repo

    fake_db = _fake_db(parent_exists=False)
    claim = ClaimDoc(
        volunteer_user_id="u_vol_a",
        slots=1,
        claimed_at=datetime.now(UTC),
        status=ClaimStatus.INTERESTED,
    )
    with patch.object(opportunities_repo, "db", fake_db):
        opportunities_repo.upsert_claim(opp_id="o_gone", claim=claim)

    assert fake_db._writes == [], (
        "upsert_claim must NOT write to subcollection when parent is missing — "
        "doing so creates a phantom parent doc."
    )


def test_upsert_claim_writes_when_parent_exists():
    from app.repos import opportunities_repo

    fake_db = _fake_db(parent_exists=True)
    claim = ClaimDoc(
        volunteer_user_id="u_vol_a",
        slots=1,
        claimed_at=datetime.now(UTC),
        status=ClaimStatus.INTERESTED,
    )
    with patch.object(opportunities_repo, "db", fake_db):
        opportunities_repo.upsert_claim(opp_id="o_real", claim=claim)

    assert fake_db._writes == ["set"], (
        "upsert_claim must write to subcollection when parent exists."
    )


# ---------------------------------------------------------------------------
# log_outreach guard
# ---------------------------------------------------------------------------
def test_log_outreach_skips_when_parent_missing():
    from app.repos import opportunities_repo

    fake_db = _fake_db(parent_exists=False)
    entry = OutreachLogDoc(
        tier=OutreachTier.INSIDER,
        sent_at=datetime.now(UTC),
        recipient_ids=["u_vol_a"],
    )
    with patch.object(opportunities_repo, "db", fake_db):
        opportunities_repo.log_outreach(opp_id="o_gone", entry=entry)

    assert fake_db._writes == []


def test_log_outreach_writes_when_parent_exists():
    from app.repos import opportunities_repo

    fake_db = _fake_db(parent_exists=True)
    entry = OutreachLogDoc(
        tier=OutreachTier.INSIDER,
        sent_at=datetime.now(UTC),
        recipient_ids=["u_vol_a"],
    )
    with patch.object(opportunities_repo, "db", fake_db):
        opportunities_repo.log_outreach(opp_id="o_real", entry=entry)

    assert fake_db._writes == ["set"]


# ---------------------------------------------------------------------------
# Wipe uses list_documents() (catches phantoms)
# ---------------------------------------------------------------------------
def test_wipe_uses_list_documents_not_stream():
    """The wipe must call `list_documents()` on the opportunities collection,
    not `.stream()`. list_documents enumerates all doc refs including
    phantom parents; .stream() may skip them."""
    from app.admin import callables

    fake_db = MagicMock()
    fake_collection = MagicMock()
    fake_collection.list_documents.return_value = []  # no opps
    # Other top-level collections (messages/offers/flags): empty batches.
    limited = MagicMock()
    limited.stream.return_value = []
    fake_collection.limit.return_value = limited
    fake_db.collection.return_value = fake_collection
    fake_db.batch.return_value = MagicMock()

    with patch.object(callables, "db", fake_db):
        callables._clear_test_data_impl(confirm="WIPE")

    # The opportunities collection must have list_documents() called on it.
    # Top-level collections like messages/offers/flags share the same
    # fake_collection mock in this minimal setup, so we assert at least one
    # list_documents() invocation occurred (the one for opportunities).
    assert fake_collection.list_documents.called, (
        "wipe must use list_documents() on opportunities collection so "
        "phantom parents are cleaned up too."
    )
