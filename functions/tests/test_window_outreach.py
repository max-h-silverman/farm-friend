"""Tests for `_render_outreach_body` and `_format_window_human` in
outreach.py — the window-opp broadcast SMS.

Pinned because volunteers read this copy verbatim; a phrasing regression
would degrade understanding of how to reply (`YES WED` vs bare YES).
"""

from __future__ import annotations

from datetime import UTC, datetime

from app.flows.outreach import _format_window_human, _render_outreach_body
from app.repos.models import OpportunityDoc, OpportunityKind, OpportunityStatus


# Mon Jun 1 9am Vashon = 16:00 UTC.
MON_9AM = datetime(2026, 6, 1, 16, 0, tzinfo=UTC)
FRI_LAST = datetime(2026, 6, 5, 16, 0, tzinfo=UTC)


def _window_opp(**overrides) -> OpportunityDoc:
    base = dict(
        farm_id="f_1",
        kind=OpportunityKind.SHIFT,
        status=OpportunityStatus.OPEN,
        starts_at=MON_9AM,
        window_end_at=FRI_LAST,
        duration_min=180,
        headcount_needed=2,
        activity_detail="Weeding",
        created_at=MON_9AM,
    )
    base.update(overrides)
    return OpportunityDoc(**base)


def test_window_outreach_mentions_day_range():
    opp = _window_opp()
    body = _render_outreach_body(opp=opp, farm_name="Three Cedars")
    assert "Three Cedars" in body
    # Day range with both ends.
    assert "Mon" in body
    assert "Fri" in body
    assert "Weeding" in body


def test_window_outreach_instructs_yes_day_grammar():
    """The reply instructions must mention `YES <day>` so volunteers know
    they need to specify rather than reply bare YES."""
    opp = _window_opp()
    body = _render_outreach_body(opp=opp, farm_name="Three Cedars")
    assert "YES" in body
    assert "WED" in body  # the worked example in the template


def test_window_outreach_with_bucket_only():
    """No clock time — bucket should render directly."""
    opp = _window_opp(
        starts_at=datetime(2026, 6, 1, 7, 0, tzinfo=UTC),  # midnight Vashon = date-only
        time_of_day_bucket="morning",
        duration_min=None,
    )
    body = _render_outreach_body(opp=opp, farm_name="Three Cedars")
    assert "morning" in body


def test_window_outreach_with_headcount_open():
    """headcount_open=True renders as 'any number of helpers'."""
    opp = _window_opp(headcount_open=True)
    body = _render_outreach_body(opp=opp, farm_name="Three Cedars")
    assert "any number" in body.lower()


def test_format_window_human_clock_time():
    opp = _window_opp()
    out = _format_window_human(opp)
    # "any day" prefix, day range, time range
    assert "any day" in out
    assert "Mon" in out and "Fri" in out
    assert "9a" in out


def test_format_window_human_bucket():
    opp = _window_opp(time_of_day_bucket="late_morning", duration_min=None)
    out = _format_window_human(opp)
    assert "late morning" in out


def test_single_day_shift_uses_legacy_template():
    """A non-window opp goes through `render_shift_outreach`, not the window
    variant. The smoke test: the output should NOT contain 'YES <day>' instructions."""
    opp = _window_opp(window_end_at=None)  # collapse to single-day
    body = _render_outreach_body(opp=opp, farm_name="Three Cedars")
    assert "YES" in body  # the bare YES path
    # Bare YES, not YES <day>: WED shouldn't appear in the instructions.
    assert "WED" not in body
