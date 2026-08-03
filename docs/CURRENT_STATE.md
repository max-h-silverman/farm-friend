# Farm Friend — Current State & Open Items

> **Live snapshot, overwritten by `/session-wrap` — not a changelog.** Record only verified facts.
> The architecture docs own enduring contracts; historical reasoning lives in the session records.

## Release state

Farm Friend is **pre-go-live**. Merged commit `2a6eba1` is live on Cloud Run as one image across web
revision `farm-friend-web-00019-lg9` and worker revision `farm-friend-worker-00020-ndb`, both at
digest `sha256:a3d63ff627e6e7e74b7a05f04dcd30c97b827ce235515fbefaaea55eed7d1491`.
Production Postgres is `neondb` with all 17 migrations applied (`0000`–`0017`, through journal
timestamp `1786500000000`). Production now includes:

- F-049: owner-confirmed stand closure and reopening;
- F-050: owner-confirmed **Also selling here** names;
- F-051: deterministic `STAND` / `SETTINGS` and exact multi-stand targeting;
- F-052: scheduled inventory prompts and context-bound `SAME`;
- F-055: completed and visually exercised administrator and farmer web workflows;
- farmer invitations, unbound-farm onboarding, and administrator Farm Bucks status editing;
- the VIGA-poster public map treatment: legend above listings, dot-only card indicators in their own
  column, left-aligned card text, and two-way card/marker collapse;
- VIGA-only Squarespace admin embedding through a partitioned session cookie, a framing allowlist,
  and independent same-origin checks on authenticated writes;
- one shared iframe-height handshake across map, admin, and farmer pages; it measures actual content
  so a VIGA embed grows and shrinks without an inner scrollbar;
- B-031/B-032: one final pre-launch identity and data architecture, with no compatibility paths;
- B-033: dead admin queue GET APIs, unused model-call fields, and the phone-salt recovery utility
  removed; active documentation reconciled to the final architecture.

F-056 is deployed but remains **in review** pending the remaining live browser proof. Max
successfully signed in with the fixed production account; a direct database check found exactly one
active 12-hour session with a 64-character token hash, the fixed administrator id, and no retained
login-failure row. The web service mounts the single enabled version of
`farm-friend-admin-password-hash`; the worker cannot read or mount it.
Neither service mounts `MAGIC_LINK_SECRET`, and the old magic-link secret container and its runtime
IAM grant are deleted. `/admin/login` serves the fixed `board@vigavashon.org` password form, the old
request-link and callback routes return 404, and an unauthenticated `/admin` request renders only the
sign-in surface.

F-057 is deployed as part of `2a6eba1`. Standalone `MAP` is a deterministic SMS command, returning
only the configured `PUBLIC_MAP_URL` before model-assisted handling. STOP/START and consent
safeguards retain their existing precedence. The deploy plan refuses an absent non-HTTPS map URL or
a web/worker mismatch.

Every standing link names one exact authorized stand, sales-location ownership is `owner_farm_id`,
and proposal rows contain only the fields the current confirmation flow reads. There is no rolling
or nullable compatibility state.

## Verification

The current release passes 91 unit-test files / 874 tests, 41 real-Postgres integration-test files /
561 tests against disposable databases, typecheck, lint, and the production web build. The focused
map interaction suite passes 4/4. The release introduced no model-facing seam, so no model
evaluation is owed. Cloud Build `bc444893-2f59-4a9a-aaaa-31d30b2a5c16` published the exact merged
commit; the OpenTofu plan passed 37/37 assertions and applied 0 adds, 2 service updates, and 0
destroys. Post-deploy secret-freshness assertions and served vCard byte assertions pass. The
canonical public map route returns 200 from the live web revision.

The pushed F-056 commit `f041669` passes 842 unit tests, 551 integration tests across 40 files
against a fresh local Postgres cluster, typecheck, lint, 44 scripted eval cases, and the production
web build. Its route manifest contains `/api/auth/login` and `/api/auth/logout` and no deleted
magic-link request or callback route.

The post-migration image-build correction at `ab30a81` passes 843 unit tests, 551 integration tests
against a fresh local Postgres cluster, typecheck, lint, 44 scripted eval cases, and the production
web build. Its container test went RED before the fix and again when Python was deliberately removed.
Cloud Build `2d93ba22-63f6-4c05-8c1b-cbe43ddea30a` then built and published the exact archived commit;
tag `ab30a81` and `latest` both resolve to the live immutable digest above.

The F-056 bootstrap plan used the deployed immutable image digest and exactly the four runbook
exclusions. `bootstrap-secret-plan-assertions.py` and direct JSON inspection proved four no-op
survivor address moves plus one password-container create, with no service, IAM, secret-version,
old-secret, replacement, update, or deletion action: `1 add, 0 change, 0 destroy`. Applying that
exact saved plan produced the same summary. Direct cloud and state checks then proved the new
container exists with zero versions, every existing secret container and version retained its
pre-apply identity and metadata, both service revisions and mounts were unchanged, and state holds
the four survivors at protected addresses alongside the new container and retained old secret.

Max provisioned password-secret version 1 through the non-echoing command. Before migration, the
direct production target had one fixed administrator, no alternate identity, no sessions, and 15
migrations. Migration `0015` advanced the exact journal timestamp/hash, added the empty durable
login-failure table and fixed-identity constraint, removed the magic nonce column/index/constraint,
and preserved all recorded approval/review/audit-related row counts. There were no sessions to
revoke. The full saved cutover plan passed 35/35 assertions and direct JSON inspection, then applied
exactly one IAM create, two service updates, the old IAM delete, and the old secret delete. Post-apply
checks prove both revisions are newer than every secret version, both services run the same digest,
only web mounts the password secret, no service mounts the old secret, state contains only the five
protected application containers and matching runtime-read grants, health is green, and the served
vCard remains byte-correct.

Sabotage made every load-bearing B-033 guard fail for its claimed effect, then the restored focused
suite passed 10/10: all five removed queue GET exports, the surviving flag-thread browser call,
provider label, schema-name argument, required output instructions, the deleted rehash utility, and
the executable old/new-salt scan. The surviving thread route is exercised through a live admin
session and returns only one retained flagged thread, with a masked sender and no contact-row phone
or hash field in the response.

B-033 changes no model projection, output schema, output contract, or actual provider message. The
five representative provider message arrays are byte-identical to the pre-B-033 base (SHA-256
`80d9dbc6da7ec487f70acd1c2842775b81372a170c3f047c78f3025eacf3b1b5`). Therefore no paid
`evals:live` run is owed for B-033. Scripted evals remain required.

Production release verification passed revision/secret freshness for both services, exact shared
image digest and 100% traffic, live health and public reads, protected-admin refusal, internal
worker ingress, and the served vCard's exact bytes. `/admin/login` serves HTTP 200 with
`frame-ancestors 'self' https://vigavashon.org https://www.vigavashon.org`; its served shared-layout
bundle contains the content measurement, `ResizeObserver`, and `farm-friend:height` message. The
Cloud Tasks queue is `RUNNING`; the Cloud Scheduler job is `ENABLED`.

## What is live

- **Public discovery:** model-free map/list, offering filters, honest recency, closures, participant
  names, transient browser proximity, destination links, and a code-bound stock-out form.
- **Farmer onboarding and web:** deterministic `SIGNUP` / `LINK`, VIGA authorization, one exact
  stand per standing credential, inventory proposal/confirmation, participant editing, and reminder
  settings. Revocation is re-read on every request.
- **Farmer SMS:** deterministic compliance and commitment routing precedes every model call;
  `STAND`, `SETTINGS`, `SAME`, and `MORE` are context-bound and model-free.
- **Customer SMS:** model interpretation → code retrieval → model identifier selection → code
  validation and rendering. Model output cannot author factual reply text or durable state.
- **Administration:** server-rendered queues for farm approval, farmer access, flags, stock-out
  reports, and stand-data questions. Browser actions use guarded POST routes. The flag-thread GET is
  the only admin queue read API because it has a live browser consumer; phones are masked at query.
- **Scheduled work:** Cloud Tasks handles immediate sender work; one Cloud Scheduler route runs
  recovery, scheduled prompts, outbound delivery, carrier callbacks, and retention.

## Live invariants

- `STOP` is global and deterministic; confirmation and farmer/customer keywords never shadow it.
- The model proposes; code commits. Publication rechecks farmer authority and VIGA approval under
  the shared sender → location → authorization → proposal → approval lock order.
- Phones are normalized at ingress, keyed and logged only by hash, never sent to a model, and masked
  in administrator readers. Raw E.164 exists in exactly one database column for outbound delivery.
- **`PHONE_HASH_SALT` never rotates.** No script, package command, environment exception, or
  operational recovery path exists. A suspected compromise requires a new explicitly approved
  data-migration design.
- The public read graph cannot reach a model. Consequential and cross-actor text is code-rendered.
- Drizzle generation omits hand-written CHECK constraints; migration metadata tests require every
  declared CHECK to exist in executable SQL. Every nullable constraint needs its decisive NULL case.

## Open before go-live

- **F-029:** complete the remaining live carrier/JOIN launch verification. Its migration and deploy
  legs are complete.
- **F-056:** Max must still prove every protected administrator page, logout and copied-cookie
  refusal, throttle behavior, expiry/revocation, mobile/desktop layout, keyboard/focus, and recovery
  copy in a live browser before the item can leave `in review`.
- **B-024:** permanently encode the farmer's no-public-address instruction in seed behavior before
  any reseed. Production is currently hidden as an approved interim correction.
- **B-008:** the deployed web build still lacks a truthful lint gate.
- **B-034 (planned, high):** `npm audit --omit=dev` reports three high-severity production
  dependency advisory groups: direct `drizzle-orm`, direct Next.js, and transitive PostCSS. Upgrade
  to supported lines and assess application reachability. No exploit was observed, and not every
  advisory is known to be reachable in Farm Friend.
- **F-044:** verify the public map and administrator embeds on VIGA's actual Squarespace pages,
  including sign-in and an authenticated write inside the admin iframe.
- Physical-handset checks remain owed for the vCard and paged SMS threading/segments.
- Exercise the complete farmer onboarding/status update, administrator view, farmer settings,
  customer inquiry, and farmer update flows against production and verify database effects rather
  than screen messages.
