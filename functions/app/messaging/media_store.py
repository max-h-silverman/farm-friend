"""Persist inbound MMS media for later outbound use.

Telnyx inbound media URLs are temporary. For pickup photos to be useful when
someone claims later, we copy them into our Firebase Storage bucket and use the
resulting public URLs for outbound MMS.
"""

from __future__ import annotations

import logging
import os
from uuid import uuid4

import httpx

from app.firebase_app import _ensure_app


log = logging.getLogger(__name__)

MAX_MEDIA_BYTES = 5 * 1024 * 1024


def persist_media_urls(urls: list[str]) -> list[str]:
    if not urls:
        return []
    persisted: list[str] = []
    for url in urls:
        try:
            persisted.append(_persist_one(url))
        except Exception as e:  # noqa: BLE001 - media persistence is best-effort
            log.warning("failed to persist inbound media %s: %s", url, e)
            persisted.append(url)
    return persisted


def _persist_one(url: str) -> str:
    resp = httpx.get(url, timeout=20.0, follow_redirects=True)
    resp.raise_for_status()
    content = resp.content
    if len(content) > MAX_MEDIA_BYTES:
        raise ValueError(f"media too large: {len(content)} bytes")
    content_type = resp.headers.get("content-type", "application/octet-stream")
    ext = _extension_for(content_type)
    key = f"mms/{uuid4()}{ext}"

    _ensure_app()
    from firebase_admin import storage

    bucket = storage.bucket(_bucket_name())
    blob = bucket.blob(key)
    blob.upload_from_string(content, content_type=content_type)
    blob.make_public()
    return blob.public_url


def _bucket_name() -> str | None:
    explicit = os.environ.get("MMS_MEDIA_BUCKET") or os.environ.get("FIREBASE_STORAGE_BUCKET")
    if explicit:
        return explicit
    project = os.environ.get("GOOGLE_CLOUD_PROJECT") or os.environ.get("GCLOUD_PROJECT")
    if project:
        return f"{project}.appspot.com"
    return None


def _extension_for(content_type: str) -> str:
    base = content_type.split(";", 1)[0].strip().lower()
    return {
        "image/jpeg": ".jpg",
        "image/png": ".png",
        "image/gif": ".gif",
        "image/webp": ".webp",
        "image/bmp": ".bmp",
    }.get(base, "")
