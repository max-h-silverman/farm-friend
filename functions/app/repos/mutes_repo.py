"""Mute rules."""

from __future__ import annotations

from datetime import datetime

from app.firebase_app import db

from ._base import model_to_dict, snapshot_to_model
from .models import MuteDimension, MuteRuleDoc


COLLECTION = "mute_rules"


def add(rule: MuteRuleDoc) -> MuteRuleDoc:
    ref = db.collection(COLLECTION).document()
    ref.set(model_to_dict(rule))
    return rule.model_copy(update={"id": ref.id})


def delete(rule_id: str) -> None:
    """Remove a mute rule by id. Used by RESUME to clear agent_nudge mutes."""
    db.collection(COLLECTION).document(rule_id).delete()


def list_for_user(user_id: str) -> list[MuteRuleDoc]:
    q = db.collection(COLLECTION).where("user_id", "==", user_id)
    return [snapshot_to_model(s, MuteRuleDoc) for s in q.stream() if s.exists]  # type: ignore[misc]


def is_muted(
    *,
    user_id: str,
    activity: str | None = None,
    farm_id: str | None = None,
    opportunity_id: str | None = None,
    at: datetime | None = None,
) -> bool:
    """True if any of the supplied dimensions matches a live mute rule for this user."""
    rules = list_for_user(user_id)
    for r in rules:
        if r.expires_at is not None and at is not None and r.expires_at < at:
            continue
        if r.dimension == MuteDimension.ACTIVITY and activity and r.value == activity:
            return True
        if r.dimension == MuteDimension.FARM and farm_id and r.value == farm_id:
            return True
        if r.dimension == MuteDimension.OPPORTUNITY and opportunity_id and r.value == opportunity_id:
            return True
        if r.dimension == MuteDimension.WINDOW and at is not None:
            # value is "start_iso..end_iso"
            if ".." in r.value:
                start_s, end_s = r.value.split("..", 1)
                try:
                    start = datetime.fromisoformat(start_s)
                    end = datetime.fromisoformat(end_s)
                    if start <= at <= end:
                        return True
                except ValueError:
                    pass
    return False
