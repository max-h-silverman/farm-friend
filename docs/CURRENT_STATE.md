# Farm Friend — Current State & Open Items

> **Live snapshot, overwritten by `/session-wrap` — not a changelog.** Record only verified facts.
> The architecture docs own enduring contracts; historical reasoning lives in the session records.

## Release state

Farm Friend is **pre-go-live**. Production serves the Phase 0 confirmation repairs from commit
`44110d2` on Cloud Run as one image across the public web and private worker services. Production
Postgres is `neondb` with 10 applied migrations (`0000`–`0009`). The last production fingerprint
found 1 contact, 35 sales locations, 212 offerings, 1 administrator, and no inventory revisions,
proposals, farmer authorizations, farmer links, farm approvals, or admin sessions.

The local release candidate is ahead of production and is **not deployed**. It contains:

- F-049: owner-confirmed stand closure and reopening;
- F-050: owner-confirmed **Also selling here** names;
- F-051: deterministic `STAND` / `SETTINGS` and exact multi-stand targeting;
- F-052: scheduled inventory prompts and context-bound `SAME`;
- F-055: completed and visually exercised administrator and farmer web workflows;
- B-031/B-032: one final pre-launch identity and data architecture, with no compatibility paths;
- B-033: dead admin queue GET APIs, unused model-call fields, and the phone-salt recovery utility
  removed; active documentation reconciled to the final architecture.

Migrations `0010`–`0014` are not applied in production. Because this is pre-go-live and the affected
production tables contain no user workflow rows, those unapplied migrations define the final schema
directly: administrator identity is email-only, every standing link names one exact authorized
stand, sales-location ownership is `owner_farm_id`, and proposal rows contain only the fields the
current confirmation flow reads. There is no rolling or nullable compatibility state.

## Verification

The B-033 release candidate passes 879 unit tests, 572 integration tests across 39 files against
an isolated real Postgres server, 44 scripted eval cases, typecheck, lint, and the production web
build. The integration run creates empty databases and also exercises the populated B-031/B-032
forward-migration proofs: authority, participant, location, proposal, and revision rows survive;
exact-target and required-section NULL cases fail with Postgres `23502`; removed columns and
defaults remain absent; and all 15 migrations are durable. Drizzle generation is a true no-op.

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

## What works in the local release candidate

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

- **F-029:** apply migrations, deploy the release candidate, wire/verify the live carrier path, and
  execute the launch verification ladder.
- **F-031:** select and attest a mail provider; until then administrator sign-in links are not
  delivered and must be minted out of band.
- **B-024:** permanently encode the farmer's no-public-address instruction in seed behavior before
  any reseed. Production is currently hidden as an approved interim correction.
- **B-008:** the deployed web build still lacks a truthful lint gate.
- **F-044:** verify the Squarespace embed handshake on VIGA's actual page.
- Physical-handset checks remain owed for the vCard and paged SMS threading/segments.
- After deployment, exercise the complete farmer onboarding/status update, administrator view,
  farmer settings, customer inquiry, and farmer update flows against the deployed system and verify
  database effects rather than screen messages.
