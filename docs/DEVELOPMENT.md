# Farm Friend — Pre-Ship Checklists

**How code gets written in general is not here** — test-first, choose the best option regardless of
effort, the zen-desk simplicity rules, verify by effect, sabotage every claim, honest reports all
live in `~/.claude/CLAUDE.md` and apply to every project. This document carries **only what is
specific to Farm Friend**: what each suite proves here, what to test before touching a given area,
this project's non-goals, and the gotchas peculiar to this codebase.

The Golden Rules are in [../CLAUDE.md](../CLAUDE.md). The checklists below are how you satisfy them.

## The suites, and what each one actually proves

- **Unit** — `npm test` (vitest). Keep pure core logic free of DB/SMS/LLM by injecting seams + `Clock`.
  Component tests (`@vitest-environment jsdom`) rely on `vitest.setup.ts` calling Testing Library's
  `cleanup` after each test. **This project runs without `globals: true`, so Testing Library cannot
  register that teardown itself** — without the setup file every mounted component stays in the
  document for the rest of the file, and `getByText` can be satisfied by an *earlier test's* render.
  A component test then passes while the behaviour it names is broken. Do not remove the setup file;
  a duplicate-match error is the only symptom that ever surfaces.
- **Integration** — `npm run test:integration` (vitest, Postgres). Runs migrations **from an empty
  database**, exercises complete use cases with real constraints and transactions, and proves the
  data invariants. Requires `DATABASE_URL`, creates and drops a uniquely named throwaway database,
  and fails explicitly when Postgres is unavailable.
- **Typecheck / lint** — `npm run typecheck` / `npm run lint`. The typecheck proves ordinary callers
  cannot bypass the static provenance barrier. It does **not** prove runtime content safety — `tsc`
  cannot inspect a runtime string.
- **Evals** — `npm run evals`. Required for any change touching a model seam. `critical` fixtures must
  pass **100%**; a provider/prompt change must pass the full suite at parity or better. Use
  **hostile** fixtures that attempt invention, not cooperative canned ones.
- **Evals against the real model** — `npm run evals:live` (needs `DEEPINFRA_MODEL`;
  `DEEPINFRA_API_KEY` from `.env`). Required for any change to a seam's projection, schema, or output
  contract — the scripted suite's stub reads neither your instructions nor your schema, so it cannot
  see an output contract that describes the wrong job. `live-containment` must be 100%; a failure
  **stops and reports**.

## Before you ship a change that touches…

- **Compliance / routing:** test first that keyword + confirmation tokens bypass the model; duplicate
  events are no-ops; concurrent ordinary stateful work is serialized per sender; stale events fail
  closed; an older START cannot undo a newer STOP; one open inventory confirmation is enforced; a
  token predating its current prompt cannot commit; confirmation rechecks farmer authority and VIGA
  approval, commits exactly once, and expires. `SAME` is exact and context-bound after `STOP` and
  ordinary `YES`/`NO`; it reaches no model and publishes only the complete snapshot bound to its
  active scheduled subject.
- **A model seam:** trace it in AI_ARCHITECTURE.md; keep durable writes/recipient/consent out of
  model output; run the **swap test**; run evals **and `npm run evals:live`**. Give the seam an entry
  in `SEAM_OUTPUT_SHAPES` (its examples are parsed through the real schema, so they cannot drift).
  **To add a seam or a program, or swap a provider, follow RUNBOOK.md "how to extend."**
- **A new query/list:** after any approved semantic interpretation, run retrieval in code before
  grounded fact selection; label recency; carry stable fact identifiers; accept only selected IDs
  from the retrieved set; render factual text in code.
- **Anything privacy-relevant:** phones hashed, never logged raw, never in model context. The
  guarantee is **code, not the prompt** — task-specific projections make other actors' private data
  unavailable before the call, the outbound guard blocks raw phones after, and consequential /
  cross-actor replies are code-rendered. Add adversarial workflow proof that injection cannot extract
  unavailable data.
- **SMS ingress:** verify the Telnyx signature over the exact raw bytes, persist only the minimized
  unique inbox projection before acknowledgement, never retain the raw provider envelope, serialize
  stateful work per sender with Postgres row locks, and fail closed on stale events.
- **SMS delivery:** commit unique outbox work with business state; recheck consent at the atomic
  dispatch claim; suppress work when STOP commits first; do not claim recall after dispatch
  authorization; never automatically retry a possibly accepted ambiguous result. For a scheduled
  prompt, also recheck designated authority, approval, preference version/due slot, inventory and
  closure bases, active closure, and newer farmer activity under the shared lock order. Prove
  duplicate due-slot contention by queuing a claimant behind the winner's uncommitted unique-index
  entry.
- **The public map or feed:** it reads the **same published records** as SMS — web and SMS answers
  must agree. Render recency honestly. **Look at it in a browser before calling it done, at phone
  width and with the operating system in both light and dark appearance**. Farm Friend deliberately
  declares a light-only document, so both checks must retain the same readable light palette —
  F-043 shipped five defects past 719 green tests and a
  rendered-bytes inspection, because bytes prove markup and geometry and prove nothing about CSS:
  a dark-mode block that predated the work left the new artwork glowing on a black page, and the
  map rendered taller than the phone screen it is designed for. Also **compare any drawing to the
  data placed on it**: a hand-drawn coastline put 16 of 32 real farms in open water with every
  test passing, because the artwork and the projection were two independent statements about where
  the island is and nothing compared them.
- **A public unauthenticated model-backed surface:** route it through the abuse/cost throttle; normal
  public lookup is never artificially capped.
- **Anything whose exact BYTES are the contract** (a served file, a signature payload, a wire format):
  assert against the **build output** and the **deployed response**, never only the renderer. A unit
  test runs unminified source, where the construct that gets corrupted still exists — B-025 shipped a
  bare-LF vCard past a correct, passing CRLF assertion because the minifier rewrote the separator into
  raw source bytes that the JS parser then normalized. Two corollaries, both learned the hard way:
  **grep output is text about bytes, not the bytes** (dump the raw file to settle it), and a candidate
  cause is not a cause until the layer is **measured** — the response path and the proxy were both
  blamed here and both were innocent.

## This project's non-goals — do not add

- **Tenancy**, gleaning / volunteer / Farm Bucks-transaction machinery, native-app state, or
  multi-level roles. All are explicit non-goals at launch. Gleaning, volunteer coordination, and Farm
  Bucks are plausible *future* work; the architecture leaves room by staying small, never by
  pre-creating their tables, states, packages, or UI.
- **Arbitrary-origin SMS geocoding**, a runtime geocoder/map **package**, model-backed
  natural-language web inquiry, or generated recipe/food-safety content. Public proximity uses
  transient browser geolocation against seeded public coordinates; recipe requests receive grounded
  ingredient availability plus a code-rendered scope response.
  **One narrow exception** (max, 2026-08-05; **narrowed further 2026-08-06**):
  `apps/web/lib/address-lookup.ts` may call a geocoding REST endpoint during farm stand
  onboarding. It is the only permitted call site — `architecture.test.ts` fails on a second one.

  The exemption was originally justified by the lookup being a **draft the farmer confirmed by
  tapping the island map**, with every failure degrading to that tap. **F-077 removed the tap**,
  so that justification no longer holds and is replaced rather than quietly dropped: the typed
  address is now the **sole** source of a coordinate, and an address that will not resolve is
  **refused** — the farmer corrects the address, and a visitable stand cannot be published
  without one. What the exemption rests on now:

  - **Off-island results are refused, never shown**, against the single `ISLAND_BOUNDS`
    statement.
  - **No failure yields a coordinate.** No result, an unusable result, a provider error, a
    thrown request, an unset key: one answer, nothing placed. The module has no path that
    constructs a coordinate from anything but a provider number that passed the bounds check.
  - **The farmer can see the point before publishing.** The island map survives as a read-only
    display, so a geocoder putting a Vashon Highway address at the wrong end of the island is
    something a glance catches.

  **The cost of this narrowing, stated plainly:** a stand at the road rather than at the mailing
  address can no longer be nudged, and rural Vashon is where lookup is weakest. With no
  `GEOCODING_API_KEY` configured, **no visitable stand can be created at all** — the form says
  lookup is unavailable and points the farmer at VIGA.

  A `MapProvider` seam, a coordinate-inventing stub, and a mapping/geocoding **dependency**
  remain forbidden everywhere, that file included.
- **An import-provenance model.** This is a greenfield build; existing map content is
  **reference input** that gets **seeded**, with no non-destructive migration requirement.
- **Farm names, food vocabulary, produce taxonomy, or a fixed strategy catalog in behavioral
  branches.** Farms, foods, and listing details are **data**; the model supplies the understanding.
  Only fixed compliance and authority controls stay deterministic.

Farm names and question phrasings in these docs (e.g. "bok choy and green beans", "what is current at
Provo Farms?") illustrate mechanisms — the customer intent space is broad and ambiguous, so build the
general design and let a code-owned retrieval layer handle the variation.

## Gotchas peculiar to this codebase

The general verification lessons are in `~/.claude/CLAUDE.md` §Verification. These are the local ones,
with the guard that protects each.

- **`db:migrate` can skip a migration silently.** Drizzle applies only when `created_at <
  folderMillis` — equal counts as done, so a journal timestamp older than the newest applied one is
  skipped with a success message. Guard: `packages/core/src/migration-ordering.test.ts`.
- **`sharedDb` caches on first call and ignores the URL afterward.** A second `createAppContext` in
  one process cannot be pointed at another database, and `close()` on any context tears down the
  shared pool. Assemble the capabilities a pass needs instead of building a second context.
- **An unexported seam is an untested seam.** `createTelnyxTransport` was module-private, so the one
  path parsing a real provider error had no test and silently discarded it — everything above it used
  the never-failing simulator. Export the seam that does real I/O parsing and test it against captured
  payloads.
- **A worktree has no `node_modules` of its own**, so cross-package imports resolve into the main
  checkout until it is linked.
- **Source-text tripwires** live in `packages/core/src/architecture.test.ts`,
  `workspace-manifests.test.ts`, `kick-survival.test.ts`, and `public-surface-model-free.test.ts`.
  They assert against source because the property belongs to the platform or the install rather than
  to runtime behavior — which also makes them the easiest tests to write wrongly. Sabotage them
  whenever you change them.
  **A tripwire about a TABLE cannot use the same source stripper as one about a CALL.** `codeOnly`
  blanks template literals, which is right for a tripwire hunting a function call and fatal for one
  hunting a table name: every query here is a tagged template, so the name lives entirely inside
  backticks. F-078's raw-email tripwire ran `/\bfarm_emails\b/` over `codeOnly` output and
  therefore matched **no reader of the table at all** — including the two files its own allowlist
  named. It was green from the day it shipped, for a reason unrelated to the property it claimed,
  and the allowlist is what made it look verified. Use `codeAndSqlOnly` for SQL identifiers.
- **A sabotage aimed at the wrong tree is indistinguishable from a test that cannot fail.** A plan
  JSON carries the same resource twice — under `planned_values` and under `resource_changes` — and
  `plan-assertions.py` reads `planned_values`. Sabotaging the other one passes, which looks exactly
  like a vacuous check. When a sabotage does not fail, first confirm you edited what the assertion
  actually reads.
- **Every `mount_*` Terraform flag defaults to `false`, so an apply that omits one UNMOUNTS it.**
  `GEOCODING_API_KEY` was live on web revision 00034 and was stripped at 00035 by an apply that
  passed only `mount_smtp_password=true`; it stayed gone through 00038 while every apply reported
  success, and with F-077 in place production could not create a visitable stand for that whole
  window. **Always pass `-var-file=production.tfvars`.** Guard: a plan assertion fails when either
  service would unmount a secret that is currently live, and adding a mount flag means adding it to
  that file in the same change.
- **A Suspense boundary commits the HTTP status before the page body runs.** `app/loading.tsx` at
  the app root wrapped every route, so `notFound()` in a page rendered 404 markup under a **200**
  status — indexable, cacheable as success, and an oracle telling a prober the path exists. Only
  the real standalone server showed it; `next dev` and unit tests could not. Keep route-scoped
  fallbacks inside their own route group. Guard:
  `apps/web/lib/route-group-status.test.ts` asserts no root `loading.tsx`.
