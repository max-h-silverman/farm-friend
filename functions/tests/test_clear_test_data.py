"""Tests for the clear_test_data admin callable's logic.

We test the helper `_clear_test_data_impl` directly — the `@https_fn.on_call`
decorator wraps the public callable in a Flask request handler that needs an
app context to instantiate. The helper is the auth-stripped business logic,
so unit tests can exercise it without the wrapper.

What gets covered:
  - the WIPE confirmation gate
  - the batch-delete walk visits every expected collection
  - subcollection cleanup happens before parent delete (no orphans)

The end-to-end Firestore wipe runs against the live DB during pilot testing
(no emulator in this suite).
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest


def _make_fake_db(*, opp_ids: list[str], messages_count: int = 0,
                  offers_count: int = 0, flags_count: int = 0,
                  subcollection_count_per_opp: int = 0):
    """Build a MagicMock that mimics enough of the Firestore Python SDK to
    walk `_clear_test_data_impl` without touching real Firestore.

    `subcollection_count_per_opp` controls how many docs each of the three
    subcollections (outreach, claims, post_event_pings) appears to have.

    The wipe iterates opps via `.list_documents()` (catches phantom parents
    that `.stream()` would skip), so the fake exposes that method.
    """
    fake_db = MagicMock()

    # Per-opportunity ref mock with subcollections.
    def _make_opp_ref(opp_id: str):
        opp_ref = MagicMock()
        # Subcollection: limit().stream() returns subcollection_count_per_opp
        # docs the first time, then empty (so the while-loop terminates).
        def _sub_collection(name):
            sub = MagicMock()
            calls = {"i": 0}
            def _limit(_batch):
                limited = MagicMock()
                def _stream():
                    if calls["i"] == 0 and subcollection_count_per_opp > 0:
                        calls["i"] += 1
                        return [MagicMock(reference=MagicMock()) for _ in range(subcollection_count_per_opp)]
                    return []
                limited.stream.side_effect = _stream
                return limited
            sub.limit.side_effect = _limit
            return sub
        opp_ref.collection.side_effect = _sub_collection
        return opp_ref

    opp_refs = [_make_opp_ref(oid) for oid in opp_ids]

    # Top-level collection routing.
    top_level_counts = {
        "messages": messages_count,
        "offers": offers_count,
        "flags": flags_count,
    }

    def _top_collection(name):
        coll = MagicMock()
        if name == "opportunities":
            # `db.collection("opportunities").list_documents()` enumerates opp refs.
            coll.list_documents.return_value = iter(opp_refs)
        else:
            # messages / offers / flags: behave like a subcollection — first
            # batch returns N docs, then empty.
            calls = {"i": 0}
            target = top_level_counts.get(name, 0)
            def _limit(_batch):
                limited = MagicMock()
                def _stream():
                    if calls["i"] == 0 and target > 0:
                        calls["i"] += 1
                        return [MagicMock(reference=MagicMock()) for _ in range(target)]
                    return []
                limited.stream.side_effect = _stream
                return limited
            coll.limit.side_effect = _limit
        return coll

    fake_db.collection.side_effect = _top_collection
    fake_db.batch.return_value = MagicMock()
    return fake_db


def test_rejects_missing_confirm():
    from firebase_functions import https_fn

    from app.admin.callables import _clear_test_data_impl

    with pytest.raises(https_fn.HttpsError) as exc:
        _clear_test_data_impl(confirm=None)
    # HttpsError stashes the message in `.message`; surfacing it via str()
    # depends on the firebase-functions version, so check the attribute.
    assert "Confirmation" in getattr(exc.value, "message", "") or \
           "Confirmation" in str(exc.value)


def test_rejects_wrong_confirm_token():
    from firebase_functions import https_fn

    from app.admin.callables import _clear_test_data_impl

    for bad in ["wipe", "DELETE", "yes", "Wipe", ""]:
        with pytest.raises(https_fn.HttpsError):
            _clear_test_data_impl(confirm=bad)


def test_empty_db_returns_zero_counts():
    from app.admin import callables

    fake_db = _make_fake_db(opp_ids=[])
    with patch.object(callables, "db", fake_db):
        result = callables._clear_test_data_impl(confirm="WIPE")

    assert result["ok"] is True
    assert result["deleted"]["opportunities"] == 0
    assert result["deleted"]["opportunities_subcollections"] == 0
    assert result["deleted"]["messages"] == 0
    assert result["deleted"]["offers"] == 0
    assert result["deleted"]["flags"] == 0


def test_counts_match_collection_sizes():
    from app.admin import callables

    fake_db = _make_fake_db(
        opp_ids=["o1", "o2", "o3"],
        messages_count=12,
        offers_count=2,
        flags_count=5,
        subcollection_count_per_opp=4,
    )
    with patch.object(callables, "db", fake_db):
        result = callables._clear_test_data_impl(confirm="WIPE")

    assert result["deleted"]["opportunities"] == 3
    # 3 opps × 3 subcollections × 4 docs = 36
    assert result["deleted"]["opportunities_subcollections"] == 36
    assert result["deleted"]["messages"] == 12
    assert result["deleted"]["offers"] == 2
    assert result["deleted"]["flags"] == 5


def test_parent_delete_happens_after_subcollection_clear():
    """Each opp's subcollections must be deleted BEFORE the parent doc is
    deleted; otherwise the subcollection refs become orphans (Firestore
    doesn't cascade)."""
    from app.admin import callables

    call_order: list[str] = []

    # We watch the order of .delete() calls on the opp's parent ref vs the
    # subcollection batches. The wipe uses list_documents() so the iterator
    # yields refs directly (not snapshots).
    def _make_tracking_opp_ref(opp_id: str):
        opp_ref = MagicMock()
        # Mark when the parent delete is called.
        def _parent_delete():
            call_order.append(f"delete_parent:{opp_id}")
        opp_ref.delete.side_effect = _parent_delete

        # Subcollections — each first stream returns 1 doc, then empty.
        def _sub_collection(name):
            sub = MagicMock()
            calls = {"i": 0}
            def _limit(_batch):
                limited = MagicMock()
                def _stream():
                    if calls["i"] == 0:
                        calls["i"] += 1
                        return [MagicMock(reference=MagicMock())]
                    return []
                limited.stream.side_effect = _stream
                return limited
            sub.limit.side_effect = _limit
            # Mark when we even start iterating this subcollection.
            orig_limit = sub.limit.side_effect
            def _tracking_limit(b):
                call_order.append(f"sub:{opp_id}:{name}")
                return orig_limit(b)
            sub.limit.side_effect = _tracking_limit
            return sub
        opp_ref.collection.side_effect = _sub_collection
        return opp_ref

    fake_db = MagicMock()
    fake_db.batch.return_value = MagicMock()
    opp_refs = [_make_tracking_opp_ref("o1")]
    def _top_collection(name):
        coll = MagicMock()
        if name == "opportunities":
            coll.list_documents.return_value = iter(opp_refs)
        else:
            # Empty for messages/offers/flags so the test focuses on opps.
            limited = MagicMock()
            limited.stream.return_value = []
            coll.limit.return_value = limited
        return coll
    fake_db.collection.side_effect = _top_collection

    with patch.object(callables, "db", fake_db):
        callables._clear_test_data_impl(confirm="WIPE")

    # All subcollection iterations should appear before the parent delete.
    parent_idx = call_order.index("delete_parent:o1")
    sub_indices = [i for i, c in enumerate(call_order) if c.startswith("sub:o1:")]
    for sub_i in sub_indices:
        assert sub_i < parent_idx, (
            f"Subcollection iteration at {sub_i} ran AFTER parent delete at {parent_idx}; "
            f"would leave orphaned subcollection docs. call_order={call_order}"
        )
    # All three subcollection names appear.
    assert {"sub:o1:outreach", "sub:o1:claims", "sub:o1:post_event_pings"} == set(
        c for c in call_order if c.startswith("sub:")
    )
