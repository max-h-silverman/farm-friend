# Farm Friend — Pre-Ship Checklists

**How code gets written in general is not here** — test-first, choose the best option regardless of
effort, the zen-desk simplicity rules, verify by effect, sabotage every claim, honest reports all live
in `~/.claude/CLAUDE.md` and apply to every project. This document carries **only what is specific to
Farm Friend**: what each suite proves here, what to test before touching a given area, this project's
non-goals, and the gotchas peculiar to this codebase.

The Golden Rules are in [../CLAUDE.md](../CLAUDE.md). The checklists below are how you satisfy them.

## The suites, and what each one actually proves

- **Unit** — `npm test` (vitest). Keep pure core logic free of DB/SMS/LLM by injecting seams + `Clock`.
  Component tests (`@vitest-environment jsdom`) rely on `vitest.setup.ts` calling Testing Library's
  `cleanup` after each test. **This project runs without `globals: true`, so Testing Library cannot
  register that teardown itself** — without the setup file every mounted component stays in the
  document for the rest of the file, and `getByText` can be satisfied by an *earlier test's* render. A
  component test then passes while the behaviour it names is broken. Do not remove the setup file; a
  duplicate-match error is the only symptom that ever surfaces.
- **Integration** — `npm run test:integration` (vitest, Postgres). Runs migrations **from an empty
  database**, exercises complete use cases with real constraints and transactions, and proves the data
  invariants. Requires `DATABASE_URL`, creates and drops a uniquely named throwaway database, and fails
  explicitly when Postgres is unavailable.
- **Typecheck / lint** — `npm run typecheck` / `npm run lint`. The typecheck proves ordinary callers
  cannot bypass the static provenance barrier. It does **not** prove runtime content safety — `tsc`
  cannot inspect a runtime string.
- **Evals** — `npm run evals`. Required for any change touching a model seam. `critical` fixtures must
  pass **100%**; a provider/prompt change must pass the full suite at parity or better. Use **hostile**
  fixtures that attempt invention, not cooperative canned ones.
- **Evals against the real model** — `npm run evals:live` (needs `DEEPINFRA_MODEL`;
  `DEEPINFRA_API_KEY` from `.env`). Required for any change to a seam's projection, schema, or output
  contract — the scripted suite's stub reads neither your instructions nor your schema, so it cannot
  see an output contract that describes the wrong job. `live-containment` must be 100%; a failure
  **stops and reports**.
- **Variance across live runs** — `npx tsx evals/variance.ts <N>` runs `evals:live` N times, writing
  each transcript to its own file **before** parsing, then reports which fixtures ever missed. Reach
  for it before concluding the model is unstable from remembered runs: a fixture that PASSES can
  still be moving, so it reports score movement separately from pass/fail. `--summarise-only --out
  <dir>` re-reads an existing capture directory for free.

## Before you ship a change that touches…

- **Compliance / routing:** test first that keyword + confirmation tokens bypass the model; duplicate
  events are no-ops; concurrent ordinary stateful work is serialized per sender; stale events fail
  closed; an older START cannot undo a newer STOP; one open inventory confirmation is enforced; a token
  predating its current prompt cannot commit; confirmation rechecks farmer authority and VIGA approval,
  commits exactly once, and expires. `SAME` is exact and context-bound after `STOP` and ordinary
  `YES`/`NO`; it reaches no model and publishes only the complete snapshot bound to its active
  scheduled subject.
- **A model seam:** trace it in AI_ARCHITECTURE.md; keep durable writes/recipient/consent out of model
  output; run the **swap test**; run evals **and `npm run evals:live`**. Give the seam an entry in
  `SEAM_OUTPUT_SHAPES` (its examples are parsed through the real schema, so they cannot drift). **To
  add a seam or a program, or swap a provider, follow RUNBOOK.md "how to extend."**
- **An instruction (prompt) edit:** measure the FAMILY across repeated runs before and after, never one
  phrasing once. B-061 spent three edits each moving *which* phrasings passed while regressing others,
  because a single green run cannot tell a fix from a coin flip. The decisive test is cheap: write the
  failing phrase into the instruction verbatim and re-measure — if it still fails, the behavior is not
  reachable by prose and the lever is **code**. Hold instruction-immune properties in the harness, not
  the prompt; anything a customer must be able to rely on has to survive a model swap.
- **A failing or flaky live fixture:** print every raw verdict across ~15 runs before believing any
  theory about the cause. B-058 was filed as "the model returns wrong verdicts ~2 in 7"; the model
  was 100% consistent on the measured property, and the variable was our own seam discarding correct
  output three different ways over a field the model volunteered. A ticket's hypothesis about its own
  failure is a lead, never a finding. The tell that it is the harness and not the brain: the failure
  rate moves with something the instruction never mentions — here, a trailing proper noun.
- **A new query/list:** expose only deduplicated public catalog names to semantic interpretation;
  validate every selected name; expand it to all supporting records in code; label recency; carry
  stable identifiers only in code-owned paging; render factual text in code.
- **Anything privacy-relevant:** phones hashed, never logged raw, never in model context. The guarantee
  is **code, not the prompt** — task-specific projections make other actors' private data unavailable
  before the call, the outbound guard blocks raw phones after, and consequential / cross-actor replies
  are code-rendered. Add adversarial workflow proof that injection cannot extract unavailable data.
- **A NEW writer of a string that reaches the public map:** run it through `validatePublicStrings`
  and refuse the whole write, in the WRITER rather than at each door, so two doors cannot disagree
  and a third inherits the rule. Ask what renders the value, not who types it: a seller name looked
  like an identity field and is in fact credited on the stand's public card, so it shipped
  unguarded until F-114 Phase C.1 added a farmer-facing door onto it. Prove both directions —
  a contact detail refused, and an ordinary name (apostrophe, ampersand, number) admitted.
- **SMS ingress:** verify the Telnyx signature over the exact raw bytes, persist only the minimized
  unique inbox projection before acknowledgement, never retain the raw provider envelope, serialize
  stateful work per sender with Postgres row locks, and fail closed on stale events.
- **SMS delivery:** commit unique outbox work with business state; recheck consent at the atomic
  dispatch claim; suppress work when STOP commits first; do not claim recall after dispatch
  authorization; never automatically retry a possibly accepted ambiguous result. For a scheduled
  prompt, also recheck designated authority, approval, preference version/due slot, inventory and
  closure bases, active closure, and newer farmer activity under the shared lock order. Prove duplicate
  due-slot contention by queuing a claimant behind the winner's uncommitted unique-index entry.
- **The public map or feed:** it reads the **same published records** as SMS — web and SMS answers must
  agree. Render recency honestly. **Look at it in a browser before calling it done, at phone width and
  with the operating system in both light and dark appearance.** Farm Friend deliberately declares a
  light-only document, so both checks must retain the same readable light palette. Bytes prove markup
  and geometry and prove nothing about CSS: F-043 shipped five defects past 719 green tests and a
  rendered-bytes inspection, because a dark-mode block left the new artwork glowing on a black page and
  the map rendered taller than the phone screen. Also **compare any drawing to the data placed on it**:
  a hand-drawn coastline put 16 of 32 real farms in open water with every test passing, because the
  artwork and the projection were two independent statements about where the island is.
- **A public unauthenticated model-backed surface:** route it through the abuse/cost throttle; normal
  public lookup is never artificially capped.
- **Anything whose exact BYTES are the contract** (a served file, a signature payload, a wire format):
  assert against the **build output** and the **deployed response**, never only the renderer. A unit
  test runs unminified source, where the construct that gets corrupted still exists — B-025 shipped a
  bare-LF vCard past a correct, passing CRLF assertion because the minifier rewrote the separator into
  raw source bytes that the JS parser then normalized. Two corollaries: **grep output is text about
  bytes, not the bytes** (dump the raw file to settle it), and a candidate cause is not a cause until
  the layer is **measured**.

## This project's non-goals — do not add

- **Tenancy**, gleaning / volunteer / Farm Bucks-transaction machinery, native-app state, or
  multi-level roles. All are explicit non-goals at launch. Gleaning, volunteer coordination, and Farm
  Bucks are plausible *future* work; the architecture leaves room by staying small, never by
  pre-creating their tables, states, packages, or UI.
- **Arbitrary-origin SMS geocoding**, a runtime geocoder/map **package**, model-backed
  natural-language web inquiry, or generated recipe/food-safety content. Public proximity uses
  transient browser geolocation against seeded public coordinates; recipe requests receive grounded
  ingredient availability plus a code-rendered scope response.

  **One narrow exception:** `apps/web/lib/address-lookup.ts` may call a geocoding REST endpoint during
  farm stand onboarding, and it is the only permitted call site — `architecture.test.ts` fails on a
  second one. The typed address is the **sole** source of a coordinate and an unresolvable address is
  **refused**; with no `GEOCODING_API_KEY` configured **no stand can be created at all**, including a
  delivery-only farm (F-088). ARCHITECTURE.md §provider seams owns the full safety case. A
  `MapProvider` seam, a coordinate-inventing stub, and a mapping/geocoding **dependency** remain
  forbidden everywhere, that file included.
- **An import-provenance model.** This is a greenfield build; existing map content is **reference
  input** that gets **seeded**, with no non-destructive migration requirement.
- **Farm names, food vocabulary, produce taxonomy, or a fixed strategy catalog in behavioral branches.**
  Farms, foods, and listing details are **data**; the model supplies the understanding. Only fixed
  compliance and authority controls stay deterministic.

Farm names and question phrasings in these docs illustrate mechanisms — the customer intent space is
broad and ambiguous, so build the general design and let a code-owned retrieval layer handle the
variation.

## Gotchas peculiar to this codebase

The general verification lessons are in `~/.claude/CLAUDE.md` §Verification. These are the local ones,
with the guard that protects each.

- **`db:migrate` can skip a migration silently.** Drizzle applies only when `created_at <
  folderMillis` — equal counts as done, so a journal timestamp older than the newest applied one is
  skipped with a success message. Guard: `packages/core/src/migration-ordering.test.ts`.
- **One fact stated as BOTH config and constant drifts silently.** The public map URL lived in
  `PUBLIC_MAP_URL` (deployed config, answering `MAP`) *and* in a core constant customer copy embeds
  (the paged answer's `Map:` line). Nothing compared them, so changing one sent two different links
  to the same customer with every test still green — the old value resolved fine. Where a second
  home is deliberate, make disagreement fail at startup rather than documenting the pairing. Guard:
  `apps/web/lib/public-map-url.test.ts`.
- **A ceiling test whose fixture is the cheapest case measures nothing.**
  `result-page-segments.test.ts` asserted the SMS billing ceiling using offering-only stands — the
  shortest possible entry — so it passed both before and after F-107 doubled the worst case to four
  billed segments. A cost or size ceiling must be exercised with the most expensive shape the
  corpus actually produces, not the most convenient one to construct.
- **A reader whose only coverage is its EMPTY case has no coverage.** `listStandsForAdministration`
  returns each stand's `currentItems`, and the whole suite asserted that column exactly once — as
  `currentItems: []`, on a stand that had never published. A query returning nothing for every farm
  in the corpus would have passed, and both admin refresh surfaces (the farms page and
  `/api/admin/stands`) depended on it (B-074). An empty expectation is satisfied by a reader that is
  merely broken; assert a populated value, with the field values spelled out, before trusting a
  collection-returning reader. Guard:
  `packages/db/src/admin-roster-inventory.integration.test.ts`.
- **A test that asserts through the ADMIN reader proves nothing about what customers see.** F-100's
  load-bearing test claimed "every stand under a retired farm goes down" and checked it with
  `listStandsForAdministration` — the one reader that joined `farms.retired_at`. The map, both SMS
  retrieval queries, the public pickers and publication all filtered the *stand's* `retired_at`,
  which a farm take-down deliberately never writes, so a removed farm stayed live for every real
  customer while the suite, the doc sentence in DATA_RECORDS.md, and the operator's own screen all
  agreed it was gone (B-066). When a state change is supposed to reach several surfaces, assert it
  on the surfaces a **user** touches; the admin screen is the one most likely to read the column you
  just wrote and least likely to catch the ones that don't. Guard: the farm-removal cases in
  `apps/web/lib/public-surface.integration.test.ts` and
  `packages/db/src/stand-retirement.integration.test.ts`.
- **A test can encode the bug it looks like it guards.** `paging.test.ts` asserted that one matching
  row licensed a heading for every stand beneath it, with a rationale that reads plausibly and
  inverts the logic (B-061). When a defect contradicts a green test, read that test's *claim* before
  trusting it — and when a rendering literal appears in an assertion, check that the guarantee, not
  the wording, is what is being protected. Two suites in one session held a stale literal while
  claiming to protect a live property.
- **`sharedDb` caches on first call and ignores the URL afterward.** A second `createAppContext` in one
  process cannot be pointed at another database, and `close()` on any context tears down the shared
  pool. Assemble the capabilities a pass needs instead of building a second context.
- **An unexported seam is an untested seam.** `createTelnyxTransport` was module-private, so the one
  path parsing a real provider error had no test and silently discarded it — everything above it used
  the never-failing simulator. Export the seam that does real I/O parsing and test it against captured
  payloads.
- **A worktree has no `node_modules` of its own**, so cross-package imports resolve into the main
  checkout until it is linked.
- **Source-text tripwires** live in `packages/core/src/architecture.test.ts`,
  `workspace-manifests.test.ts`, `kick-survival.test.ts`, and `public-surface-model-free.test.ts`. They
  assert against source because the property belongs to the platform or the install rather than to
  runtime behavior — which also makes them the easiest tests to write wrongly. Sabotage them whenever
  you change them.

  **A tripwire about a TABLE cannot use the same source stripper as one about a CALL.** `codeOnly`
  blanks template literals, which is right for a tripwire hunting a function call and fatal for one
  hunting a table name: every query here is a tagged template, so the name lives entirely inside
  backticks. F-078's raw-email tripwire ran `/\bfarm_emails\b/` over `codeOnly` output and therefore
  matched **no reader of the table at all** — including the two files its own allowlist named. It was
  green from the day it shipped, and the allowlist is what made it look verified. Use `codeAndSqlOnly`
  for SQL identifiers.
- **Composing shared SQL text into a tagged template sends it as a bind PARAMETER.** A query written
  `` driver(db)`… ${fragment} …` `` passes the fragment as a *value*, not as SQL, and dies at parse
  with `syntax error at or near "$1"`. Any statement composing `visibleFarms`,
  `PROVIDER_AUTHORITY_ARMS`, `currentEntriesJoin`, or F-115's `publicProviders` /
  `reachableProviders` must use `.unsafe(…)` — which is why `listClaimableFarms`,
  `listStandsForAdministration` and `listFarmerAuthorizations` are written that way. Typecheck cannot see
  it and neither can any test that does not run the statement against a real database, so a
  fragment-composing query needs integration coverage on the day it is written.
- **A sabotage aimed at the wrong tree is indistinguishable from a test that cannot fail.** A plan JSON
  carries the same resource twice — under `planned_values` and under `resource_changes` — and
  `plan-assertions.py` reads `planned_values`. When a sabotage does not fail, first confirm you edited
  what the assertion actually reads.
- **Every `mount_*` Terraform flag defaults to `false`, so an apply that omits one UNMOUNTS it.**
  `GEOCODING_API_KEY` was stripped from web by an apply that passed only `mount_smtp_password=true` and
  stayed gone for four revisions while every apply reported success — and with F-077 in place
  production could not create a visitable stand for that whole window. **Always pass
  `-var-file=production.tfvars`.** Guard: a plan assertion fails when either service would unmount a
  secret that is currently live, and adding a mount flag means adding it to that file in the same
  change.
- **A Suspense boundary commits the HTTP status before the page body runs.** `app/loading.tsx` at the
  app root wrapped every route, so `notFound()` in a page rendered 404 markup under a **200** status —
  indexable, cacheable as success, and an oracle telling a prober the path exists. Only the real
  standalone server showed it; `next dev` and unit tests could not. Keep route-scoped fallbacks inside
  their own route group. Guard: `apps/web/lib/route-group-status.test.ts` asserts no root `loading.tsx`.


- **Vitest's tail names the wrong file, and a rename defect hides in `select`/read mismatch.** A
  scheduled-prompt failure was diagnosed from the last stack in the output; the real site was named
  by the FIRST failure, 45 lines earlier, with its bind parameters. Capture the whole run to a file
  and read failure `[1/N]`, never the tail. The defect itself: the query `select`s `own_seller_id`
  and the code read `.owner_seller_id`, so nothing errors until the undefined reaches a bind
  parameter, far from the mismatch. Grep for every `.owner_*` read after any column rename.
- **An INNER join on a NULLABLE pointer is a silent WHERE clause.** The map reader and both SMS
  retrieval queries each carried `join sellers f on f.id = l.own_seller_id` purely to label the
  row and to carry the stand-owner visibility rule. `own_seller_id` is NULL for a venue — a place
  several farmers sell at and nobody's farm, which is the shape the self-pointer exists to
  represent — so all three surfaces deleted every venue from the customer's view, with no error
  and every test green (no fixture had one). LEFT plus a `coalesce` for the label is the fix, and
  `visibleFarms` still bites across it because `NULL is null` is TRUE. **When a join column is
  nullable, ask what the INNER join is silently filtering out, and put that row in a fixture.**
  Guard: `apps/web/lib/per-seller-freshness-differential.integration.test.ts`.
- **Two readers of one fact must be compared on OUTPUT, not read side by side.** Both audits
  confirmed SMS retrieval duplicates `readStandProviderFacts` and neither could say whether they
  agreed. Reducing both to `provider id → {name, date, items}` and diffing them across the ragged
  cases — a confirmed-EMPTY stand, a 40-day-old publication, standing-claims-only, a venue —
  settled it in one test, and found three defects reading the source had not. The parity test that
  existed compared them only on the case they agree on by construction.
- **A historical migration test must select its predecessors BY ORDER, never by exclusion.** The
  *"every file that is not mine"* form is correct only while that migration is the newest in the
  repo, and every future migration breaks it the same way. Use `name < "00NN_"`. The failure is loud
  but names the wrong file, so it reads as a defect in the new migration rather than the old test.
- **A hand-written migration leaves the generator's snapshot stale, and nothing notices until the
  next one.** Applying stays correct throughout — only generation breaks, which is why
  `migration-metadata.test.ts` (GL-006) checks the newest snapshot.

  **Repair it as a measured DELTA of its predecessor, not by introspection.** Copy the previous
  snapshot, apply exactly the constraints/columns your migration changed, set a fresh `id` and
  chain `prevId` to the predecessor's `id`. F-114 C.3 measured both ways and they are not
  equivalent: **`generate` on the merged base said "No schema changes"**, the introspected `0047`
  snapshot made it emit **16KB** of constraint churn, and the delta-edited `0047` snapshot returned
  it to "No schema changes". The churn is real — introspected constraint names differ from
  `schema.ts` names across the schema — so introspection *adds* drift on a repo that currently has
  none. (The earlier C.1 guidance to introspect was written when the snapshot was already drifted;
  it repairs a broken snapshot but degrades a healthy one.)

  **Always probe the baseline before believing either result.** Run `drizzle-kit generate --name
  probe_x` on your commit and again on the merged base, compare, then delete both probe files and
  restore `_journal.json` — `generate` appends a journal entry as a side effect and will silently
  drop the entry your own migration needs.
- **A historical migration test written in the CURRENT vocabulary proves nothing.** A rename sweep
  will drag a fixture forward and prove the migration against its own output rather than against the
  corpus it has to survive. A fixture's vocabulary must match the schema it populates.
- **A schema rename passes typecheck and breaks every raw SQL string.** Drizzle infers column types
  from `schema.ts`, so identifier renames propagate invisibly; raw SQL is just text. After any
  rename, grep the old names — never trust the compiler.
- **A populated-schema migration test catches defects an empty one passes**: composite keys created
  before their unique target, keys rooted on a dropped column, triggers depending on it, constraints
  left asserting old names, and backfill joins matching a removed slot.
- **`ALTER TABLE … RENAME` has no `IF EXISTS` form**, so an unguarded rename makes a migration
  non-idempotent and the integration suite applies every file twice. Wrap each in a
  `to_regclass`/`information_schema` guard. Related: a `UNIQUE` constraint's backing index raises
  `duplicate_table`, not `duplicate_object`, so the usual handler lets the error through.
- **Sabotage a guard against the state it actually forbids — and check the sabotage itself worked.**
  One attempt "passed" only because the *other* trigger had already rolled back the setup statement,
  so nothing was tested. Another appeared to collapse a whole suite when the edit had simply emitted
  malformed SQL. Read the row back, and read the error, before believing a negative result.
- **A guard that cannot be falsified is not a guard — but find out WHICH of the two it is.** When a
  sabotage changes no test result, some other guard answered first. Sometimes that means the guard
  is a genuine duplicate: sabotaging a route's shape check changed nothing because the writer
  beneath refused the same input with the same status, so it was deleted and proved where it lives.
  Just as often the guard is real and the *case* is wrong, because it never constructs the one
  situation where that guard is the only thing that could refuse. F-114 C.2 hit five of those in a
  row: an authority preference with no case holding both arms at once; a stand/provider agreement
  check probed with an actor already refused earlier for an unrelated reason; a closure insert and a
  re-authorization that both needed a **mixed** proposal, the only shape where two authorities
  differ (at a venue both are `(null, null)`; at a single-seller stand they are the same row); and
  an arm trigger that needed an UPDATE *swapping* the arm, since a valid supersede passes whether
  or not the trigger watches updates. **Ask which other guard answered before concluding the guard
  is redundant.**
- **`NOT VALID` on a FOREIGN KEY still refuses new rows.** It skips only the scan of rows already
  there — so the obvious probe, inserting a violator and requiring the refusal, passes either way
  and proves nothing. A deliberate `NOT VALID` sabotage sailed straight through one. Assert
  `pg_constraint.convalidated`, which is the fact that actually differs, and assert it against a
  **populated** schema, because unvalidated rows are the only thing at risk.
- **Assert the ABSENCE of the wrong behavior, not only the presence of the right one.** "Invite
  posts exactly one request" says nothing about what *Save* does, so a `save()` that also invited
  survived sabotage untouched. Whenever an act is deliberately kept out of a shared commit path,
  the test that proves it is the one pointed at the OTHER path. Reach the real entry point too:
  here the escape lived behind F-098's `registerSave`, where the panel renders no button and the
  parent's press calls `save` directly — so the disabled state that protects the standalone page is
  not in the way, and only a test that goes through `DetailsPanel` can see it.
- **A CHECK is not automatically a biconditional.** The standing reason for one is that a CHECK
  passes on NULL and both directions are real failures — but where only one direction is a failure,
  the biconditional makes a legitimate row unwritable. `farmer_invitations_hosting_names_seller` is
  deliberately one-directional; written as a biconditional it makes the self-issued onboarding door
  impossible.
- **The schema vocabulary forbids certain words outright**, `provenance` among them
  (`schema.integration.test.ts` §removes forbidden concepts). It scans schema text, the index file,
  `0000`, and the snapshot — so a constraint NAME or even a doc comment trips it.
- **A tagged template turns an interpolation into a bind PARAMETER.** Composing shared SQL text into
  a `` driver(db)`…` `` query sends the clause as a string value and dies at parse
  (`syntax error at or near "$1"`). Any query composing a shared fragment must use `.unsafe(…)`.
  Invisible to typecheck and to every test not run against a real database.
- **An assertion on an empty collection can be green whatever the code returns.** When a reader's
  only coverage is its empty case, it has no coverage; assert a populated value.
- **One emoji doubles a message's cost.** A single non-GSM-7 character re-encodes the WHOLE body to
  UCS-2, dropping per-segment capacity from 153 to 67. An encoding effect, not a length effect, and
  invisible by inspection. `reply-encoding.test.ts` sweeps every code-owned reply; measure with
  `estimateSmsSegments` before adding any decoration.
- **`npm run test:integration` needs `DATABASE_URL` exported** or every file fails instantly with no
  tests run — the suite failing loudly by design. RUNBOOK §top has the two export lines.
- **A domain mapping reports `Ready: True` before TLS serves** — ~6 minutes ahead on F-113, and a
  request in that window fails certificate verification; inside an iframe that is a silent blank.
  Poll the real request for a 200; never cut an embed over on the mapping's status.
- **Every plan shows two spurious `scaling` updates** (B-073) — a provider artifact, not the
  container template. Real diffs still have to be read; do not learn to skim "2 to change".
- **A stale local server can serve headers the config no longer describes.** Restart before believing
  either the config or the wire.
- **`drizzle-kit generate` writes a migration that passes on an empty database and fails on a real
  one.** It emits `ADD COLUMN … NOT NULL` with no default and no backfill; against any table already
  holding a row that is an instant 23502. Add the column nullable, backfill, then `SET NOT NULL`.
- **`inventory_revisions` has a trigger that refuses almost every UPDATE.**
  `guard_inventory_revision_history` permits exactly one transition — superseding a current revision
  — so a backfill cannot touch the table at all. Disable it for one statement, re-enable it
  immediately, and widen it to cover any new column. Do not weaken it; it is a Golden Rule #1
  protection.
- **SQL NULL semantics silently invert guards.** A CHECK constraint *passes* on NULL.
  `array_length` of an empty array returns NULL, not 0 — use `coalesce`. Postgres sorts NULLs FIRST
  under `order by … desc`. In JS, `Number(null)` is `0`.
- **A JSON snapshot can hold DUPLICATE keys, and every parser silently keeps the last.** `0042`'s
  snapshot carried two `public.sellers` blocks — the correct renamed table, and Phase B's deleted
  one still referencing `farms` — so drizzle read the dead table. It was invisible because the
  later snapshots were built as text deltas from the correct block. Two consequences: check for
  duplicates before trusting a snapshot (`object_pairs_hook` in Python will report them), and
  **never repair a snapshot by round-tripping it through a JSON parser** — that silently drops the
  duplicate and, in the first attempt here, 209 unrelated lines with it. Edit snapshots as TEXT and
  read the diff before believing it.
- **A `truncate … cascade` reaches further than the tables you name.** A scheduler suite truncated
  `inventory_publication_proposals` between cases and thereby deleted every `inventory_revisions`
  row, because revisions key to their proposal. Each case then ran against a stand with no current
  inventory — and still queued prompts, because `offers_same: false` with a null base is exactly
  what an unpublished stand legitimately produces. Every structural assertion passed; only the
  asserted BODY caught it. Rebuild what a cascade removes, and assert a VALUE that could only come
  from the fixture.
- **A refusal case must name the constraint it means to prove.** A row written without
  `next_due_at` is refused by `inventory_prompt_preferences_due_state_coherent` — a CHECK,
  evaluated before any foreign key — so a case probing a foreign key that way passes with or
  without the migration under test. Assert `constraint_name`, not merely that it rejected.
- **An UPDATE matching NO rows resolves rather than rejecting.** A constraint case that writes a
  bad value with a `where` clause matching nothing passes whether or not the constraint exists.
  Create the row first.
- **A backtick inside a SQL template literal closes the string.** Every raw query here is a
  tagged/`unsafe` template, and the house comment style reaches for backticks to quote an
  identifier — inside one, that ends the string and the rest of the query becomes JavaScript.
  Typecheck catches it every time and names a *column* (`Expected ")" but found "is_public"`),
  far from the comment that caused it, so each one costs a hunt. F-114 C.5 hit it five times
  across three files. Guard: `packages/core/src/sql-template-safety.test.ts`, which proves its
  own scanner in both directions before trusting a clean sweep.
- **A `Write` can emit a stray NUL byte, and nothing downstream complains.** F-114 C.5 shipped
  one into a template literal where a space belonged; JS parsed it, tests passed, and only an
  `od -c` of the line showed it. Sweep changed files for `\x00` before believing a green run —
  `perl -ne '$n++ while /\x00/g; END{print $n}'` over `git status --porcelain` output.
- **A first-insert race is arbitrated by a unique index, never by a preceding read.**
  `select … for update` cannot serialize a row that does not exist yet, so both writers observe
  "none" and the second raises. Use `insert … on conflict do nothing returning …` and trust only
  `RETURNING` as proof of winning.
