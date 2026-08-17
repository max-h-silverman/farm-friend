# De-Vibe Remediation — work order

> **For an agent starting cold.** This plan is self-contained: it carries its own orientation, the
> evidence behind every item, the decisions already made, and a verification contract per tranche.
> Work it top to bottom. Nothing here requires the session that produced it.
>
> **Source:** two independent architectural audits of `main` at `3abe2fc`, run cold against the same
> tree and cross-verified by hand. **Status:** nothing implemented yet. Every finding below was
> re-confirmed against source; none is a lead to re-derive.

## Before you start

1. **Orient** — `CLAUDE.md`, then `docs/CURRENT_STATE.md`. Do **not** load `SESSION_LOG.md` or
   `docs/archive/`.
2. **Read the discipline for what you touch** — `docs/DEVELOPMENT.md` §before you ship a change
   that touches… and §gotchas peculiar to this codebase. The gotchas are mandatory before touching
   migrations, constraints, tests, or SMS copy.
3. **Claim the work** — `/pm status <ID> in progress`, branch off `main`, never work on `main`.
   These tranches have no PM items yet; file them with `/pm` as you take each one.
4. **Baseline before editing.** Confirm green, so a failure you see later is yours:

   ```
   npm run typecheck                 # clean
   npm test                          # 2152 passed, 7 skipped
   npm run test:integration:local    # 1347 passed across 96 files (needs local Postgres)
   ```

   `npm run test:integration` (non-local) additionally needs `PUBLIC_BASE_URL` exported or eight
   `farmer-stand` cases fail on configuration — an environment fact, not a regression.

**Nothing in this plan is deployed.** All of F-114 is on `main` and undeployed, and migrations
`0042`–`0050` are unapplied to production. Every defect below is therefore latent, not live — which
is why fixing them now is free.

---

## The one root cause

Every P1/P2 finding is the same mistake in a different place:

> **F-114 built the right owners and left the old call sites in place.**

Each phase introduced a correct seam — `readStandProviderFacts`, `creditSeller`,
`resolveProviderWriteAuthority`, `preference.owner_seller_id` — and converted the callers it was
looking at. Callers outside that set kept deriving the answer the old way, through
`sales_locations.own_seller_id`.

**That old derivation is right for 31 of 38 stands** — every stand whose seller *is* the stand. It is
wrong only for hosted sellers, which is the entire point of F-114. So nothing fails in testing, in
the corpus, or in review.

When you fix one of these, **delete the old derivation rather than widening it.** The composite FKs
added in `0042`–`0049` already guarantee the coherence the old comparisons were re-deriving.

---

## Decisions already made — do not relitigate

| Decision | Made by | Consequence |
|---|---|---|
| Provider pause/end **is in scope** before go-live | max, 2026-08-16 | `provider-invalidation.ts`, `0050`, and the `paused` state all stay. Build the missing writer. |
| **PAUSE: seller or VIGA. END: seller, host, or VIGA.** | max, 2026-08-16 | Confirms the existing contract; no doc changes owed. |

**The pause/end split was raised and re-confirmed, not assumed.** Max initially specified the inverse
(host may pause, only seller may end); on being shown the contract he kept the contract. Build what
is written below.

**The rule, and where it already lives.** `farmer-behavior-architecture-plan.md:316` — *"Either side
may end it; the seller may pause/resume without ending it."* And `schema.ts:1791` names pause
explicitly among what a host may **not** do: *"A host may never change a hosted seller's identity,
prices, payment, pause, or participation."*

**Why this way round.** A host who could pause could hide a seller's goods from the public
indefinitely without ever ending anything — eviction by another name, with no visible act. Ending is
visible and final, so either party may walk away. The graver power is *hiding*, not *terminating*.

**Consequence for the build:** the host arm never reaches the pause path, so the `host_may_update_stock`
question that was open here dissolves — that opt-in governs stock only, exactly as its doc says.

---

## Tranche A — the dispatch validator [P1, correctness]

**The defect.** `lockScheduledDispatchBasis` validates a scheduled prompt against the *stand's*
seller, not the prompt's:

- `packages/db/src/transactions.ts:1690` — `where seller_id = ${location[0]?.own_seller_id}`
- `packages/db/src/transactions.ts:1750` — `location[0]?.own_seller_id === subject.owner_seller_id`

**Effect.** For a hosted seller `valid` is false, so `transactions.ts:1789-1800` marks the proposal
`invalidated` and the outbox row `suppressed`. She is never texted and her open proposal is
destroyed — no error, no log. Venues (`own_seller_id` NULL) fail the same way and earlier: the
approval lookup returns zero rows.

**The same bug was already fixed at the other end.** `apps/web/lib/scheduled-prompts.ts:118-129`
reads `preference.owner_seller_id` and its comment names this exact failure: *"They read
`sales_locations.own_seller_id` before, which is Kelsey for every listing at Kelsey's stand — so
Zoe's designated authorization … failed the first check."* Enqueue was converted; dispatch was not.

**Why no test caught it.** Every fixture in `scheduled-prompts.integration.test.ts` and
`packages/db/src/scheduled-prompts.integration.test.ts` builds providers with
`seller_id = (select own_seller_id from sales_locations …)` — hard-binding the passing case. The C.4
hosted suite (`apps/web/lib/hosted-scheduled-prompts.integration.test.ts`, 453 lines, 7 cases) stops
at `runScheduledPromptPass`; `grep -c authorizeDispatch` returns **0**.

**Do this.**
1. Write the failing test first: extend the hosted C.4 fixture through `authorizeDispatch`. Confirm
   it fails against today's code before changing anything.
2. `transactions.ts:1690` — read `subject.owner_seller_id`.
3. `transactions.ts:1750` — **delete** the `location[0]?.own_seller_id === subject.owner_seller_id`
   arm. Do not widen it. The composite FK on `scheduled_inventory_prompt_subjects`
   (`schema.ts:3715`) already guarantees `(provider_id, owner_seller_id)` is coherent, so re-deriving
   proves nothing.

**Verify.** Hosted seller's prompt dispatches; venue's prompt dispatches; own-seller case unchanged.
Sabotage: revert each of the two edits separately and confirm a named case fails for each.

---

## Tranche B — two surfaces still asking the old question [P2, one customer-visible]

**B1 — a hosted seller's stock update is misfiled.** `apps/web/lib/free-text.ts:321-336` —
`standBelongsToSender` joins `farmer_authorizations a on a.seller_id = l.own_seller_id`. Its caller
(`free-text.ts:884`) routes on that boolean: `ownsIt ? handleFarmerInventoryUpdate :
handleCustomerStockOut`.

So a hosted seller texting about the stand she sells at fails the check and her own inventory update
is processed as a **customer stock-out report about herself**. Fail-safe in the Golden Rule #1 sense
— it can only move a farmer away from publishing, never toward publishing someone else's goods — so
this is a lost update, not a leak. It is still her primary SMS journey silently not working.

**Fix:** delete `standBelongsToSender`; call `resolveProviderWriteAuthority` (or
`resolveStandWriteAuthority` for a venue), which already owns this question and reports which arm
granted. Adds no concept.

**B2 — VIGA can't see a hosted seller's stands.** `packages/db/src/farmer.ts:1854-1867` —
`listFarmerAuthorizations` builds each farmer's stand list from `location.own_seller_id =
auth.seller_id`, so a hosted seller appears in the Farmers queue with an empty stand list.
`farmer.ts:1865-1867` also compares two stored copies of the same fact against each other, which is
the same anti-pattern as Tranche A.

**Fix:** read `stand_providers` for the authorization's seller.

**The rule both violate is already written down** at `provider-write-authority.ts:19-23`: *"every one
of them asked it the same wrong way … That is correct for 31 of 38 stands and wrong for every
hosting relationship."*

**Verify.** Add the hosted-seller case to the inventory-report tests and to the authorization-listing
tests. Sabotage each fix independently.

---

## Tranche C — the seller-credit rule has an owner with no callers [P2]

`packages/core/src/public/seller-credit.ts:44` — **`creditSeller` has no production caller.** Only
`seller-credit.test.ts` calls it, including a case asserting the `" - "` SMS separator (`:81`) that
the parameter exists for.

Five sites decide it independently instead:

| Site | Separator |
|---|---|
| `apps/web/lib/farmer-targeting.ts:56` (SMS menu) | `" - "` |
| `apps/web/lib/farmer-settings.ts:56` | — |
| `apps/web/lib/seller-list.ts:74` | — |
| `apps/web/app/stand/[token]/reminder-schedules.tsx:27` | `" — "` |
| `apps/web/app/stand/[token]/settings/settings-form.tsx:25` | `" — "` |

The last two are **character-identical** `listingLabel` functions. No test asserts any two agree.
`sellerCredit` (the `undefined`-returning half) *is* used by `stand-card.ts`, so the rule has two live
implementations that can drift.

Three comments assert ownership that does not exist — `settings-form.tsx:22` says *"so one listing
cannot be labelled three ways"* while being the third copy. Delete those claims along with the code.

**Do this.** Route all five through `creditSeller`, passing their own separator. **Keep the separator
difference** — SMS is GSM-7 and an em-dash re-encodes the whole body to UCS-2, halving capacity
(`seller-credit.ts:39-42`). Delete both `listingLabel` copies. Add a cross-surface test: SMS menu
label == card label for the same listing.

**Verify.** `npm test`, plus `reply-encoding.test.ts` to confirm SMS copy is still GSM-7.

---

## Tranche D — build the pause/end writer [P2, feature work]

**The gap.** No production statement anywhere sets `lifecycle_state = 'paused'` or `ended_at`. The
only writes are `pending → active` (`farmer.ts:1484`, `transactions.ts:1503`); `hosting.ts:208`
inserts `pending`. Confirmed unreachable from data too: `0042`'s backfill and its
`create_own_seller_provider` trigger both insert `'active'` only
(`0042_seller_root.sql:544,564`), so **no production row can already be in this state.**

Built on top of a state nothing can enter: `packages/db/src/provider-invalidation.ts`
(`invalidateProviderWork`, 122 lines, fully tested, **zero production callers**), the C.4 re-opening
flow (`transactions.ts:1414-1435`), and `reopening_stated_version` (migration `0050`).

**This is a trigger and a surface, not a new mechanism.** `invalidateProviderWork` is the consequence
for both pause and end.

**The authority split.** `resolveProviderWriteAuthority` already returns `via: "seller" | "host"`
(`provider-write-authority.ts:271-286`), which is the distinction the rule needs:

- **Pause / resume** — `via: "seller"` only, plus VIGA via admin. The host arm must **not** reach it.
- **End** — either arm, plus VIGA via admin. Either side may walk away.

Note `host_may_update_stock` governs **stock only** (`schema.ts:1776-1795`) and is irrelevant to
both paths. Do not consult it here.

**Open question D2 — can a seller who ended a relationship be re-invited to the same stand?** Decides
whether `ended_at` is terminal for the pair or closes one episode. `hosting.ts:208` inserts a
`pending` row so re-invitation likely works, but the partial unique index and `ON CONFLICT` behaviour
against an ended row must be checked rather than assumed. **If it does not work, stop and ask** —
making `ended_at` terminal is a product decision, not a fix to improvise.

**Verify — each property separately, each sabotage-proved.**
1. A paused provider leaves every surface the liveness predicates guard.
2. **A host cannot reach the pause path** — with and without `host_may_update_stock`, since neither
   grants it. This is the contract's core protection.
3. A host **can** end, and so can the seller.
4. A paused seller's own confirmation reply yields the re-open prompt rather than a silent publish or
   a bare refusal, and `NO` leaves the listing paused
   (`farmer-behavior-architecture-plan.md:300-302`).
5. Pausing invalidates that provider's open confirmations — and **only** that provider's: an
   unrelated seller at the same stand is untouched (`plan:887`).

Confirm any new farmer-facing copy is GSM-7, and that the paused state reaches the SMS surfaces
(`farmer-targeting.ts:112` already projects it).

---

## Tranche E — collapse the liveness predicate [P2]

`provider.ended_at is null and lifecycle_state in ('active','paused')` appears verbatim at:
`scheduled-prompts.ts:161`, `inquiry.ts:327`, `inquiry.ts:431`, `stand-provider-facts.ts:175`,
`current-inventory.ts:266`, `farmer.ts:734`, `farmer.ts:2199`, `public-sellers.ts:95`,
`provider-write-authority.ts:134`, `schema.ts:1924`.

**This codebase already has the idiom and says why.** `visibleFarms` (`test-farms.ts`) — *"four copies
is four chances to miss one"* — citing two prior incidents (F-072's `NO_LIVE_FARMER`, F-074).
`PROVIDER_AUTHORITY_ARMS` proves the fragment is extractable.

**Do this after Tranche D**, so the fragment is written against a state that is actually reachable.
One exported fragment beside `visibleFarms`, composed by all ten sites, absorbing
`PROVIDER_AUTHORITY_ARMS`. Keep `paused` in the state set.

**Verify.** The copies-agree integration test `visibleFarms` already has a model for — and sabotage
it: break one composed site and confirm the test fails. A test that cannot fail proves nothing.

---

## Tranche F — delete the fossils [P2/P3]

**F1 — `currentInventoryJoin`.** `packages/db/src/current-inventory.ts:66-74` still joins on
`sales_location_id` alone — the provider-blind key C.5 exists to eliminate. **No production callers**;
referenced only by three cases in `current-inventory.integration.test.ts`. Its last caller was removed
deliberately (`admin.ts:964-975`: *"a two-seller stand appeared in the operator's roster TWICE, each
row carrying only half the inventory"*). It is exported from `@farm-friend/db` and reads as the
sanctioned way to ask "what is current here" — the next caller reintroduces the exact defect C.5
removed. Delete it and its three tests; correct the module header, which still claims it serves "the
three corpus-wide surfaces" (false for all three).

**F2 — stale threshold comments.** `STALE_AFTER_HOURS = 96` (`answer.ts:74`), but `answer.ts:128` and
`:193` still say "48 hours". The 2026-08-11 change updated two of four prose statements, in the file
owning product-visible freshness. Name the constant instead of restating its value.

---

## Tranche G — P3 hygiene, lowest priority

**G1 — a produce taxonomy in a behavioral branch.** `apps/web/lib/map-view.ts:196-206` —
`isFlowerOnlyStand` regex-matches `flower|lavender|wreath|essential oil` against item names, driving
the pin glyph (`:184`) and the "Flowers only" filter (`:784`). This is the one place `CLAUDE.md`'s
*"no produce taxonomy as policy"* rule is broken with no recorded exception. A lavender farm that
starts selling honey silently loses its glyph and drops out of the filter. Make it data VIGA can set,
or record the exception explicitly beside the regex and in `CURRENT_STATE.md`.

**G2 — source-text tripwires coupled to formatting.** 232 `toMatch` assertions over `readFileSync`
across 33 files. `architecture.test.ts:186` breaks on an added inline comment. The repo has been
burned by this class before — `architecture.test.ts:96-108` documents an F-078 tripwire that could not
fail for its entire life. **Keep** the ones asserting what no runtime test can: dependency direction,
module absence, migration ordering, "no model import on this surface". **Replace** call-site shape
assertions with behavioural tests through the real interface. **Do not reduce coverage.**

**G3 — the `paused` name collision.** `stand_providers.lifecycle_state = 'paused'` (relationship
suspended) and `inventory_prompt_preferences.cadence = 'paused'` (reminders off) are unrelated
concepts read in the same files. Both are live once Tranche D lands. Consider renaming the cadence
value to `off`. One migration, no behaviour change — but it is a migration, so weigh it against the
`0042`–`0050` queue.

---

## Doc corrections owed

`CURRENT_STATE.md` carries three claims the code does not support. **Correct each as its tranche
lands**, not before — they describe the intended end state accurately:

- *"every public and SMS surface reads PER SELLER from one seam (`readStandProviderFacts`)"* — only
  `public-listing.ts` does; `inquiry.ts` builds its own per-seller SQL (`:327`, `:431`). See
  Unverified below.
- *"`sellerCredit`/`creditSeller` state it once for the public cards, the SMS menu and the settings
  screens"* — Tranche C.
- *"`provider-invalidation.ts` is the pause/revoke/close mechanism"* — Tranche D.

Run `/session-wrap` before clearing context.

---

## Unverified — RESOLVED (2026-08-17)

**`inquiry.ts` may duplicate `readStandProviderFacts`.** Both audits confirmed `inquiry.ts:327,431`
builds its own per-seller SQL rather than calling the seam, but **neither verified whether the two
produce identical per-seller freshness.**

**Measured** by `apps/web/lib/per-seller-freshness-differential.integration.test.ts`, which reduces
both readers to `provider id → {seller name, published_at, confirmed items, usual items}` and
compares them across the ragged cases the C.5 parity test cannot reach: a seller who confirmed an
EMPTY stand, a 40-day-old publication, a standing-claims-only seller, a seller with both registers,
and a VENUE.

**The duplication is a NON-FINDING; the queries were not.** Freshness agrees exactly — every
seller's date, and which items belong to whom — and the two readers keep their separate shapes for
the reason the STRONG list gives. Three real defects surfaced, all the same root cause as the rest
of F-115 and all in the same line:

1. **A VENUE was invisible on every customer surface.** `join sellers f on f.id = l.own_seller_id`
   is INNER in the map reader and in BOTH SMS queries, so a stand with a NULL self-pointer was
   dropped from all three. Now LEFT; the visibility rule the alias carries still bites, proved by
   retiring the host and watching the stand leave both channels.
2. **A hosted seller's confirmed SMS row carried the HOST's name.** It read the stand's own seller
   rather than the row's own provider. Unrendered today — one renderer away from telling a customer
   the wrong farm has the thing they asked for.
3. **The offerings half needed the same fix independently**, being a second query with its own copy.

One deliberate difference stands, stated in the test rather than asserted away: a seller who
confirmed an empty stand is a dated fact on the card and absent from SMS, per that query's own
documented rule.

---

## Not inspected by either audit

Listed so a later agent knows where coverage ends rather than assuming it was clean: the onboarding
React surface (`listing-step.tsx`, 2,507 lines), the map client (`stand-map.tsx`, 1,543 lines), the
~40 non-F-114 tables in `schema.ts`, `onboarding-listing.ts`, the `evals/` harness (not run — it bills
VIGA's model account), `infra/` Terraform, and the email ingestion path.

---

## What both audits rated STRONG — do not "clean up"

One composition root, one ordered SMS dispatcher, clear package boundaries, invariants enforced
structurally. Specifically leave alone:

- **`routing.ts`'s callback seams** — what makes "no model call on the compliance path" structural.
- **Three separate statements in `readStandProviderFacts`** — documented cross-product avoidance.
- **`PROVIDER_AUTHORITY_ARMS` duplicated in prose by `resolveProviderWriteAuthority`** — deliberate,
  with a real agreement test (`per-provider-targeting.integration.test.ts:487-546`).
- **`resolvePublicMapUrl` duplicating `PUBLIC_MAP_URL`** — intentional, with a startup check that
  makes disagreement loud.
- **`renderShortElapsed` diverging from `renderElapsed`** — SMS per-character cost, documented.
- **`owner_seller_id` denormalized across six tables** — sound as an FK anchor; the composite FKs earn
  the columns. The discipline that was missing is that it may be written and joined, never *compared*
  against another table's seller as a validity test. Tranches A and B remove the only two such
  comparisons. **No column drops.**
- **The comment density (33%)** — mostly an asset; the contracts are load-bearing and caught real
  things during both audits. Do not run a comment-reduction pass. Treat comments as *claims* to
  verify, not proof — three were found false here.
