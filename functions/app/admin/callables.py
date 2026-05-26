"""Callable Firebase Functions for the admin SPA.

These are invoked from the browser via `httpsCallable` after the user signs in
with Firebase Auth. We gate each callable on `request.auth.token.admin == true`
(the custom claim set by `set_admin_claim` once, per-user).
"""

from __future__ import annotations

from datetime import UTC, datetime

from firebase_functions import https_fn

from app.config import ALL_SECRETS, load_settings
from app.copy import templates
from app.firebase_app import auth, db
from app.messaging import get_messaging_provider
from app.messaging._safe_send import safe_send
from app.repos import farms_repo, flags_repo, messages_repo, pending_users_repo, users_repo
from app.repos.models import (
    MessageDirection,
    MessageDoc,
    PendingUserDoc,
    UserDoc,
    UserRole,
    UserStatus,
)


def _require_admin(req: https_fn.CallableRequest) -> None:
    if req.auth is None:
        raise https_fn.HttpsError(https_fn.FunctionsErrorCode.UNAUTHENTICATED, "Sign in required")
    token = req.auth.token or {}
    if not token.get("admin"):
        raise https_fn.HttpsError(https_fn.FunctionsErrorCode.PERMISSION_DENIED, "Admin only")


@https_fn.on_call(secrets=ALL_SECRETS)
def approve_pending_user(req: https_fn.CallableRequest) -> dict:
    """Approve a pending user. Creates the User; sends the intro SMS + vCard."""
    _require_admin(req)
    pending_id = (req.data or {}).get("pending_id")
    role_str = (req.data or {}).get("role", "volunteer")
    if not pending_id:
        raise https_fn.HttpsError(https_fn.FunctionsErrorCode.INVALID_ARGUMENT, "pending_id required")

    pending = pending_users_repo.get_by_id(pending_id)
    if pending is None or pending.status != "pending":
        raise https_fn.HttpsError(https_fn.FunctionsErrorCode.NOT_FOUND, "Pending user not found")

    role = UserRole(role_str)
    user = users_repo.create(
        UserDoc(
            phone=pending.phone,
            name=pending.name or "Friend",
            role=role,
            status=UserStatus.ACTIVE,
            created_at=datetime.now(UTC),
        )
    )

    # If this came from a farmer insider nomination, add the insider link too.
    if pending.source == "insider_nomination" and pending.nominated_by_farm_id and user.id:
        farms_repo.add_insider(
            farm_id=pending.nominated_by_farm_id, volunteer_user_id=user.id
        )

    pending_users_repo.mark_approved(pending_id)

    # Send the first-contact intro SMS.
    settings = load_settings()
    intro_sent = False
    if settings.vcard_url:
        body = templates.render_intro(name=user.name, vcard_url=settings.vcard_url)
        provider = get_messaging_provider(settings)
        provider_id = safe_send(provider, to_phone=user.phone, body=body)
        if provider_id is not None:
            messages_repo.create(
                MessageDoc(
                    direction=MessageDirection.OUTBOUND,
                    provider_msg_id=provider_id,
                    user_id=user.id,
                    body=body,
                    created_at=datetime.now(UTC),
                )
            )
            intro_sent = True

    # Surface delivery outcome to the admin UI so they know whether the user
    # actually got the welcome SMS or needs a manual nudge.
    return {"user_id": user.id, "intro_sent": intro_sent}


@https_fn.on_call()
def suspend_user(req: https_fn.CallableRequest) -> dict:
    _require_admin(req)
    user_id = (req.data or {}).get("user_id")
    if not user_id:
        raise https_fn.HttpsError(https_fn.FunctionsErrorCode.INVALID_ARGUMENT, "user_id required")
    users_repo.set_status(user_id, UserStatus.SUSPENDED)
    return {"ok": True}


@https_fn.on_call()
def resolve_flag(req: https_fn.CallableRequest) -> dict:
    _require_admin(req)
    flag_id = (req.data or {}).get("flag_id")
    if not flag_id:
        raise https_fn.HttpsError(https_fn.FunctionsErrorCode.INVALID_ARGUMENT, "flag_id required")
    flags_repo.resolve(flag_id)
    return {"ok": True}


@https_fn.on_call()
def set_admin_claim(req: https_fn.CallableRequest) -> dict:
    """Bootstrap: grants admin = true to a uid. Self-service is fine for the
    pilot because Max is the only intended admin and runs this once. This must
    only work when called by an already-admin OR when there are zero existing
    admins yet (first-run)."""
    target_uid = (req.data or {}).get("uid")
    if not target_uid:
        raise https_fn.HttpsError(https_fn.FunctionsErrorCode.INVALID_ARGUMENT, "uid required")
    is_first_admin = _no_admins_exist()
    if not is_first_admin:
        _require_admin(req)
    auth.set_custom_user_claims(target_uid, {"admin": True})
    return {"ok": True, "bootstrap": is_first_admin}


def _no_admins_exist() -> bool:
    """Scan auth users once for an admin claim. Cheap at pilot scale."""
    page = auth.list_users()
    while page:
        for user in page.users:
            if (user.custom_claims or {}).get("admin"):
                return False
        page = page.get_next_page() if page.has_next_page else None
    return True
