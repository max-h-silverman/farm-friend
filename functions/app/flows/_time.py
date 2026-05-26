"""Local-time formatting helpers. All persisted datetimes are UTC; humans
see them in America/Los_Angeles."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo


VASHON_TZ = ZoneInfo("America/Los_Angeles")


def post_event_time_for(
    *,
    is_pickup: bool,
    starts_at: datetime | None,
    deadline_at: datetime | None,
) -> datetime | None:
    """Day-after-the-event checkin time, 9am Vashon local. Returns UTC.

    Defined here (not in message_dispatch) so both the new-post and
    farmer-edit paths can recompute the checkin time without importing
    the dispatch module."""
    target = deadline_at if is_pickup else starts_at
    if not target:
        return None
    local = target.astimezone(VASHON_TZ)
    next_morning = local.replace(hour=9, minute=0, second=0, microsecond=0)
    if next_morning <= local:
        next_morning = next_morning + timedelta(days=1)
    return next_morning.astimezone(UTC)


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


def _short_hour(dt: datetime) -> str:
    """Strip ':00' and lowercase the meridiem, then drop the 'm'. 9am -> 9a."""
    s = dt.strftime("%-I:%M%p").lower().replace(":00", "")
    if s.endswith("am"):
        return s[:-1]  # "9am" -> "9a"
    if s.endswith("pm"):
        return s[:-1]  # "1pm" -> "1p"
    return s


def format_day_and_range(
    starts_at: datetime, duration_min: int | None = None
) -> str:
    """Format a date + time range for SMS copy. Examples:
    "tomorrow (Tues 5/26) from 9a-12p"
    "today from 2p-5p"
    "Sat 6/12 at 9a"  (when duration is unknown)
    """
    local = to_local(starts_at)
    now_local = datetime.now(VASHON_TZ)
    delta_days = (local.date() - now_local.date()).days
    weekday_short = local.strftime("%a")
    date_short = local.strftime("%-m/%-d")
    if delta_days == 0:
        day_phrase = "today"
    elif delta_days == 1:
        day_phrase = f"tomorrow ({weekday_short} {date_short})"
    elif 1 < delta_days <= 6:
        day_phrase = f"{weekday_short} {date_short}"
    else:
        day_phrase = local.strftime("%a %-m/%-d")
    start_str = _short_hour(local)
    if duration_min and duration_min > 0:
        from datetime import timedelta
        end_local = local + timedelta(minutes=duration_min)
        end_str = _short_hour(end_local)
        time_part = f"from {start_str}-{end_str}"
    else:
        time_part = f"at {start_str}"
    return f"{day_phrase} {time_part}"
