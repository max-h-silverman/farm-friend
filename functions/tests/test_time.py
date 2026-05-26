from __future__ import annotations

from datetime import UTC, datetime, timedelta

from freezegun import freeze_time

from app.flows._time import VASHON_TZ, format_deadline, format_when, to_local


@freeze_time("2026-06-15 16:00:00", tz_offset=0)
def test_format_when_today() -> None:
    # 2026-06-15 16:00 UTC = 09:00 Vashon
    dt = datetime(2026, 6, 15, 18, 0, tzinfo=UTC)  # 11am Vashon same day
    assert "today" in format_when(dt)


@freeze_time("2026-06-15 16:00:00", tz_offset=0)
def test_format_when_tomorrow() -> None:
    dt = datetime(2026, 6, 16, 16, 0, tzinfo=UTC)
    assert "tomorrow" in format_when(dt)


@freeze_time("2026-06-15 16:00:00", tz_offset=0)
def test_format_deadline_prepends_by() -> None:
    dt = datetime(2026, 6, 15, 23, 0, tzinfo=UTC)  # 4pm same day
    out = format_deadline(dt)
    assert out.startswith("by ")
    assert "today" in out


def test_to_local_converts_naive_as_utc() -> None:
    naive = datetime(2026, 6, 15, 16, 0)
    local = to_local(naive)
    assert local.tzinfo == VASHON_TZ
