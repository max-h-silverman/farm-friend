"""Tests for the proposal auto-confirm timer logic.

The Firestore-touching parts (the tick itself) get integration coverage in
PR 6 via the eval runner. Here we pin the pure timer decision so a change
to the settings defaults doesn't silently shorten or lengthen the window.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from app.flows.proposals_tick import _proposal_timer_elapsed
from app.repos.models import ClaimDoc, ClaimStatus


@dataclass
class _Settings:
    proposal_auto_confirm_far_min: int = 240
    proposal_auto_confirm_close_min: int = 60


def _claim(*, claimed_at: datetime, scheduled_for_at: datetime) -> ClaimDoc:
    return ClaimDoc(
        volunteer_user_id="u_vol_a",
        slots=1,
        claimed_at=claimed_at,
        status=ClaimStatus.PROPOSED,
        scheduled_for_at=scheduled_for_at,
    )


def test_far_timer_elapsed_only_after_4h():
    """Claim 3 days out: proposal needs to age 4h before auto-confirm."""
    now = datetime(2026, 6, 3, 12, 0, tzinfo=UTC)
    sched = now + timedelta(days=3)
    settings = _Settings()
    # 3h after claim — not yet.
    claim = _claim(claimed_at=now - timedelta(hours=3), scheduled_for_at=sched)
    assert not _proposal_timer_elapsed(claim=claim, now=now, settings=settings)
    # 4h after claim — fires.
    claim = _claim(claimed_at=now - timedelta(hours=4), scheduled_for_at=sched)
    assert _proposal_timer_elapsed(claim=claim, now=now, settings=settings)


def test_close_timer_elapsed_after_1h_when_scheduled_within_24h():
    """Claim <24h out: tighter 1h timer."""
    now = datetime(2026, 6, 3, 12, 0, tzinfo=UTC)
    sched = now + timedelta(hours=12)  # same day
    settings = _Settings()
    # 30 min after claim — not yet.
    claim = _claim(claimed_at=now - timedelta(minutes=30), scheduled_for_at=sched)
    assert not _proposal_timer_elapsed(claim=claim, now=now, settings=settings)
    # 1h after claim — fires.
    claim = _claim(claimed_at=now - timedelta(hours=1), scheduled_for_at=sched)
    assert _proposal_timer_elapsed(claim=claim, now=now, settings=settings)


def test_far_timer_does_not_fire_with_close_age_when_far_out():
    """Far-out claim with 90 min age: doesn't fire (would have if it were close)."""
    now = datetime(2026, 6, 3, 12, 0, tzinfo=UTC)
    sched = now + timedelta(days=3)
    settings = _Settings()
    claim = _claim(
        claimed_at=now - timedelta(minutes=90), scheduled_for_at=sched,
    )
    assert not _proposal_timer_elapsed(claim=claim, now=now, settings=settings)


def test_no_scheduled_for_at_never_fires():
    """Defensive: a malformed PROPOSED claim with no scheduled_for_at is
    skipped rather than crashing."""
    now = datetime(2026, 6, 3, 12, 0, tzinfo=UTC)
    settings = _Settings()
    claim = ClaimDoc(
        volunteer_user_id="u_vol_a",
        slots=1,
        claimed_at=now - timedelta(hours=24),
        status=ClaimStatus.PROPOSED,
        scheduled_for_at=None,
    )
    assert not _proposal_timer_elapsed(claim=claim, now=now, settings=settings)
