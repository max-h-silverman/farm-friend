"""Firebase Admin SDK initialization.

`db` and `auth` are lazy: created on first access. This matters because the
Firebase Functions deploy analyzer imports `main.py` to introspect decorated
functions BEFORE any GCP credentials exist — eager creation would fail.

Callers use `from app.firebase_app import db` and then `db.collection(...)`.
That access triggers the lazy init transparently.

At actual runtime (detected via the `K_SERVICE` env var Cloud Run sets) we
eager-init the default Firebase app at module import. The callable-request
token verifier in `firebase-functions` calls `firebase_admin.auth.verify_id_token`
directly — if no default app exists yet, verification fails with "Auth token
was rejected" and the client sees `UNAUTHENTICATED`, even for a correctly
signed-in admin. Lazy init only fires when our handler code touches `db`/`auth`,
which is too late for the SDK's pre-handler auth check.
"""

from __future__ import annotations

import os
from typing import Any

import firebase_admin

_db: Any = None
_auth_module: Any = None


def _ensure_app() -> None:
    if not firebase_admin._apps:
        firebase_admin.initialize_app()


if os.environ.get("K_SERVICE"):
    _ensure_app()


class _LazyDb:
    def __getattr__(self, name: str) -> Any:
        global _db
        if _db is None:
            _ensure_app()
            from firebase_admin import firestore
            _db = firestore.client()
        return getattr(_db, name)


class _LazyAuth:
    def __getattr__(self, name: str) -> Any:
        global _auth_module
        if _auth_module is None:
            _ensure_app()
            from firebase_admin import auth as admin_auth
            _auth_module = admin_auth
        return getattr(_auth_module, name)


db = _LazyDb()
auth = _LazyAuth()

__all__ = ["db", "auth"]
