#!/usr/bin/env python3
"""Tests for `deploy-assertions.py` — the post-apply check that a rotated secret was picked up.

    cd infra && python3 test_deploy_assertions.py

WHY A TEST FOR THIS ASSERTION SCRIPT. `plan-assertions.py` runs against a real plan on every deploy,
and its state-dependent secret-change rule also has focused tests. `deploy-assertions.py` is
different in the way that matters — it only ever sees the healthy case. Production is currently
healthy (revisions newer than
every secret version), so running it against the live project passes whether or not the
comparison inside it works at all. The B-021 window it exists to catch lasted 25 minutes and
is gone; there is no live input that can make it fail.

So the failure case has to be constructed. Each test below feeds the checker a hand-built
picture of revisions and secret versions and asserts the verdict, including the exact
B-021 timeline (revision 16:09:26, secret version 16:35:29) which must be reported as stale.
"""

import sys
from datetime import datetime, timedelta, timezone

from deploy_assertions import Revision, SecretVersion, evaluate

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


def t(iso: str) -> datetime:
    return datetime.fromisoformat(iso).replace(tzinfo=timezone.utc)


def main() -> int:
    print("\nThe B-021 timeline itself")

    # The exact numbers from the outage, read from the live project during the fix:
    # `gcloud secrets versions list` reported database-url version 2 created 16:35:29, while
    # `gcloud run revisions list` reported farm-friend-worker-00005 created 16:09:26 — 26
    # minutes EARLIER. Cloud Run binds `version = "latest"` at container start, so that
    # revision was serving the pre-rotation password against an already-reset Neon database
    # and every call failed 28P01.
    b021 = evaluate(
        revisions=[Revision("farm-friend-worker", "00005-7tz", t("2026-07-29T16:09:26"))],
        versions=[SecretVersion("farm-friend-database-url", "2", t("2026-07-29T16:35:29"))],
    )
    check("the B-021 outage is reported as stale", not b021.ok,
          "the whole point of the script — this timeline must not pass")
    check("it names the service that is stale",
          any("farm-friend-worker" in p for p in b021.problems),
          f"problems={b021.problems}")
    check("it names the secret that outran the revision",
          any("farm-friend-database-url" in p for p in b021.problems),
          f"problems={b021.problems}")

    print("\nThe healthy case")

    # Production after the forced revisions: worker 00006 at 17:34:10, newest secret version
    # 16:35:30. Revision is newer, so it read the rotated values at start.
    healthy = evaluate(
        revisions=[
            Revision("farm-friend-worker", "00006-srg", t("2026-07-29T17:34:10")),
            Revision("farm-friend-web", "00005-klx", t("2026-07-29T17:34:21")),
        ],
        versions=[
            SecretVersion("farm-friend-database-url", "2", t("2026-07-29T16:35:29")),
            SecretVersion("farm-friend-deepinfra-api-key", "2", t("2026-07-29T16:35:30")),
            SecretVersion("farm-friend-phone-hash-salt", "1", t("2026-07-29T15:08:39")),
        ],
    )
    check("the current production state passes", healthy.ok, f"problems={healthy.problems}")

    print("\nThe boundary")

    base = t("2026-07-29T12:00:00")

    # A revision created in the SAME second as the version is not proof it read it: Cloud Run
    # resolves `latest` when the container starts, which is after the revision record is
    # created, but the ordering within one second is not observable here. Equal timestamps
    # must fail — the safe direction, since a false pass is an outage and a false alarm is a
    # redeploy.
    equal = evaluate(
        revisions=[Revision("svc", "r1", base)],
        versions=[SecretVersion("sec", "1", base)],
    )
    check("an equal timestamp is treated as stale", not equal.ok,
          "ties must fail closed — a tie cannot prove the container read the new version")

    one_second_newer = evaluate(
        revisions=[Revision("svc", "r1", base + timedelta(seconds=1))],
        versions=[SecretVersion("sec", "1", base)],
    )
    check("one second newer passes", one_second_newer.ok,
          f"problems={one_second_newer.problems}")

    print("\nEvery service, every secret")

    # The web service was ALSO stale during B-021 and was fixed in the same pass. A checker
    # that stopped at the first bad service would have reported the worker and hidden the web
    # service behind it.
    both_stale = evaluate(
        revisions=[
            Revision("farm-friend-worker", "00005", base),
            Revision("farm-friend-web", "00004", base),
        ],
        versions=[SecretVersion("farm-friend-database-url", "2", base + timedelta(minutes=26))],
    )
    check("both stale services are reported, not just the first",
          not both_stale.ok
          and any("farm-friend-worker" in p for p in both_stale.problems)
          and any("farm-friend-web" in p for p in both_stale.problems),
          f"problems={both_stale.problems}")

    # A rotation touches one secret at a time. If the check only compared against the OLDEST
    # or against one arbitrary secret, a single freshly-rotated credential would slip past.
    one_of_many = evaluate(
        revisions=[Revision("svc", "r1", base)],
        versions=[
            SecretVersion("old-a", "1", base - timedelta(days=1)),
            SecretVersion("old-b", "1", base - timedelta(hours=2)),
            SecretVersion("just-rotated", "3", base + timedelta(minutes=1)),
        ],
    )
    check("one freshly rotated secret among many is caught",
          not one_of_many.ok and any("just-rotated" in p for p in one_of_many.problems),
          f"problems={one_of_many.problems}")

    print("\nDegenerate input must never pass silently")

    # An empty result is what a wrong project, a wrong region, or a typo'd service name
    # produces. Reporting "0 problems, all good" there is the failure mode this whole class
    # of check keeps falling into — a green result that means "I looked at nothing".
    check("no revisions at all is a failure, not a pass",
          not evaluate(revisions=[], versions=[SecretVersion("s", "1", base)]).ok,
          "an empty revision list means the lookup failed, not that everything is fine")
    check("no secret versions at all is a failure, not a pass",
          not evaluate(revisions=[Revision("svc", "r", base)], versions=[]).ok,
          "an empty version list means the lookup failed, not that nothing is rotated")

    print(f"\n{CHECKS - len(FAILURES)}/{CHECKS} checks passed")
    if FAILURES:
        print("\nFAILED:")
        for f in FAILURES:
            print(f"  - {f}")
        return 1
    print("deploy-assertion tests PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
