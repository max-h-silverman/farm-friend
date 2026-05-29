"""Callable Firebase Functions for the admin SPA.

These are invoked from the browser via `httpsCallable` after the user signs in
with Firebase Auth. We gate each callable on `request.auth.token.admin == true`
(the custom claim set by `set_admin_claim` once, per-user).
"""

from __future__ import annotations

from datetime import UTC, datetime
from uuid import uuid4

from firebase_functions import https_fn

from app.config import ALL_SECRETS, load_settings
from app.copy import templates
from app.firebase_app import auth, db
from app.flows import message_dispatch
from app.messaging import InboundMessage, get_messaging_provider
from app.messaging._safe_send import safe_send
from app.messaging.fake_provider import FakeMessagingProvider
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

    # Send the first-contact intro SMS, using the role-appropriate template.
    settings = load_settings()
    intro_sent = False
    if settings.vcard_url:
        if role == UserRole.FARMER:
            body = templates.render_intro_farmer(name=user.name, vcard_url=settings.vcard_url)
        else:
            body = templates.render_intro_volunteer(name=user.name, vcard_url=settings.vcard_url)
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
def update_farm_defaults(req: https_fn.CallableRequest) -> dict:
    """Set the farm's onboarding defaults that the parser uses to fill gaps.

    Inputs:
      - farm_id
      - typical_start_hour (int 0-23, or None)
      - typical_shift_duration_min (int, or None)
      - usual_days_of_week (list[int] 0=Mon..6=Sun)
    """
    _require_admin(req)
    data = req.data or {}
    farm_id = data.get("farm_id")
    if not farm_id:
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.INVALID_ARGUMENT, "farm_id required"
        )
    start_hour = data.get("typical_start_hour")
    duration = data.get("typical_shift_duration_min")
    days = data.get("usual_days_of_week") or []
    if start_hour is not None and not (0 <= int(start_hour) <= 23):
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.INVALID_ARGUMENT,
            "typical_start_hour must be 0-23",
        )
    if duration is not None and int(duration) < 0:
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.INVALID_ARGUMENT,
            "typical_shift_duration_min must be >= 0",
        )
    farms_repo.update_defaults(
        farm_id,
        typical_start_hour=int(start_hour) if start_hour is not None else None,
        typical_shift_duration_min=int(duration) if duration is not None else None,
        usual_days_of_week=[int(d) for d in days],
    )
    return {"ok": True}


@https_fn.on_call()
def update_user_availability(req: https_fn.CallableRequest) -> dict:
    """Set a volunteer's onboarding-captured availability.

    Inputs:
      - user_id
      - available_days (list[int] 0=Mon..6=Sun)
      - available_start_hour (int 0-23, or None)
      - available_end_hour (int 0-23, or None)
      - max_commit_hours_per_week (int, or None)
    """
    _require_admin(req)
    data = req.data or {}
    user_id = data.get("user_id")
    if not user_id:
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.INVALID_ARGUMENT, "user_id required"
        )
    days = data.get("available_days") or []
    start = data.get("available_start_hour")
    end = data.get("available_end_hour")
    cap = data.get("max_commit_hours_per_week")
    for label, value in (("available_start_hour", start), ("available_end_hour", end)):
        if value is not None and not (0 <= int(value) <= 23):
            raise https_fn.HttpsError(
                https_fn.FunctionsErrorCode.INVALID_ARGUMENT, f"{label} must be 0-23"
            )
    if cap is not None and int(cap) < 0:
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.INVALID_ARGUMENT,
            "max_commit_hours_per_week must be >= 0",
        )
    users_repo.update_availability(
        user_id,
        available_days=[int(d) for d in days],
        available_start_hour=int(start) if start is not None else None,
        available_end_hour=int(end) if end is not None else None,
        max_commit_hours_per_week=int(cap) if cap is not None else None,
    )
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


@https_fn.on_call()
def clear_test_data(req: https_fn.CallableRequest) -> dict:
    """Wipe Firestore collections we use for transient pilot/test state.

    Clears: `opportunities` (including the `outreach`, `claims`, and
    `post_event_pings` subcollections), `messages`, `offers`, and `flags`.
    Does NOT touch `users`, `farms`, `farms/{id}/insiders`, `mute_rules`,
    `pending_users`, or admin claims — those are the configured pilot
    state we want to preserve across resets.

    The UI requires a type-to-confirm token to discourage accidental clicks
    (see web/public/app.js → confirmClearDb). The server still authorizes
    on the admin custom claim and re-checks the confirm token here so
    a rogue script can't fire without it.

    Implementation lives in `_clear_test_data_impl` so unit tests can call
    it directly without the Flask-request wrapping the @on_call decorator
    adds.
    """
    _require_admin(req)
    confirm = (req.data or {}).get("confirm")
    return _clear_test_data_impl(confirm=confirm)


def _clear_test_data_impl(*, confirm: str | None) -> dict:
    """Body of `clear_test_data`. Validates the confirm token and runs the
    batch deletes.

    Returns counts of deleted docs per collection.

    NOTE: Firestore has no "delete collection" primitive; we batch through
    `db.collection(...).stream()` and delete in chunks of 500 (the
    documented WriteBatch limit). At pilot scale this is a handful of
    seconds per call; not optimized for large-scale wipes.
    """
    if confirm != "WIPE":
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.INVALID_ARGUMENT,
            "Confirmation required: pass confirm='WIPE'",
        )

    deleted = {
        "opportunities": 0,
        "opportunities_subcollections": 0,
        "messages": 0,
        "offers": 0,
        "flags": 0,
    }

    # Opportunities + their three subcollections. We iterate the parent doc
    # refs so we can find their subcollection refs by path; deleting a
    # parent doc does NOT cascade to subcollections in Firestore.
    #
    # Use `list_documents()` (not `.stream()`) so we also catch *phantom*
    # parents — docs that have no fields of their own but were implicitly
    # created when a subcollection was written under their path. Phantoms
    # don't appear in `.stream()` but they do show up in the Firebase
    # console as italic "(missing)" entries, and they're the most common
    # source of mystery "blank opportunity documents."
    for opp_ref in db.collection("opportunities").list_documents():
        for sub_name in ("outreach", "claims", "post_event_pings"):
            sub_count = _delete_collection(opp_ref.collection(sub_name))
            deleted["opportunities_subcollections"] += sub_count
        opp_ref.delete()
        deleted["opportunities"] += 1

    deleted["messages"] = _delete_collection(db.collection("messages"))
    deleted["offers"] = _delete_collection(db.collection("offers"))
    deleted["flags"] = _delete_collection(db.collection("flags"))

    return {"ok": True, "deleted": deleted}


def _delete_collection(coll_ref, *, batch_size: int = 500) -> int:
    """Batch-delete every doc in a collection. Returns count deleted.

    Streams docs and deletes via WriteBatch (max 500 per batch — Firestore's
    documented limit). Loops until the collection is empty. At pilot scale
    this terminates quickly; for very large collections it'd need
    pagination via `start_after` but we don't have that scale.
    """
    total = 0
    while True:
        batch = db.batch()
        chunk = list(coll_ref.limit(batch_size).stream())
        if not chunk:
            return total
        for snap in chunk:
            batch.delete(snap.reference)
        batch.commit()
        total += len(chunk)
        # If we got fewer than batch_size, we're done.
        if len(chunk) < batch_size:
            return total


@https_fn.on_call(secrets=ALL_SECRETS, min_instances=1)
def simulate_inbound_sms(req: https_fn.CallableRequest) -> dict:
    """Run an inbound message through the real dispatch pipeline, but reroute
    outbound replies to an in-memory provider so nothing actually goes out over
    SMS. All other side effects (messages log, opportunities, flags, claims)
    write to production Firestore exactly as they would for a real inbound.

    Inputs:
      - user_id (optional): existing user.id to send as. Their phone is used.
      - phone (optional): raw E.164 to send as (for testing the unknown-sender
        / JOIN path). Ignored if user_id is set.
      - body: SMS text.

    Returns:
      - outbound: list of {to_phone, body} the system would have sent.
      - inbound_logged_as: the from_phone used.
    """
    _require_admin(req)
    data = req.data or {}
    user_id = data.get("user_id")
    phone = data.get("phone")
    body = (data.get("body") or "").strip()
    if not body:
        raise https_fn.HttpsError(https_fn.FunctionsErrorCode.INVALID_ARGUMENT, "body required")

    if user_id:
        user = users_repo.get_by_id(user_id)
        if user is None:
            raise https_fn.HttpsError(https_fn.FunctionsErrorCode.NOT_FOUND, "user not found")
        from_phone = user.phone
    elif phone:
        from_phone = phone
    else:
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.INVALID_ARGUMENT, "user_id or phone required"
        )

    settings = load_settings()
    fake = FakeMessagingProvider()
    inbound = InboundMessage(
        from_phone=from_phone,
        to_phone=settings.telnyx_from_number or "+15555550100",
        body=body,
        provider_msg_id=f"sim-{uuid4()}",
        received_at=datetime.now(UTC),
    )
    message_dispatch._dispatch(inbound=inbound, messaging=fake)

    return {
        "inbound_logged_as": from_phone,
        "outbound": [
            {"to_phone": m.to_phone, "body": m.body} for m in fake.sent
        ],
    }


def _no_admins_exist() -> bool:
    """Scan auth users once for an admin claim. Cheap at pilot scale."""
    page = auth.list_users()
    while page:
        for user in page.users:
            if (user.custom_claims or {}).get("admin"):
                return False
        page = page.get_next_page() if page.has_next_page else None
    return True
