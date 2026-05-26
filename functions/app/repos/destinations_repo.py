"""Saved gleaning destinations (food banks, community fridges, etc.)."""

from __future__ import annotations

from app.firebase_app import db

from ._base import model_to_dict, snapshot_to_model
from .models import DestinationDoc


COLLECTION = "destinations"


def list_all() -> list[DestinationDoc]:
    return [
        snapshot_to_model(s, DestinationDoc)
        for s in db.collection(COLLECTION).stream()
        if s.exists
    ]  # type: ignore[misc]


def create(doc: DestinationDoc) -> DestinationDoc:
    ref = db.collection(COLLECTION).document()
    ref.set(model_to_dict(doc))
    return doc.model_copy(update={"id": ref.id})
