#!/usr/bin/env python3
"""Assert the safety properties of a Terraform plan.

    cd infra
    tofu plan -var="image_digest=sha256:..." -out=/tmp/tf.plan
    tofu show -json /tmp/tf.plan | python3 plan-assertions.py

WHY THIS EXISTS. `tofu validate` proves the configuration PARSES. It says nothing about
whether the worker is reachable from the internet, whether a service holds instances warm, or
whether a secret value leaked into state — and those are the properties that cost money or
expose the SMS path if they are wrong. Each is a fact about the planned RESOURCES, so it is
asserted against the plan rather than against the source that produced it.

This is the same discipline as `cron-schedule.test.ts` and `workspace-manifests.test.ts` in
the application: a property belonging to the platform gets asserted against the artifact the
platform actually consumes.

Exit 0 if every assertion holds, 1 otherwise, with the failures named.
"""

import json
import re
import sys
from urllib.parse import urlparse

FAILURES: list[str] = []
CHECKS = 0


def check(name: str, condition: bool, detail: str = "") -> None:
    global CHECKS
    CHECKS += 1
    if condition:
        print(f"  PASS  {name}")
    else:
        print(f"  FAIL  {name}{' — ' + detail if detail else ''}")
        FAILURES.append(name)


def resources(plan: dict) -> list[dict]:
    return plan.get("planned_values", {}).get("root_module", {}).get("resources", [])


def by_type(plan: dict, type_: str) -> dict[str, dict]:
    """Resources of one type, keyed uniquely.

    `for_each` resources share a `name` and differ by `index`, so keying on `name` alone
    collapses all five secrets into one entry — which is exactly what this helper did on its
    first run, reporting "found 1" for a plan that correctly contained five. A miscount in
    the OTHER direction would have silently passed a plan missing four secrets.
    """
    out: dict[str, dict] = {}
    for r in resources(plan):
        if r["type"] != type_:
            continue
        key = r["name"] if r.get("index") is None else f"{r['name']}[{r['index']}]"
        out[key] = r["values"]
    return out


def changed_addresses(plan: dict, type_: str) -> dict[str, list[str]]:
    """Non-no-op actions keyed by their full Terraform address."""
    return {
        change["address"]: change["change"]["actions"]
        for change in plan.get("resource_changes", [])
        if change.get("type") == type_
        and change.get("change", {}).get("actions") != ["no-op"]
    }


def _mounted_secret_names(service: dict) -> set[str]:
    """Env var names on a service that come FROM SECRET MANAGER, not plain values.

    Reads the plan's own before/after shape. A plain env value is not a mount and is not this
    guard's business; losing a secret mount is what took geocoding down.
    """
    if not service:
        return set()
    containers = ((service.get("template") or [{}])[0].get("containers") or [{}])
    names = set()
    for container in containers:
        for entry in (container.get("env") or []):
            if isinstance(entry, dict) and entry.get("value_source"):
                names.add(entry.get("name"))
    return names


def email_delivery_configuration_is_exclusive(
    environment: dict[str, str | None], secret_environment_names: set[str]
) -> bool:
    """A selected mail transport must not inherit another transport's credentials."""
    if environment.get("EMAIL_PROVIDER") != "gmail":
        return True
    return not (
        any(name.startswith("SMTP_") for name in environment)
        or any(name.startswith("SMTP_") for name in secret_environment_names)
    )


def dropped_secret_mounts_are_safe(
    before_names: set[str], after_names: set[str], after_environment: dict[str, str | None]
) -> bool:
    """The Gmail cutover may replace SMTP's credential, but may never drop another secret."""
    dropped = before_names - after_names
    return not dropped or (
        dropped == {"SMTP_PASSWORD"}
        and after_environment.get("EMAIL_PROVIDER") == "gmail"
        and {"GMAIL_OAUTH_CLIENT_SECRET", "GMAIL_OAUTH_REFRESH_TOKEN"} <= after_names
    )

def secret_cutover_changes_are_safe(secret_changes: dict[str, list[str]]) -> bool:
    """Accept the known cutover phases and the stable state after each is complete.

    An allow-list rather than a rule, deliberately: every entry is a change someone reviewed. A
    secret CREATE is cheap to approve and a secret DELETE destroys every version inside it, and
    `phone-hash-salt` is unrecoverable by design — so "no unexpected secret change" is worth more
    here than the convenience of a general predicate.
    """
    initial = {
        'google_secret_manager_secret.protected["admin-password-hash"]': ["create"],
        'google_secret_manager_secret.app["magic-link-secret"]': ["delete"],
    }
    post_provision = {
        'google_secret_manager_secret.app["magic-link-secret"]': ["delete"],
    }
    # The optional key containers: F-069's geocoding key and F-078's SMTP password. Each is a
    # CREATE only — the container is added empty and its version goes in out of band, so no value
    # passes through Terraform or its state. Any SUBSET may be planned, because a container that
    # already exists in production plans no change: the SMTP apply follows geocoding's, so it
    # plans that one alone. `create` is the only approved action for either, so a DELETE — which
    # destroys every version inside — still fails here and needs its own review.
    optional_containers = {
        'google_secret_manager_secret.protected["geocoding-api-key"]',
        'google_secret_manager_secret.protected["smtp-password"]',
        'google_secret_manager_secret.protected["gmail-oauth-client-secret"]',
        'google_secret_manager_secret.protected["gmail-oauth-refresh-token"]',
        # F-079's three, on the same terms: created empty, versions added out of band. All three
        # move together behind one mount flag, but they are three containers and any subset may
        # be planned depending on what already exists.
        'google_secret_manager_secret.protected["email-hash-salt"]',
        'google_secret_manager_secret.protected["verification-code-salt"]',
        'google_secret_manager_secret.protected["farmer-start-secret"]',
    }
    if secret_changes and all(
        address in optional_containers and actions == ["create"]
        for address, actions in secret_changes.items()
    ):
        return True
    return secret_changes in ({}, initial, post_provision)


def main() -> int:
    plan = json.load(sys.stdin)

    services = by_type(plan, "google_cloud_run_v2_service")
    print("\nCloud Run services")

    check("both services are planned", set(services) >= {"web", "worker"},
          f"found {sorted(services)}")

    worker = services.get("worker", {})
    web = services.get("web", {})
    # The raw change objects, for the "unmounts nothing live" guard below: `services` holds the
    # planned AFTER state, and that guard has to compare it against BEFORE.
    service_changes = {
        change["address"].rsplit(".", 1)[-1]: change
        for change in plan.get("resource_changes", [])
        if change.get("type") == "google_cloud_run_v2_service"
    }
    web_change = service_changes.get("web", {})
    worker_change = service_changes.get("worker", {})

    # The single most important line in this file. The worker runs the passes that apply
    # consent transitions and send real SMS; a publicly reachable worker is a remote way to
    # make Farm Friend text a real person. Ingress is the primary control — the in-process
    # role guard is explicitly a second door, not a substitute.
    check("the worker is internal-only",
          worker.get("ingress") == "INGRESS_TRAFFIC_INTERNAL_ONLY",
          f"ingress={worker.get('ingress')}")

    # The public service is meant to be public: map, QR stock-out form, Telnyx webhook.
    check("the public service accepts public traffic",
          web.get("ingress") == "INGRESS_TRAFFIC_ALL",
          f"ingress={web.get('ingress')}")

    for name, svc in (("web", web), ("worker", worker)):
        template = (svc.get("template") or [{}])[0]
        scaling = (template.get("scaling") or [{}])[0]

        # The entire cost case. An always-warm instance is what the legacy system was doing —
        # $1.57/month for two functions serving 1 request in 30 days — and it is the one
        # setting that turns "roughly zero" into a standing charge.
        check(f"{name} scales to zero",
              scaling.get("min_instance_count") == 0,
              f"min_instance_count={scaling.get('min_instance_count')}")

        # Unbounded scaling times five Postgres connections per process exhausts Neon.
        max_instances = scaling.get("max_instance_count")
        check(f"{name} has a bounded maximum",
              isinstance(max_instances, int) and 0 < max_instances <= 10,
              f"max_instance_count={max_instances}")

    # The stock-out model-cost throttle is per-process. With N instances its 5-per-minute
    # budget silently becomes 5N-per-minute. Administrator login is durable in Postgres.
    web_scaling = ((web.get("template") or [{}])[0].get("scaling") or [{}])[0]
    check("the public service is capped at one instance while stock-out throttle is in-memory",
          web_scaling.get("max_instance_count") == 1,
          f"max_instance_count={web_scaling.get('max_instance_count')} — raising this needs a "
          "distributed-throttle design, not a bigger number")

    print("\nImage pinning")
    for name, svc in (("web", web), ("worker", worker)):
        template = (svc.get("template") or [{}])[0]
        containers = template.get("containers") or [{}]
        image = containers[0].get("image", "")
        # A tag can be repointed between two applies, which would let the two services run
        # different code against one database. A digest cannot.
        check(f"{name} is pinned to a digest",
              "@sha256:" in image,
              f"image={image}")

    images = {
        ((s.get("template") or [{}])[0].get("containers") or [{}])[0].get("image")
        for s in (web, worker)
    }
    check("both services run the SAME image", len(images) == 1, f"images={images}")

    print("\nSecrets")
    secrets = by_type(plan, "google_secret_manager_secret")
    check("twelve application secrets are declared", len(secrets) == 12, f"found {len(secrets)}")
    secret_ids = {value.get("secret_id") for value in secrets.values()}
    check("the admin password verifier container is declared",
          "farm-friend-admin-password-hash" in secret_ids)
    # F-069. Declared as a container whether or not it holds a version: the web service mounts it
    # only when `mount_geocoding_key` is true, because `latest` on a versionless secret resolves
    # to nothing and Cloud Run refuses the revision.
    check("the geocoding key container is declared",
          "farm-friend-geocoding-api-key" in secret_ids)
    # F-078. Same gated mount as geocoding, and declared as a container regardless of the flag.
    check("the smtp password container is declared",
          "farm-friend-smtp-password" in secret_ids)
    # F-079. Three containers, same gate, declared regardless of the mount flag.
    check("the email hash salt container is declared",
          "farm-friend-email-hash-salt" in secret_ids)
    check("the verification code salt container is declared",
          "farm-friend-verification-code-salt" in secret_ids)
    check("the farmer start secret container is declared",
          "farm-friend-farmer-start-secret" in secret_ids)
    check("the magic-link secret container is absent",
          "farm-friend-magic-link-secret" not in secret_ids)

    # This is deliberately about changes rather than planned values. A plan can have the
    # correct final five containers while silently retaining the retired one in state, or it
    # can create the replacement while deleting a survivor. The address move preserves the
    # four existing protected instances; only the new verifier is created and only the old
    # magic-link container is deleted, which requires the separate production approval.
    secret_changes = changed_addresses(plan, "google_secret_manager_secret")
    check("secret changes are limited to the approved cutover, or none after cutover",
          secret_cutover_changes_are_safe(secret_changes),
          f"changes={secret_changes}")

    # THE assertion that keeps credentials out of state. Terraform creates containers; values
    # are added out of band with `gcloud secrets versions add`. A value here would be written
    # to state in cleartext — and PHONE_HASH_SALT can never be rotated, so that leak is
    # permanent and unfixable.
    versions = by_type(plan, "google_secret_manager_secret_version")
    check("no secret VALUES are managed by terraform", len(versions) == 0,
          f"{len(versions)} secret version resource(s) would put cleartext in state")

    # A blunt backstop: scan the whole serialized plan for anything credential-shaped.
    serialized = json.dumps(plan)
    check("the plan contains no postgres connection string",
          not re.search(r"postgres(?:ql)?://[^\"\\s]*:[^\"\\s]*@", serialized))
    check("the plan contains no telnyx key literal",
          "KEY0" not in serialized and not re.search(r"\bKEY[A-Z0-9]{20,}", serialized))

    print("\nInvocation")
    scheduler = by_type(plan, "google_cloud_scheduler_job")
    check("a scheduler job is planned", len(scheduler) == 1, f"found {len(scheduler)}")
    for name, job in scheduler.items():
        target = (job.get("http_target") or [{}])[0]
        # OIDC replaced CRON_SECRET, which lived in two places that had to match and returned
        # a 401 indistinguishable from success in any scheduler UI.
        check("the scheduler authenticates with OIDC",
              bool(target.get("oidc_token")),
              "no oidc_token — the worker would refuse every scheduled run")
        check("the recovery pass runs every minute",
              job.get("schedule") == "* * * * *",
              f"schedule={job.get('schedule')} — this is the only trigger for the retention purge")

    queues = by_type(plan, "google_cloud_tasks_queue")
    check("a task queue is planned", len(queues) == 1, f"found {len(queues)}")
    for name, q in queues.items():
        retry = (q.get("retry_config") or [{}])[0]
        # The queue is the DURABLE path; a task that fails must come back.
        check("the queue retries failed tasks",
              (retry.get("max_attempts") or 0) > 1,
              f"max_attempts={retry.get('max_attempts')}")

    print("\nService URLs")
    # The host suffix is an explicit input (see variables.tf), so a wrong value would point the
    # queue and the scheduler at URLs that do not exist — and that failure is SILENT: tasks and
    # scheduled runs 404 forever while every service looks healthy. Assert that what the web
    # service was told to call matches what the worker actually is.
    web_env = {
        e["name"]: e.get("value")
        for e in ((web.get("template") or [{}])[0].get("containers") or [{}])[0].get("env", [])
        if isinstance(e, dict) and e.get("value")
    }
    target = web_env.get("CLOUD_TASKS_TARGET_URL", "")
    worker_name = worker.get("name", "farm-friend-worker")
    check("the task target points at the worker service",
          worker_name in target and target.endswith("/api/internal/kick"),
          f"CLOUD_TASKS_TARGET_URL={target}")

    check("both services agree on the public base url",
          bool(web_env.get("PUBLIC_BASE_URL", "").startswith("https://")),
          f"PUBLIC_BASE_URL={web_env.get('PUBLIC_BASE_URL')}")

    check("the web service has a canonical public map url",
          bool(web_env.get("PUBLIC_MAP_URL", "").startswith("https://")),
          f"PUBLIC_MAP_URL={web_env.get('PUBLIC_MAP_URL')}")

    # F-113. PUBLIC_BASE_URL is what every texted farmer link is built from. A custom domain that
    # is claimed on Cloud Run but NOT carried into PUBLIC_BASE_URL would leave the mapping serving
    # while every SMS still sent the `*.run.app` host — the exact block this change exists to fix,
    # with a green apply on top of it. Assert the two agree in both directions.
    mapped_hosts = {
        values.get("name")
        for values in by_type(plan, "google_cloud_run_domain_mapping").values()
    } - {None}
    base_host = urlparse(web_env.get("PUBLIC_BASE_URL", "")).hostname

    if mapped_hosts:
        check("PUBLIC_BASE_URL uses the mapped custom domain",
              base_host in mapped_hosts,
              f"PUBLIC_BASE_URL host={base_host} mapped={sorted(mapped_hosts)}")
    else:
        check("PUBLIC_BASE_URL falls back to the run.app host when nothing is mapped",
              bool(base_host and base_host.endswith(".run.app")),
              f"no domain mapping planned, but PUBLIC_BASE_URL host={base_host}")

    # The worker needs PUBLIC_BASE_URL too — `resolveConfig` requires it before any pass runs,
    # and omitting it crashed every scheduled run with a ConfigurationError that only the
    # worker's logs revealed.
    worker_env = {
        e["name"]: e.get("value")
        for e in ((worker.get("template") or [{}])[0].get("containers") or [{}])[0].get("env", [])
        if isinstance(e, dict) and e.get("value")
    }
    check("the worker also has PUBLIC_BASE_URL",
          bool(worker_env.get("PUBLIC_BASE_URL")),
          "absent — the worker fails closed on every scheduled run")

    check("both services agree on the public map url",
          worker_env.get("PUBLIC_MAP_URL") == web_env.get("PUBLIC_MAP_URL"),
          f"web={web_env.get('PUBLIC_MAP_URL')} worker={worker_env.get('PUBLIC_MAP_URL')}")

    def secret_names(service: dict) -> set[str]:
        container = ((service.get("template") or [{}])[0].get("containers") or [{}])[0]
        return {
            env.get("name") for env in container.get("env", [])
            if isinstance(env, dict) and env.get("value_source")
        }

    check("the web service mounts ADMIN_PASSWORD_HASH",
          "ADMIN_PASSWORD_HASH" in secret_names(web))
    check("the worker does not mount ADMIN_PASSWORD_HASH",
          "ADMIN_PASSWORD_HASH" not in secret_names(worker))
    # F-069 — geocoding is BILLED PER CALL and its only caller is a throttled web route. The
    # worker has no use for it, so mounting it there would put a spending credential in a process
    # with nothing rationing it. Asserted unconditionally: true whether or not the web service
    # mounts it, so flipping `mount_geocoding_key` can never quietly hand it to the worker.
    check("the worker never mounts GEOCODING_API_KEY",
          "GEOCODING_API_KEY" not in secret_names(worker))
    # F-078 — the SMTP password authenticates as VIGA's BOARD MAILBOX, so this is a stronger
    # claim than the geocoding one: the worker holding it would grant send-as authority over a
    # real mailbox to a process that sends no email. Asserted unconditionally, so flipping
    # `mount_smtp_password` can never quietly hand it over.
    check("the worker never mounts SMTP_PASSWORD",
          "SMTP_PASSWORD" not in secret_names(worker))
    for _name in ("GMAIL_OAUTH_CLIENT_SECRET", "GMAIL_OAUTH_REFRESH_TOKEN"):
        check(f"the worker never mounts {_name}", _name not in secret_names(worker))
    check("Gmail delivery has no SMTP configuration",
          email_delivery_configuration_is_exclusive(web_env, secret_names(web)),
          "Gmail delivery must not mount or configure SMTP")
    # NO APPLY MAY SILENTLY UNMOUNT A SECRET THAT IS ALREADY LIVE.
    #
    # This exists because it HAPPENED. `GEOCODING_API_KEY` was mounted on web revision 00034 and
    # was stripped at 00035 by the SMTP apply, which passed `mount_smtp_password=true` and
    # nothing else — every mount flag defaults to false, and nothing recorded which ones
    # production was running with. It stayed absent through 00036, 00037 and 00038, and since
    # F-077 made the typed address the only source of a coordinate, that meant no visitable
    # stand could be created at all. Every one of those applies reported success.
    #
    # `infra/production.tfvars` is the fix; this is the guard that proves the fix was used. It
    # compares the plan's BEFORE against its AFTER, so it fails on the real regression rather
    # than on a flag's value.
    for _svc, _label in ((web_change, "web"), (worker_change, "worker")):
        _before = _svc.get("change", {}).get("before") or {}
        _after = _svc.get("change", {}).get("after") or {}
        _before_names = _mounted_secret_names(_before)
        _after_names = _mounted_secret_names(_after)
        _dropped = _before_names - _after_names
        check(f"the {_label} service removes no live secret except SMTP_PASSWORD's Gmail replacement",
              dropped_secret_mounts_are_safe(
                  _before_names, _after_names, web_env if _label == "web" else worker_env
              ),
              f"would remove {sorted(_dropped)} without the exact Gmail credential replacement")
    # F-079 — the worker verifies nobody. `EMAIL_HASH_SALT` is the sharpest of the three: it is
    # an UNROTATABLE lookup key for every farmer address, so mounting it into a process with no
    # use for it widens a compromise's blast radius for nothing. Asserted unconditionally, so
    # flipping `mount_email_verification` can never quietly hand any of them to the worker.
    for _name in ("EMAIL_HASH_SALT", "VERIFICATION_CODE_SALT", "FARMER_START_SECRET"):
        check(f"the worker never mounts {_name}",
              _name not in secret_names(worker))
    # None of the three may arrive as a plain env value. A salt written into the revision
    # template is readable from the service description by anyone with Cloud Run view access,
    # and sits in the plan — and therefore in state — as cleartext. That is permanent for
    # `EMAIL_HASH_SALT`, which can never be rotated.
    for _name in ("EMAIL_HASH_SALT", "VERIFICATION_CODE_SALT", "FARMER_START_SECRET"):
        # `if e.get("value")` is load-bearing and was MISSING in the first version of this
        # check, which therefore failed on the correct configuration: a secret MOUNT appears in
        # `env` too, with an empty `value` and a real `value_source`. Without the filter this
        # flagged every properly-mounted secret, exactly as it does for `PHONE_HASH_SALT`.
        # What must never appear is a LITERAL value, which would sit in state in cleartext —
        # permanently, for `EMAIL_HASH_SALT`, which can never be rotated.
        check(f"{_name} is never a plain environment value",
              all(
                  _name not in {
                      e.get("name") for e in
                      (((sv.get("template") or [{}])[0].get("containers") or [{}])[0].get("env") or [])
                      if isinstance(e, dict) and e.get("value")
                  }
                  for sv in (web, worker)
              ))
    # The credential must arrive from Secret Manager, never as a plain env value. A password
    # written into the revision template is readable from the service description by anyone with
    # Cloud Run view access, and would be in the plan — and therefore in state — as cleartext.
    check("SMTP_PASSWORD is never a plain environment value",
          all(
              "SMTP_PASSWORD" not in {
                  e.get("name") for e in
                  (((s.get("template") or [{}])[0].get("containers") or [{}])[0].get("env") or [])
                  if isinstance(e, dict) and e.get("value")
              }
              for s in (web, worker)
          ),
          "an SMTP password supplied as a literal env value would sit in state in cleartext")
    for _name in ("GMAIL_OAUTH_CLIENT_SECRET", "GMAIL_OAUTH_REFRESH_TOKEN"):
        check(f"{_name} is never a plain environment value",
              all(
                  _name not in {
                      e.get("name") for e in
                      (((s.get("template") or [{}])[0].get("containers") or [{}])[0].get("env") or [])
                      if isinstance(e, dict) and e.get("value")
                  }
                  for s in (web, worker)
              ))
    check("no service mounts MAGIC_LINK_SECRET",
          all("MAGIC_LINK_SECRET" not in secret_names(service) for service in (web, worker)))

    # The sender address is CONFIGURATION, not a hard-coded string — an F-078 acceptance
    # criterion, and what makes moving to a dedicated address an apply rather than a code
    # change. Asserted on the plan because that is the artifact the platform consumes: a
    # default baked into the application would satisfy any source-level check and still be
    # invisible here.
    sender_env = "GMAIL_SENDER_ADDRESS" if web_env.get("EMAIL_PROVIDER") == "gmail" else "SMTP_FROM_ADDRESS"
    check("the web service is told its sender address",
          "@" in (web_env.get(sender_env) or ""),
          f"{sender_env}={web_env.get(sender_env)} — the sender must be configuration, "
          "never a default compiled into the application")
    check("the worker is given no email configuration",
          not any(key.startswith(("SMTP_", "GMAIL_", "EMAIL_PROVIDER")) for key in worker_env),
          # Single-quoted inside the expression on purpose: reusing the OUTER quote character
          # here needs Python 3.12+, and this file ran under 3.10 for a month as a SyntaxError
          # that only surfaced when someone actually ran the assertions.
          f"worker carries {sorted(k for k in worker_env if k.startswith(('SMTP_', 'GMAIL_', 'EMAIL_PROVIDER')))} — the worker "
          "sends no email and must not be configured as though it could")

    print("\nSecret rotation reaches containers")
    # B-021. Cloud Run resolves `version = "latest"` at CONTAINER START, so adding a secret
    # version changes nothing that is already running and an apply that leaves the revision
    # template byte-identical creates no revision to re-read it. Production served a
    # pre-rotation DATABASE_URL for ~25 minutes that way, against an already-reset Neon
    # password, while the apply that was supposed to fix it reported "2 to change" and applied
    # cleanly.
    #
    # ROTATION_APPLIED_AT is what makes the template change. Anchored to the SECRET MOUNTS
    # rather than to the variable's name: the property is "a service that mounts secrets
    # carries a rotation marker", so a service that stopped mounting secrets is legitimately
    # exempt and a service that gained one is caught. Asserting the variable exists in the
    # config would prove only that someone wrote the word.
    for name, svc in (("web", web), ("worker", worker)):
        container = ((svc.get("template") or [{}])[0].get("containers") or [{}])[0]
        envs = container.get("env") or []
        mounts_secret = any(
            isinstance(e, dict) and e.get("value_source") for e in envs
        )
        marker = next(
            (e.get("value") for e in envs
             if isinstance(e, dict) and e.get("name") == "ROTATION_APPLIED_AT"),
            None,
        )
        check(f"{name} mounts its secrets from Secret Manager", mounts_secret,
              "no value_source env — secrets would have to come from somewhere else")
        check(f"{name} carries a rotation marker so a new version forces a new revision",
              bool(marker),
              "ROTATION_APPLIED_AT absent — `gcloud secrets versions add` would leave this "
              "container serving the old value (B-021)")

    # Both services must carry the SAME marker. They share one image and one digest; a marker
    # bumped on one alone would restart one service and leave the other on the old secret —
    # which is the B-021 failure surviving on half the deployment.
    markers = {
        next(
            (e.get("value") for e in
             (((s.get("template") or [{}])[0].get("containers") or [{}])[0].get("env") or [])
             if isinstance(e, dict) and e.get("name") == "ROTATION_APPLIED_AT"),
            None,
        )
        for s in (web, worker)
    }
    check("both services carry the same rotation marker", len(markers) == 1,
          f"markers={markers} — a marker bumped on one service restarts only that one")

    print("\nIAM")
    members = by_type(plan, "google_project_iam_member")
    broad = {"roles/owner", "roles/editor", "roles/secretmanager.secretAccessor"}
    granted = {v.get("role") for v in members.values()}
    # A project-level secretAccessor would hand the app every legacy secret in the project,
    # including an ANTHROPIC_API_KEY and an OPENROUTER_API_KEY it has no business reading.
    check("no broad project-level roles are granted",
          not (granted & broad),
          f"granted={sorted(granted & broad)}")

    print(f"\n{CHECKS - len(FAILURES)}/{CHECKS} checks passed")
    if FAILURES:
        print("\nFAILED:")
        for f in FAILURES:
            print(f"  - {f}")
        return 1
    print("plan assertions PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
