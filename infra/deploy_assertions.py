#!/usr/bin/env python3
"""Assert that every running revision is NEWER than every secret version it consumes.

    cd infra
    python3 deploy_assertions.py                     # against the live project
    python3 deploy_assertions.py --project X --region Y

WHY THIS EXISTS — B-021. Cloud Run reads secrets **at container start**. `version = "latest"`
in `services.tf` is resolved once, when the container boots, and a running container never
re-reads it. So `gcloud secrets versions add` changes nothing about what is serving, and the
`tofu apply` that follows only helps if it actually alters the revision template. On
2026-07-29 it did not: the apply reported "2 to change", applied cleanly, and produced **no
new revision after the secrets landed**. Both services kept the pre-rotation `DATABASE_URL`
against an already-reset Neon password, every database call failed `28P01`, and production was
down for ~25 minutes. A real handset found it, after a synthetic proof of the same runtime
had passed.

WHAT THIS CHECKS, AND WHY IT IS A TIMESTAMP COMPARISON. The honest statement of the property
is "the container read the current value of every secret". That is not directly observable —
nothing exposes which version a running container resolved. What IS observable is when the
revision was created and when each secret version was created, and a revision created after a
version must have resolved that version or a later one. So the assertion is:

    every revision's creation time  >  every secret version's creation time

WHY NOT THE ANNOTATION DESIGN. B-021's notes offered a better-sounding alternative: put the
resolved secret version IDs into a revision annotation, so adding a version changes the
template and Terraform is FORCED to create a revision. That prevents rather than detects, and
it was the first choice here. **It cannot be built safely with this provider.** Resolving
`latest` to a version number requires `data.google_secret_manager_secret_version`, which pulls
the secret's CLEARTEXT PAYLOAD into the plan and into state — verified directly: a probe plan
put a live Neon password in `prior_state`, and `plan-assertions.py`'s existing "no postgres
connection string" check flagged it. The metadata-only `data.google_secret_manager_secret`
exposes no version number at all, and the Google provider does not implement the `ephemeral`
resource that would read a value without persisting it. The remaining variant — a version
number hand-carried in `terraform.tfvars` — reintroduces the same silent-staleness bug one
level up, because a forgotten bump looks exactly like a correct config.

This check needs none of that: revision creation times and secret version creation times are
both metadata, and there is no path from either to a payload.

WHAT IT DOES NOT PROVE. That the values are CORRECT — only that they are current as of the
newest version. A revision started after a rotation still fails if the rotated value itself is
wrong. Proof of correctness is behavioural and belongs to the endpoint checks in
RUNBOOK §"Credential rotation".
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone

PROJECT = "farm-friend-vashon"
REGION = "us-west1"
SERVICES = ("farm-friend-web", "farm-friend-worker")


@dataclass(frozen=True)
class Revision:
    service: str
    name: str
    created: datetime


@dataclass(frozen=True)
class SecretVersion:
    secret: str
    version: str
    created: datetime


@dataclass
class Verdict:
    ok: bool
    problems: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)


def evaluate(
    revisions: list[Revision],
    versions: list[SecretVersion],
) -> Verdict:
    """Compare each serving revision against the newest secret version it could consume.

    Pure — no gcloud, no clock, no environment. Everything that decides the verdict is an
    argument, which is what lets the tests construct the B-021 timeline exactly.
    """
    problems: list[str] = []
    notes: list[str] = []

    # An empty list on either side means the LOOKUP failed — wrong project, wrong region, a
    # renamed service, an expired credential. Reporting "no problems found" for input that
    # was never read is the exact shape of green-because-it-looked-at-nothing that this repo
    # keeps finding (`vercel env ls`'s timestamp column, a containment-only eval pass). Fail.
    if not revisions:
        problems.append(
            "no revisions were found at all — the lookup failed; this is not a passing state"
        )
    if not versions:
        problems.append(
            "no secret versions were found at all — the lookup failed; this is not a passing state"
        )
    if problems:
        return Verdict(ok=False, problems=problems)

    newest = max(versions, key=lambda v: v.created)

    for rev in sorted(revisions, key=lambda r: r.service):
        # Every stale service is reported. Stopping at the first would have named the worker
        # during B-021 and hidden the web service, which was equally stale, behind it.
        stale = [v for v in versions if v.created >= rev.created]
        if stale:
            worst = max(stale, key=lambda v: v.created)
            behind = worst.created - rev.created
            problems.append(
                f"{rev.service} revision {rev.name} was created {rev.created.isoformat()}, "
                f"which is NOT newer than secret {worst.secret} version {worst.version} "
                f"({worst.created.isoformat()}, {behind} later) — "
                f"that container is serving a pre-rotation value"
            )
        else:
            notes.append(
                f"{rev.service} revision {rev.name} ({rev.created.isoformat()}) is newer than "
                f"every secret version; newest is {newest.secret} v{newest.version} "
                f"({newest.created.isoformat()})"
            )

    return Verdict(ok=not problems, problems=problems, notes=notes)


def _gcloud(args: list[str]) -> list[dict]:
    result = subprocess.run(
        ["gcloud", *args, "--format=json"],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(f"gcloud {' '.join(args)} failed: {result.stderr.strip()}")
    return json.loads(result.stdout or "[]")


def _parse_time(raw: str) -> datetime:
    parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def live_revisions(project: str, region: str) -> list[Revision]:
    """The revision each service is actually SERVING, not merely the newest that exists.

    `latestCreatedRevisionName` would be wrong here: a revision that failed its startup probe
    is created but never receives traffic, so comparing its timestamp would report health
    while the old container keeps serving the old secret.
    """
    out: list[Revision] = []
    for service in SERVICES:
        described = subprocess.run(
            [
                "gcloud", "run", "services", "describe", service,
                f"--project={project}", f"--region={region}",
                "--format=value(status.latestReadyRevisionName)",
            ],
            capture_output=True, text=True, check=False,
        )
        if described.returncode != 0:
            raise RuntimeError(
                f"could not describe {service}: {described.stderr.strip()}"
            )
        serving = described.stdout.strip()
        if not serving:
            continue
        revisions = _gcloud([
            "run", "revisions", "describe", serving,
            f"--project={project}", f"--region={region}",
        ])
        record = revisions if isinstance(revisions, dict) else revisions[0]
        out.append(
            Revision(
                service=service,
                name=serving,
                created=_parse_time(record["metadata"]["creationTimestamp"]),
            )
        )
    return out


def live_secret_versions(project: str) -> list[SecretVersion]:
    """Every ENABLED version of every secret the services mount.

    Only enabled versions count. A disabled or destroyed version cannot be what `latest`
    resolves to, so including one would raise a false alarm on a rotation that was cleaned up
    properly.
    """
    secrets = _gcloud([
        "secrets", "list", f"--project={project}", "--filter=name:farm-friend-",
    ])
    out: list[SecretVersion] = []
    for secret in secrets:
        secret_id = secret["name"].rsplit("/", 1)[-1]
        for version in _gcloud([
            "secrets", "versions", "list", secret_id, f"--project={project}",
        ]):
            if version.get("state") != "ENABLED":
                continue
            out.append(
                SecretVersion(
                    secret=secret_id,
                    version=version["name"].rsplit("/", 1)[-1],
                    created=_parse_time(version["createTime"]),
                )
            )
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", default=PROJECT)
    parser.add_argument("--region", default=REGION)
    args = parser.parse_args()

    print("Reading live revisions and secret versions…")
    try:
        revisions = live_revisions(args.project, args.region)
        versions = live_secret_versions(args.project)
    except RuntimeError as exc:
        print(f"\nFAILED: {exc}")
        return 1

    verdict = evaluate(revisions, versions)

    print("\nSecret freshness of serving revisions")
    for note in verdict.notes:
        print(f"  PASS  {note}")
    for problem in verdict.problems:
        print(f"  FAIL  {problem}")

    if not verdict.ok:
        print(
            "\nFAILED — a serving container predates a secret version it consumes.\n"
            "Cloud Run binds secrets at container start, so this container is running a\n"
            "pre-rotation value no matter what any endpoint returns (a warm pooled\n"
            "connection survives a password change and will look healthy).\n"
            "\nForce a fresh revision, then re-run this check:\n"
            f"  gcloud run services update SERVICE --region {args.region} "
            f"--project {args.project} \\\n"
            "    --update-env-vars=ROTATION_APPLIED_AT=$(date -u +%Y-%m-%dT%H-%M)"
        )
        return 1

    print("\ndeploy assertions PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
