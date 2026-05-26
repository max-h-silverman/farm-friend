"""Local-time formatting helpers. All persisted datetimes are UTC; humans
see them in America/Los_Angeles."""

from __future__ import annotations

from datetime import datetime
from zoneinfo import ZoneInfo


VASHON_TZ = ZoneInfo("America/Los_Angeles")


def to_local(dt: datetime) -> datetime:
    if dt.tzinfo is None:
        # Treat naive datetimes as UTC.
        from datetime import UTC
        dt = dt.replace(tzinfo=UTC)
    return dt.astimezone(VASHON_TZ)


def format_when(dt: datetime) -> str:
    """Format a datetime for SMS copy. Examples:
    "Thu 6/12 at 9am"
    "today at 2pm"
    """
    local = to_local(dt)
    now_local = datetime.now(VASHON_TZ)
    same_day = local.date() == now_local.date()
    tomorrow = (local.date() - now_local.date()).days == 1
    if same_day:
        day = "today"
    elif tomorrow:
        day = "tomorrow"
    else:
        day = local.strftime("%a %-m/%-d")
    hour = local.strftime("%-I:%M%p").lower().replace(":00", "")
    return f"{day} at {hour}"


def format_deadline(dt: datetime) -> str:
    """Format a pickup deadline. Examples: "by 6pm today", "by 10am tomorrow"."""
    return f"by {format_when(dt)}"
