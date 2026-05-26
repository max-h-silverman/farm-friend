"""Internal helpers for repos. Keep all Firestore SDK touchpoints here so
business code stays clean of vendor types.
"""

from __future__ import annotations

from typing import TypeVar

from google.cloud.firestore import DocumentSnapshot
from pydantic import BaseModel

M = TypeVar("M", bound=BaseModel)


def snapshot_to_model(snap: DocumentSnapshot, model_cls: type[M]) -> M | None:
    """Convert a Firestore DocumentSnapshot to a Pydantic model, or None if missing."""
    if not snap.exists:
        return None
    data = snap.to_dict() or {}
    data["id"] = snap.id
    return model_cls.model_validate(data)


def model_to_dict(model: BaseModel, *, exclude_id: bool = True) -> dict:
    """Serialize a Pydantic model for Firestore write. Strips `id` (it's the doc path)."""
    data = model.model_dump(mode="python", exclude_none=False)
    if exclude_id:
        data.pop("id", None)
    return data
