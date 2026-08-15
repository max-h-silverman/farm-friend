# Farmer-Behavior Architecture Plan

Status: closure, `SAME`, targeting, settings, and scheduling were adversarially reviewed and built.
The hosted-seller portion was reopened on 2026-08-14 and is now an implementation contract
(§multi-seller stand architecture). Nothing in it is open for design; where it and the historical
plan below disagree, the contract wins.

## Multi-seller stand architecture: implementation contract

Several VIGA stands host more than one seller today. This is current fact, not anticipated growth.
The contract below replaces this plan's historical participant, guest-access, shared-inventory, and
shared seller-schedule/payment assumptions. The ten open questions that stood here are resolved in
§resolved questions; nothing in this section is still open for design.

### Product model

- A **user** is one person reached through a verified account/phone. A user may act for several
  sellers and stands.
- A **seller** is a reusable public brand identity shared by one or more users. A seller may be a
  farm, bakery, maker, individual grower, or another kind of provider; `farm` is not the authority
  root. **One person selling under two brands at a single stand is not supported** — a stand admits
  at most one provider row per seller, and a person needing two brands there needs two sellers.
- A **stand** and **location** remain one core record: one physical sales point with its pin,
  address, visitor directions, physical access state, and other shared place facts. There is no
  parent destination/site record. If separately managed stands ever share coordinates, the map may
  cluster their pins without merging their facts.
- A stand has one or more **providers**. A provider is one seller's participation at one stand, or —
  when the seller reference is empty — the stand's **native brand slot**: the stand selling as
  itself, under its own name. Native is a brand, not an absence of one. A stand has exactly one
  native slot because it has exactly one name, so "how many native providers may a stand have" is
  not a question the model has to answer.
- The same seller may participate at many stands; each relationship remains independent.

No name, shared address, nearby pin, common land, or existing prose implies any relationship. Every
seller/stand link is explicit and time-bounded.

### One provider record, not two

**Decision (former open question 9).** Native and named participation are **one record with a
nullable seller reference**, not two records behind a shared interface.

The reader surface is the reason. §the consolidation enumerates the hand-written current-inventory
query sites; two provider records would double every one of them and reintroduce the
agree-by-convention failure this refactor exists to end. One record with a nullable column means every guarantee —
one-current-per-provider, publication authority, pause, freshness — is stated once and enforced by
one constraint set for both kinds. A newcomer holds one concept.

`seller_id IS NULL` means the native brand slot — the stand selling under its own name. That is the
entire difference, and it is a permanent shape rather than a migration shim: every stand today is
its own seller, and most will stay that way.

The optional primary-seller link the discovery contemplated (a native provider that also "counts as"
some seller's goods) is **not built**. It is the two-records design wearing a nullable column: it
makes one row answer to two identities and forces every reader to ask which one applies. A stand
whose owner wants credit under a *different* brand than the stand's name creates a named provider
for that brand.

### Facts and authority

- **Stand facts**: coordinates, address, visitor directions, physical access/lock state,
  stand-level closure, and the stand's own descriptive information.
- **Provider facts**: current and usual inventory, item prices, payment/Farm Bucks rules, season,
  schedule, restocking, visibility/pause, one stand-specific public note, and inventory reminder
  preferences.
- **Availability is an intersection, never a union.** A provider's schedule and season are clamped
  to the stand's: a provider may be closed while the stand is open, and can never be open while the
  stand is closed. This is what supports the real case — a hosted seller who takes only cash and
  locks their box before the stand shuts. The intersection is computed once, at the Phase A reader
  seam; two surfaces computing it separately is the map-and-SMS disagreement this refactor exists to
  end.
- A stand shutdown overrides every provider, and renders **nothing itemized** — no seller's items
  show, hosted or native. A closed stand is locked, so no one's goods are buyable there; the hosted
  seller's items remain on their own seller page and at their other stands. Hosted sellers are
  **not** notified: closure is planned, and the host communicates with their sellers directly.
- Every active stand has at least one user owner. **There is no owner-transfer or owner-recovery
  flow, and none is built here** — VIGA repairs a locked-out or departing owner by hand through the
  existing admin tools. The earlier claim that an existing recovery path extends to sellers was
  false; no such path exists in the codebase.
- Stand owners invite/revoke users by phone. Grants are scoped to whole-stand management or a
  selected provider's inventory. Users may hold owner/editor roles inside multiple sellers.
- **A seller has authorized phones, not internal roles.** Anyone authorized for a seller may do
  anything that seller may do. Seller-internal owner/editor tiers were **cut as speculative**: no
  VIGA farm has asked to give someone partial access, and the tiers would be a second permission
  system running alongside the stand-owner grants. Limited access gets built when a farm asks.
- Stand owners and whole-stand managers may update any provider's **current stock** as a physical
  observation. They may not change a hosted seller's identity, prices, payment, pause, or
  participation unless separately authorized for that seller.
- Each provider has one reminder cadence and one designated recipient. Other authorized users may
  still update it manually.
- **A paused provider is offered re-opening, never refused.** Pausing invalidates that provider's
  open confirmations. A confirmation reply or a fresh inventory update arriving while paused does not
  publish silently and is not rejected: it triggers a new confirmation stating the consequence —
  *"Publishing this update will re-open your listing. Reply YES to confirm, NO to cancel."* One rule
  for both cases. The seller decides what they meant; code never infers it.

**Reminder cadence is per provider, not per stand** (former open question, flagged as possible
speculative building). Per-provider is not speculation here: a hosted seller restocking weekly at a
stand whose owner restocks daily needs its own cadence, and the recipient differs by construction —
the whole point of hosting is that the seller, not the host, confirms the seller's goods. One
cadence per stand would either spam the host about goods they do not control or leave the hosted
seller unreminded. The cadence record hangs off the provider because the provider is who it addresses.

### Hosting and approval lifecycle

- A stand owner invites a hosted seller and the seller accepts before the relationship becomes
  public or can publish inventory. Either side may end it; the seller may pause/resume without
  ending it. Ending or pausing hides current public facts without deleting history.
- VIGA approval is required before a seller appears publicly. A VIGA invitation counts as approval.
  An already approved stand owner may vouch for a hosted seller; the approval records that
  provenance, and VIGA may revoke the seller globally.
- Public participation and edit access are separate. Acceptance never grants more access than the
  explicit user/role scopes attached to the relationship.
- Native contributors update native inventory without creating seller identities. A named provider
  requires a seller identity so the provider can be found across stands.

### Customer behavior

**Two public list views: stands and sellers. Stands is the default.** The map remains a map of
stands; sellers get a browse list and a detail page, not pins. The two views are one reader in two
groupings — stand detail groups by item with sellers nested beneath; seller detail groups by stand
with that seller's items nested beneath.

The seller list survived an over-engineering cut and is **not** optional. A hosted-only seller —
one who sells exclusively at other people's stands, like a bakery with no stand of its own — has no
pin and no stand card of its own. The seller list is that seller's **only** discovery path, so it
carries search and shows where each seller is currently selling. Without it, naming hosted sellers
in public output credits them without making them findable.

**Seller naming in public output.** Every inventory line belongs to a provider. **The native brand
slot renders unlabeled; every named seller is credited by name — including one the stand's owner
also owns.** The rule is the slot, not the person and not the string: a stand owner who sells under
a separate brand deliberately created that brand, so it is named on the card and findable in the
seller list. Suppression applies to exactly one line per stand, the native one, where a label would
merely echo the stand's own name:

```
Morgan Hill Stand
  Eggs $8 — confirmed 2 hrs ago
  Tian Tian: eggs $7 — confirmed yesterday
```

The suppression is a slot rule on rendering, never a "host line first" rule and never a name match.
**Name matching was rejected as a defect**: seller names are free text, and the corpus normalizes
only case and whitespace — "Morgan Hill Farm" at "Morgan Hill Stand" would not match and the stand's
own goods would be credited by name on its own card, while any looser rule would erase a genuine
hosted seller called "Hill Farm" at "Hill Farm Stand". A stand whose native slot currently holds
nothing renders hosted sellers only, with no empty native line and no implication that the stand
itself has stock:

```
Morgan Hill Stand
  Tian Tian: eggs $7 — confirmed yesterday
  Cascade Bakery: eggs $9 — confirmed 3 hrs ago
```

This resolves the different-price/different-freshness collision without a price range or a
suppressed price: each provider carries its own price and its own confirmation time, always.

- Stand details stay centered on one `In stock` card, item-first: each item appears once and its
  supporting providers nest beneath it with their own price and freshness. No three duplicate
  `Tomatoes` rows.
- A provider with no fresh confirmation stays visible with honest usual/stale/no-current-listing
  language; unknown, usual, and current are never collapsed.
- **A hosted seller's usual items are public before any confirmation exists.** A hosted seller
  becomes visible on acceptance and VIGA approval, on standing claims alone — so **VIGA approval is
  the real gate**, not first confirmation, and a host's vouching produces a visible-but-revocable
  state rather than silent publication. Such a line renders in the usual register with **no
  timestamp** and never as a bare item line that could read as current stock.
- `What's at Morgan Hill?` returns the union of its provider inventories. `What does Green Acres
  have out?` filters to that seller across its active stands. `Who has eggs?` returns one result per
  stand and uses that stand's own freshest eggs evidence, never an unrelated stand's update.
- Payment is explicit per provider. The likely case is a seller-specific payment path, but a
  relationship may deliberately use a shared stand checkout. A seller's payment may differ by stand.
- **A stock-out report goes to every provider whose current confirmed inventory contradicts it —
  no question is asked.** The customer is never made to name a seller: at an unattended stand with
  two coolers they usually did not notice whose goods were whose, and a guess routes a false alarm
  to the wrong farmer. The test is **contradiction, not recency**: a provider already claiming the
  item is out agrees with the report and is skipped; a provider claiming it is available is told,
  whether they confirmed five minutes or three weeks ago. A provider with no confirmed claim on the
  item — usual-only, or never listed — is **not** notified, and the report is filed for VIGA.
  Customer reports remain private signals and never mutate published inventory.

  *Transitional, not a design constraint:* 18 of 37 stands publish no confirmed inventory at all
  today (measured 2026-08-11), so their reports currently reach no farmer and land in VIGA's queue.
  This is a farmer-migration artifact that resolves as stands confirm inventory. It is deliberately
  **not** designed around — routing reports to non-claimants would bake a transitional condition
  into permanent behavior.
- **Public output never attributes an observation to its observer.** When a stand owner marks a
  hosted seller's item sold out, the card shows the item and its timestamp exactly as it would for
  the seller's own update. Provenance is recorded on the revision for audit and for the seller's own
  view; it does not render on the map or in SMS.
- A seller at several stands may explicitly name the stand in an update; that target overrides
  remembered context. Otherwise use the last explicitly selected valid stand, name it in the
  preview, and bind confirmation to that exact provider/stand.

### Phase order

Phases are strictly ordered. Each requires its constraints, readers, concurrency tests, and honest
failure replies before the next begins.

#### Phase A — consolidate the current-inventory reader (no behavior change)

**Approved and non-negotiable: this lands first, proving output unchanged, before any record
changes.**

"What is currently in stock at this stand" is hand-written across non-test files, every one keyed on
`sales_location_id` alone with no provider dimension. They agree today only by convention and
comment discipline. Once a stand has several providers, any site missed makes the map and SMS
disagree.

**The enumeration below replaces every earlier count.** The figure of 26 was never reproducible, and
the "nine files" framing was itself incomplete — it named `apps/web/lib/scheduled-prompts.ts` but
missed `packages/db/src/scheduled-prompts.ts`, which runs the same read on the farmer's cadence-save
path. The number is not the point; the list is. **The golden-output gate tests this list, never a
remembered count.**

##### The enumerated current-inventory read sites (established 2026-08-14)

Established by reading every production reference to `inventory_revisions` and `inventory_entries`
across `apps/`, `packages/`, `evals/`, and `scripts/` — not by searching the nine named files. The
search was proved against known-present sites before any empty result was believed.

| # | Site | Scope | What it reads |
|---|---|---|---|
| 1 | `apps/web/lib/inquiry.ts:277` | corpus-wide | customer SMS retrieval — current entries for every public stand |
| 2 | `apps/web/lib/public-listing.ts:469` | corpus-wide | the public map/stand cards — current entries, left-joined so an unconfirmed stand still lists |
| 3 | `packages/db/src/admin.ts:940` | corpus-wide | **VIGA admin stand roster** — `current_items` for the farms page and `/api/admin/stands` refresh |
| 4 | `apps/web/lib/farmer-stand.ts:129` | one stand | **the farmer stand/settings editor prefill and its post-publish refresh** (`readCurrentStandEntries`) |
| 5 | `apps/web/lib/stockout.ts:98` | one stand | the stock-out matcher's published-item candidates |
| 6 | `apps/web/lib/interpretation.ts:134` | one stand | the SMS composition base a farmer's next edit is composed against |
| 7 | `apps/web/lib/scheduled-prompts.ts:148` | one stand | the reminder pass's snapshot and its cadence-reset `published_at` |
| 8 | `packages/db/src/scheduled-prompts.ts:71` | one stand | the cadence-save path's `published_at` baseline |
| 9 | `packages/db/src/transactions.ts:746` | one stand | the proposal's inventory base revision when the caller did not supply one |
| 10 | `packages/db/src/transactions.ts:956` | one stand | the incumbent revision the SMS confirmation supersedes |
| 11 | `packages/db/src/transactions.ts:1384` | one stand | the scheduled prompt's validity check against the current revision |
| 12 | `packages/db/src/farmer.ts:621` | one stand, **locked** | the incumbent revision onboarding redemption supersedes (B-070) |

**Only site 12 takes `for update`.** Sites 9–11 run inside a writer's transaction but read the
revision unlocked; the transaction's serialization comes from the other rows it locks. The shared
reader therefore takes `lock` as a REQUIRED argument rather than defaulting it either way — a
default that took the lock would put row locks on read paths, and one that dropped it would silently
undo B-070. `current-inventory.integration.test.ts` measures the lock with a second session's
`for update … nowait` rather than trusting the argument.

**Deliberately excluded**, so a later reader does not re-add them by mistake:

- Every `is_current` mention on `closure_revisions` (`inquiry.ts:281,353`, `public-listing.ts:472`,
  `interpretation.ts:177`, `scheduled-prompts.ts:139`, `admin.ts:943`, `transactions.ts:761,962,1390`).
  Closure is a different question with its own revision stream; consolidating it here would widen
  Phase A past its gate.
- Every writer's `set is_current = false` (`farmer.ts:629`, `transactions.ts:1162,1205`,
  `seed.ts:751`). These publish; they do not read.
- `packages/db/src/seed.ts:735` — a seeding script, not a runtime surface.
- `packages/db/src/review.ts:436` — resolves a stock-out report's referenced entry **by id**,
  regardless of currency. Not a current-inventory read.
- `apps/web/app/stand/[token]/stand-form.tsx:131` — `isCurrentEntry`, a type guard. A textual match
  only.

##### Phase A as built (B-074, 2026-08-14)

`packages/db/src/current-inventory.ts` is the seam. It has **three shapes, not one**, because the
twelve sites ask one question three ways and a single row type would make every caller carry columns
it does not use:

- `currentInventoryJoin` / `currentEntriesJoin` — SQL fragments the three corpus-wide surfaces
  compose into their own larger statements. They select stand, farm, closure, offering and payment
  facts in ONE round trip; a per-stand call would multiply queries by the corpus and change the
  ordering each surface depends on. `visibleFarms` is the existing precedent for exactly this.
- `readCurrentInventory` — the stand-scoped reader: revision plus entries.
- `readCurrentRevisionRef` — the revision identity alone, with the explicit `lock` above.

`intersectAvailability` owns the stand/provider availability clamp, so no surface computes it alone.
In Phase A every call passes no provider and gets the stand's answer back; the intersection's rule is
one-directional — a stand that is not open overrides every provider, and `unknown` PERMITS rather
than closes, because silence is not a claim that a stand is shut.

**Two corrections the work produced**, both worth carrying into Phase B:

1. `listStandsForAdministration` had to move from a tagged template to `.unsafe()`. In a tagged
   template an interpolation becomes a **bind parameter**, so composing the shared join sent the
   clause as a string value and failed with `syntax error at or near "$1"`. Every corpus-wide site
   that composes a fragment must use `.unsafe()`; the statement carries no parameters of its own.
2. The roster's `currentItems` column had exactly **one** assertion in the whole suite, and it was
   `currentItems: []` on a never-published stand — green whatever the column returned.
   `admin-roster-inventory.integration.test.ts` now asserts populated values, so both admin refresh
   surfaces (the farms page and `/api/admin/stands`) are covered by effect.

One behavior change, deliberate and strictly narrowing: the shared reader orders entries
`sort_order asc, id asc`. Two sites already did; two ordered by `sort_order` alone, which is not a
total order because nothing makes `sort_order` unique per revision. The order is now stated once.

1. ~~Enumerate the real current-inventory read sites, by file and line, in this document.~~ Done above.
2. Introduce one shared current-inventory reader, parameterized by stand and (later) provider. It
   also owns the **stand-provider availability intersection**, so no surface computes it alone.
3. Move every enumerated site onto it. Golden-output tests over a populated database prove
   byte-identical results before and after, per site.
4. The consolidation ships and is verified on its own. No provider column exists yet.

Sequencing rationale: after Phase B the reader must return per-provider rows, and a site still
carrying its own SQL would silently keep returning stand-wide rows — correct-looking output that is
wrong. Consolidating first turns that class of bug into a compile-time change at one seam.

#### Phase B — records and constraints

`owner_farm_id` is welded into the constraint layer: **nine composite foreign keys route authority
through `(sales_locations.id, sales_locations.owner_farm_id)`**. Provider ≠ owner is therefore a
constraint-layer change, not an additive one. (The contract previously said eight, counting only
`schema.ts` lines 1061, 1534, 1602, 1635, 1699, 2642, 2771, 2864. The ninth is
`farmer_target_contexts_selected_location_owner_fk` at 1531 — see item 6.)

1. Add `stand_providers`: one row per seller-at-stand, with a nullable seller reference (native),
   lifecycle state (**pending/active/paused** — three, not four), approval provenance, schedule and
   season, and its own reminder cadence and recipient. Ending a relationship marks the row inactive
   with the date; an unanswered invitation and an ended relationship are both "not public", so a
   fourth `ended` state would add a case to every reader without changing any public output.
2. Re-root the nine composite keys from `(location, owner_farm)` to `(location, provider)`, so
   authority is carried by the provider relationship rather than by stand ownership.
3. Replace `inventory_revisions_one_current_per_location` — keyed on `sales_location_id` alone —
   with one-current-**per-provider**. This index is the specific invariant per-provider inventory
   invalidates; it must be replaced in the same migration that adds the provider column, never
   dropped ahead of it.
4. **Give `stand_items` a provider dimension in this same migration.** The contract previously
   overlooked this table. It is what a stand *usually carries*, it is stand-keyed, and
   `stand_items_one_per_location_name` (schema.ts:1923) admits exactly one row per stand per
   normalized name — so a host and a hosted seller who both usually sell eggs collide. The index
   becomes one-per-**provider**-per-name. This cannot be deferred: **a hosted seller's first
   published fact is a usual item**, not a confirmation, and usual items are the majority of what
   customers see (33 of 37 stands carry a usual item absent from published inventory; 18 publish no
   inventory at all — schema.ts:2922). `stock_out_reports` holds a composite foreign key into
   `(stand_items.id, sales_location_id)` (schema.ts:2964) that must be re-rooted with it.
5. Retire `sales_location_participants` as display-only seller names. Its rows are **not**
   auto-linked to seller identities (see §migration).
6. Widen `inventory_publication_proposals_one_open_per_sender` — see §the pending-change defect.
7. **Add the provider dimension to SMS targeting.** `farmer_target_contexts` (schema.ts:1510) and
   `farmer_target_menu_options` bind `(authorization, owner_farm, location)` with no provider, and
   the menu renders stand names alone (`farmer-targeting.ts:46`). A hosted seller at four stands is
   therefore untargetable: their selection routes through the *host's* `owner_farm_id`, which is not
   their farm. Both records take the provider, the menu names the seller where it differs from the
   stand, and `farmer_target_contexts_selected_context_coherent` (1542) is rewritten to include it.
8. **Invalidation on pause, revocation, and closure.** No mechanism exists today: closure is read at
   send time (`scheduled-prompts.ts:135`) and nothing is invalidated. Pause/revoke/close must
   invalidate that provider's open confirmations and queued reminders — stand closure invalidating
   all of them — which is what makes the re-open confirmation in §facts and authority possible.

#### Phase C — behavior

1. Hosted-seller invitation, acceptance, approval provenance, and scoped access grants.
2. Per-provider inventory writes; stand-owner observation of a hosted seller's stock; owner-only stand
   closure.
3. Per-provider SMS targeting, confirmation binding, and stock-out disambiguation.
4. Per-provider reminder cadence and the scheduler pass.
5. Stand and seller public list/detail views.

### The pending-change defect

**Defect, not a feature — fix scoped into Phase B.**
`inventory_publication_proposals_one_open_per_sender` is a unique index on `sender_hash` alone,
where `state = 'open'`. The limit on pending SMS changes is therefore **per person, not per target**.

Someone affiliated with sellers at two stands who texts an update for one is locked out of the other
until they reply YES or NO. **Multi-seller people are exactly the population this refactor serves**,
so the defect is load-bearing here even though it predates the multi-seller work.

Fix: key the index on **person and target** — `(sender_hash, sales_location_id, provider_id)` where
`state = 'open'`. The row already carries `sales_location_id`, so no new data is required for the
stand dimension. One open confirmation per person **per provider-at-stand**; the golden rule that a
confirmation token is context- and version-bound, commits exactly once, and expires is unchanged and
in fact better served — a token can no longer be ambiguous about which stand it answers for.

Regression test to write first: two open proposals for one sender at two different stands both
persist; a second open proposal for the same sender **and the same provider** is still refused.

### Migration approach

- Every existing stand gets exactly one provider row, native (`seller_id IS NULL`), carrying its
  current inventory, **usual items (`stand_items`)**, prices, payment, schedule, and reminder
  settings unchanged. Every current public and SMS output is byte-identical after migration.
- **Never auto-link a display name to a seller identity.** `sales_location_participants` rows are
  free-text names with no confirmed linking flow behind them; name matching would fabricate
  authority. They migrate as retained history and as a VIGA work queue, not as providers.
- Existing location/farm links are fingerprinted and reviewed before being treated as owner
  relationships. Flagged contradictions stay hidden and blocked. An owner is never automatically a
  seller.
- No inventory confirmation backfill: revision publication remains recency. Create no closure,
  preference, provider, or access grant from historical CSV data.
- Inventory proposals map one-for-one, preserving ID, base, version, tokens, state, and outbox
  binding, and gain the provider reference of their stand's native provider. Never reinterpret old
  queued text.
- The migration runs against a **populated** copy of the current schema and asserts exact row
  effects. Ambiguous historical relationships are refused, never guessed.

### Resolved questions

The ten questions that stood open here are closed. Product/UX answers came from Max; the rest were
technical calls made under this contract.

1. **Records/constraints/lock order** — §phase order B. Lock order is stand → provider → revision,
   matching the existing outermost-first discipline.
2. **Primary-seller/native link transfer** — **not built.** §one provider record. Native means
   unbranded; a stand wanting brand credit creates a named provider.
3. **Onboarding/recovery flows** — onboarding is Phase C.1. **Recovery: corrected.** The claim that
   an existing owner-recovery path extends unchanged was false — no owner-transfer or -recovery flow
   exists in the codebase. VIGA repairs these by hand through the admin tools, and nothing is built
   here. This blocks nothing.
4. **Migration** — §migration approach.
5. **Public card/detail behavior** — §customer behavior. Two list views, item-first stand detail,
   stand-first seller detail, host name suppressed **by ownership, not by name match** (corrected).
6. **SMS answer copy/paging** — §customer behavior. Provider lines carry their own price and
   freshness; existing three-stands-per-message paging is unchanged, and a multi-provider stand
   consumes its extra lines within its own stand block rather than displacing another stand.
7. **Stock-out recipients** — **corrected: no question is asked.** Notify every provider whose
   confirmed inventory contradicts the report; skip agreement and skip non-claimants. §customer
   behavior.
8. **Revocation/pause/retirement invalidation** — **the mechanism does not exist and is now scoped
   into Phase B.8**, not assumed. Every state change invalidates queued confirmations and reminders
   for the affected provider only; stand shutdown invalidates all.
9. **One record or two** — **one record, nullable seller.** §one provider record.
10. **F-112 follows** — deferred, deliberately. Follows are not built for sellers or providers in
    this refactor. Revisit once real hosted providers exist and their publication streams are
    observable; building three follow targets now is speculative.

### Verification requirements

- Phase A ships with golden-output tests proving every **enumerated** consolidated site returns
  byte-identical results against a populated database. The enumeration is written down first; the
  gate tests the list, never a remembered count. This is the gate for Phase B.
- Prove the availability intersection: a provider closed inside an open stand hides only its own
  goods; a provider whose hours exceed the stand's is still hidden when the stand is closed.
- Prove a paused provider's pending confirmation yields the re-open prompt rather than a silent
  publish or a bare refusal, and that `NO` leaves the listing paused.
- Prove a stock-out report reaches providers claiming the item available, skips providers already
  claiming it out, and skips usual-only providers.
- Prove a hosted seller at several stands can select and publish to each, with the menu naming the
  seller where it differs from the stand.
- Test-first with real Postgres constraints and **genuine contention** for owner transfer,
  invitation acceptance, provider publication, access revocation, and first-inventory races. A
  first-inventory race per provider is arbitrated by the unique index
  (`insert … on conflict do nothing returning …`), never by a preceding read — `select … for update`
  cannot serialize a row that does not exist yet. Each claimant needs its own provider row; sharing
  a stand parent serializes at the first read and measures the wrong lock.
- Prove every public and SMS reader derives the same provider facts, item-level evidence, effective
  availability, and seller/stand visibility from the shared reader.
- Prove customer reports cannot mutate publication; stand shutdown hides all providers; seller
  pause/revocation hides only its permitted scope; an unrelated provider's update cannot refresh
  another provider's item freshness.
- Prove the host suppression rule against a stand whose host has zero inventory: hosted sellers
  render, no empty host line, no stand-level stock implied. Prove it against a host and hosted
  seller with similar names, where a name-match rule would misfire in both directions.
- Prove the widened pending-proposal index admits two stands for one sender and still refuses two
  for one provider.
- Migrate a populated current schema and verify exact row effects, history, approvals,
  authorizations, pending confirmations, reminders, and public output.
- Exercise the item-first stand view at phone width with duplicate items, mixed prices/payments,
  mixed freshness, native-only inventory, hosted-only inventory, and no-current-listing states.
- Every index and CHECK added here is sabotage-tested: break the code deliberately and confirm the
  test catches it. A CHECK passes on NULL, so every provider-nullability rule is written as a
  biconditional, matching the existing `sourceProvenance` discipline.

### Replaced assumptions

- `sales_location_participants` is no longer sufficient as display-only seller names.
- Inventory is no longer one anonymous shared snapshot per stand. It is independently refreshed per
  provider, while customer item search deliberately aggregates those claims by stand.
- A hosted seller does not merely receive access to edit the host's shared inventory. A named seller owns a
  first-class provider relationship, facts, and query surface at that stand.
- The existing one-sided onboarding text field cannot create a hosted relationship. Hosting needs
  invitation, acceptance, approval provenance, and scoped access.
- The prior statement that one stand schedule/payment state applies to every seller is superseded.
- The historical Phase 1 line "keep existing inventory one-per-location" is superseded by
  one-current-per-provider.

## Historical farmer-behavior plan

The hosted-seller portions below are retained only as the record of the earlier design. They are not
requirements. The unrelated behaviors remain useful implementation history.

## Executive Decision

Phase 1 extends the existing farmer inventory workflow with six behaviors:

1. Confirm a location-wide closure or reopening, alone or atomically with inventory changes.
2. Reply `SAME` to a scheduled prompt that shows the exact inventory snapshot being confirmed.
3. Represent current sellers at a stand without assigning items to sellers; optionally grant a
   linked guest farm access to the stand's shared inventory.
4. Select among owned and guest-access locations deterministically on web and SMS.
5. Choose prompts every 2 days, weekly, every 2 weeks, or paused. Send at 10:00 AM in the
   location's timezone.
6. Reply `SETTINGS` to receive the existing farmer access link opened directly to web settings.

SMS remains the daily operational path: inventory, closure/reopening, target selection, and prompt
preference, plus a deterministic settings-link shortcut. Stable listing/profile facts remain
web-managed, including stand participants and guest access. Public and customer-SMS readers remain
model-free.

Before adding those behaviors, repair five defects in the current confirmation seam:

- An accepted old outbound prompt can activate a newer unseen proposal version.
- Provider acceptance and proposal activation are separate commits.
- Authority/approval revocation can race publication because confirmation does not lock them.
- A later farmer message can replace rather than extend pending edits.
- Model-proposed public text can publish phone/email content through web confirmation.

These are rollout prerequisites.

## Evidence: What the CSV Does and Does Not Prove

The CSV is behavioral research only—not current data, identity authority, consent, or migration
input.

Verified facts:

- 735 fixed-width responses, 16 columns; coverage is 2020 and 2024–July 2026, with no 2021–2023
  records.
- Median repeat-response gap is 13.8 days across 670 normalized-username gaps. With no invitation
  or non-response log, this does not reveal preferred cadence.
- Open status: 620 exact yes, 67 exact no, 48 non-binary.
- 53 of the 67 no responses have a nonblank availability cell, but manual review shows mostly
  closure, future/usual goods, or other status—not 53 reliable current-inventory claims.
- Normalized identity mappings: 11 usernames span farm labels; 20 farm labels span usernames.
  This supports many-contact authorization and possible multi-farm routing, not proven current
  multi-location farms.
- The 2026 changes field has 61 yes and 3 no answers; all 3 no responses repeat required fields.
  This shows form burden, not an existing `SAME` convention.
- Availability/free-text fields mix products, status, schedules, payments, certification,
  uncertainty, links, events, and corrections.
- Seller names usually lack item attribution, current relationship authority, or stable identity.
  The saved plan's 63% change claim is not reproducible.
- Eight columns have blank headers. Their original questions cannot be recovered from the CSV.

Supported conclusions:

- Closure/reopening needs a lifecycle separate from inventory.
- Mixed operational messages need one atomic confirmation.
- Repeating a complete form creates avoidable farmer effort.
- Routing must handle multiple authorized targets without model guessing.
- Other-seller responses support a location-level participant list, not item provenance.
- Free text requires conservative interpretation.

Unsupported by the CSV: current stock/closure/payment facts, authority, consent, prompt defaults,
current seller relationships, identity links, item sources, certification taxonomy, events, or
profile editing by SMS. The participant model is a product decision, never a historical backfill.

## Non-Negotiable Invariants

- A stand has one owner farm and one shared inventory. Ownership does not assert that the owner is a
  current seller.
- Location owner authorization controls address, hours, closure, visibility, participant metadata,
  and guest inventory access.
- The owner can update shared inventory. A guest needs a live authorization, farm approval, and
  active owner-granted inventory-access record. Closure remains owner-only.
- The owner farm approval gates farmer-confirmed location facts; the publishing farm's approval
  gates its inventory write. Revocation never erases the underlying VIGA listing.
- Being publicly listed as a seller and being allowed to edit inventory are separate permissions.
- SMS consent controls messaging, never authority.
- Code binds sender, recipient, authorization, publishing farm, location, owner/access basis,
  preference, proposal version, confirmation token, and commit. The model binds none of them.
- Every write revalidates authority. A remembered SMS target is convenience only.
- One shared lock order applies to write transactions: sender, location, participant/access grant
  when used, proposal, authorizations, approvals. Location locking arbitrates every editor and first
  publication of the shared snapshot.
- Revocation and confirmation lock the same access/authority/approval rows; lock order defines the
  honest winner.
- Model output is schema-bounded. Unsupported fields or invalid IDs/dates refuse the whole result.
- Every new public string is checked before storage/publication. Inventory fields and participant
  names refuse phone numbers, email, URLs, and direct-contact instructions. Web and SMS share the
  validator.
- Public approval revocation hides affected farmer-confirmed inventory, closure, and participant
  facts without deleting audit history or the underlying VIGA listing. GL-028 owns broader operator
  behavior.
- Public browse, map, `Open now`, and customer SMS use one canonical closure projection.

## Product and Data Ownership

| Fact | Durable owner | Writer | Readers |
|---|---|---|---|
| Current shared inventory | Immutable location revisions/entries | Owner or guest with active access | Public, map, customer SMS |
| Closure/reopening | Immutable closure revisions | Location owner | Canonical closure projection |
| Current sellers | Location participant records | Location owner | Map, detail, settings |
| Guest inventory access | Revocable access grants | Owner grant + guest acceptance | Farmer routing/writes |
| Stable listing/profile | Existing farm/location tables | Existing web/operator paths | Public and farmer web |
| Prompt preference | One location preference | Deterministic SMS or authenticated web | Scheduler/dispatch |
| SMS target | Sender target context | Deterministic `STAND` | Farmer routing only |

No second inventory-confirmation lifecycle. `SAME` publishes an identical immutable inventory
revision, so `published_at` remains the single inventory recency fact.

### Location owner, participants, and guest access

Treat the existing location farm as `owner_farm_id`. Owner authority exists independently of seller
participation.

A location participant stores:

- Location, owner-confirmed display name, active/retired state, confirming owner authorization, and
  timestamps.
- Optional linked Farm Friend farm plus its accepting authorization/time.
- One active row per linked farm/location; normalized active external names cannot duplicate.

Rules:

- The owner may list an unregistered farm/business name as owner-confirmed stand metadata.
- Linking that name to a Farm Friend profile requires explicit acceptance from that farm; code never
  name-matches historical text or aliases.
- The owner is not automatically a participant. Add the owner to the seller list only when the
  owner confirms it currently sells there.
- Public surfaces show active participant names separately from items. Confirmed linked names may
  link to profiles; external names remain plain text.
- Retire rather than delete participation. Retirement atomically revokes its inventory access.

Guest inventory access is a separate revocable record tied to an active linked participant:

- Owner grant and guest acceptance are both required.
- The grant records both authorizations/times, active/revoked state, and revocation provenance.
- Both authorizations and both applicable farm approvals must still be live at every use. The owner
  can revoke access; the guest can withdraw it.
- Public listing does not imply access, and access does not assign ownership to inventory items.

Inventory remains one complete snapshot per location:

- One current immutable revision per location, with no seller/source field on entries.
- Publication records the publishing farm/authorization, owner/access basis, owner approval,
  publisher approval, and proposal for audit. For owner publication the two approvals are the same.
- Owner and permitted guests edit the same snapshot. Location locking converts concurrent edits
  into one winner and one honest base conflict.
- Public inventory is one aggregate “available now” list.

### Narrow farmer update proposal

Evolve the inventory proposal to contain:

- Binding: sender, authorization, publishing farm, location, owner/access basis, and origin (SMS,
  web, scheduled check).
- Optional complete inventory snapshot using existing entry fields.
- Optional closure result: `close` or `reopen`; close carries `temporary` or `seasonal`,
  local start date, and optional inclusive `closed_through`.
- Exact inventory and closure bases, including explicit first/no-current markers.
- Schema/proposal version, YES/NO tokens, state, exact activation outbox/version, activation/expiry,
  consumed token/provider event, and close time.
- For scheduled checks: exact preference/version and due slot.

Database rules:

- At least one inventory or closure section.
- One open proposal per sender across all farms/locations.
- Ordinary proposals must change an affected fact. Scheduled `SAME` proposals may copy inventory
  unchanged.
- Existing entries retain opaque IDs; new pending entries get code-issued draft IDs.
- Location/owner, authorization/publishing-farm, base/location, participant/grant/location, and
  approval/farm relationships use composite foreign keys where applicable.
- An accepted outbox version can activate only that proposal version.
- One provider event consumes one proposal; one proposal publishes at most one revision per fact
  lifecycle.
- Every state shape explicitly constrains required/forbidden NULLs.

New farmer messages compose from the pending complete result, not the published snapshot, preserving
earlier edits unless explicitly removed.

### Closure revisions

Append-only shape:

- Identity/provenance: ID, owner farm, location, proposal, owner authorization/approval, published
  time.
- Result: `close` or `reopen`.
- Close fields: temporary/seasonal, local `starts_on`, optional inclusive `closed_through`.
- Lifecycle: current marker and superseded time.

Constraints:

- One current closure instruction per location; one closure revision per proposal.
- Reopen has NULL kind/dates; close requires kind/start.
- Seasonal has no end date.
- Temporary may be bounded or open-ended; end cannot precede start.
- Current/superseded and all NULL cases are explicit.
- Composite foreign keys enforce location/owner farm, authorization/owner farm, and approval/owner
  farm.

No arbitrary farmer-authored closure note. Code renders status from confirmed kind/dates.
Only a live owner-farm authorization may create or confirm a closure section. Guest closure output
refuses the whole proposal rather than partially publishing an inventory section.

### Prompt preference and dispatch subject

The location owns one reviewed IANA timezone. Closure dates, prompts, and public status use it.

One optional preference per location stores:

- Location, designated authorization/recipient, and owner/access basis.
- Cadence: every 2 days, weekly, every 2 weeks, or paused.
- Positive version, next due time, and update provenance.

The designated recipient must be an owner authorization or a guest with active inventory access.
There is one schedule per stand, not one per participant. Any active editor may explicitly become
the designated recipient; only that recipient gets prompts. Historical behavior never seeds
preferences.

Each scheduled prompt has a typed durable subject:

- Exact proposal/version, preference/version, authorization, location, inventory/closure bases,
  due slot, and outbox ID.

Database uniqueness on preference plus due slot arbitrates duplicate workers. Dispatch joins this
subject; it never parses meaning from message category or logical key.

### SMS target context

- A valid target is a location the authorization's farm owns or may edit through active guest
  access. One valid target is selected automatically.
- Multiple targets require a server-issued `STAND` menu with numbered choices bound to exact
  authorization/location pairs. Menu bindings expire after 12 hours, so reordering cannot change
  an old number.
- Selected target persists until switched or invalidated, but is revalidated and named in every
  prompt, preview, and receipt.
- With multiple authorizations and no selection, `LINK` directs the farmer through `STAND`.
- The model never sees or chooses target options.

### `SETTINGS` web shortcut

- `SETTINGS` is the canonical keyword: case-insensitive after whitespace normalization, but
  otherwise an exact deterministic command routed before free text.
- It reuses the existing standing farmer-link token, revocation, and authorization system and lands
  on its settings route. It creates no second login or link lifecycle.
- With one live authorization, code uses it automatically. With several, it uses the authorization
  behind the selected target; without one, it directs the farmer through `STAND`.
- The page lists only locations owned by or granted to that live authorization. It edits prompt
  cadence/pause and the sender's default SMS location. For owner locations it also manages current
  participant names, profile-link requests, and guest inventory access—no broader profile fields.
- A linked guest can accept/withdraw its relationship or access, but cannot edit participant names,
  grant access, or change owner-controlled location facts.
- Choosing an active cadence explicitly makes the current authorized contact that location's
  designated prompt recipient. The page never exposes another contact's identity or phone number.
- Pausing changes prompt preference, not carrier consent. `STOP`/`START` remain the only SMS-consent
  controls.
- A sender without live farmer authorization receives the same non-disclosing refusal as `LINK`.
- Farmer onboarding and settings-related confirmations advertise “Text SETTINGS to change these.”
  Inventory prompts do not repeat it.

## Write Flows

### Participant and access flow

1. An owner adds/retires seller names with a structured `SETTINGS` save; that explicit save is the
   confirmation and audit event. Unlinked active names display as owner-confirmed metadata.
2. To link an existing Farm Friend farm, the owner selects its exact public farm record. Code stores
   a pending link; it never resolves aliases or free text.
3. An authorized farmer for the invited farm accepts or declines in `SETTINGS`. Only acceptance
   enables the profile link. An unregistered seller must complete existing `SIGNUP` and VIGA
   approval before linking.
4. Inventory access is requested/granted separately and becomes active only after the linked guest
   accepts it. Each live, consented guest authorization gets at most one deduplicated invitation
   notice; without consent the request waits in settings. Any live guest authorization may accept,
   with database serialization deciding conflicting accept/decline attempts.
5. Owner retirement revokes access atomically. Guest unlinking removes its profile association and
   access; the owner's plain seller-name metadata is a separate public decision.

### Farmer SMS/web update

1. Route STOP/consent, exact tokens, `STAND`, `SETTINGS`, prompt preference, authorization, and
   `LINK` before free text.
2. Resolve one live owner authorization or active guest inventory grant for the location in code;
   ambiguity stops at `STAND`.
3. Base interpretation on the sender's pending complete proposal, otherwise current published
   inventory/closure.
4. Model input contains only current text, permitted inventory fields/opaque IDs, pending/current
   shared inventory, current closure, and a code-supplied owner/guest capability. Output is inventory
   edits, owner-only location close/reopen, or clarification; it never edits participants/access.
5. Code validates schema, IDs, dates, public strings, and semantics, then builds each complete
   affected result. Vague/contradictory dates, future goods stated as current, and sub-operation
   closures require clarification.
6. One transaction locks sender/location, rechecks bases, stores the exact proposal version, and
   queues a code-rendered preview naming the location.
7. Provider acceptance recording and exact proposal activation commit together. An ambiguous
   provider result does not activate or retry blindly; callback/reconciliation resolves it.
8. `YES` uses the shared lock order, rechecks bases, owner/access authority, both applicable farm
   approvals, and publication validation, then publishes all included lifecycles atomically.
9. `NO` publishes nothing. Expired, replayed, stale, unauthorized, or unapproved tokens publish
   nothing and get an honest deterministic reply.

Farmer web lists only owned or actively granted locations, uses structured inputs, and enters the
same proposal, validation, locking, and publication path. It cannot bypass confirmation, access, or
public validation.

### Scheduled prompt and `SAME`

1. The existing scheduler gets one prompt pass; no second scheduler/cron framework.
2. A due preference creates one proposal containing the exact current inventory snapshot and
   closure base, plus typed dispatch subject and outbox row.
3. Prompt names the location and displays the complete snapshot. With no published inventory, or
   when the full snapshot cannot be shown safely, do not offer `SAME`; request an update or link
   to farmer web.
4. Dispatch rechecks consent, designated owner/access authority, applicable farm approvals,
   preference/version, due slot, current bases, closure, and newer farmer activity.
5. Provider acceptance activates only the exact scheduled version.
6. Exact whole-message `SAME` routes after STOP handling and before free text, and only with an
   active scheduled proposal. “Same eggs?” remains free text.
7. `SAME` uses ordinary confirmation and publishes an identical inventory revision. Replay,
   expiry, changed inventory/closure/preference, revoked consent/authority/approval, or provider
   mismatch changes nothing.
8. Farmer change text invalidates the scheduled proposal and opens an ordinary update for that
   named target.

Prompt rules:

- Send at 10:00 AM local time; handle daylight-saving transitions.
- Next due is based on the later of latest inventory publication and last scheduled due slot.
  Inventory publication resets cadence.
- Active closure or pause invalidates queued prompts.
- Bounded closure expiry or explicit reopening makes at most one next slot eligible.
- Delayed runs jump to one current/future slot—never a catch-up burst.
- One open proposal per sender serializes due locations. Deterministic ordering chooses one; another
  stays due until the first action closes.

## Consumer Behavior and Edge Cases

- Closure is active from local `starts_on` through inclusive `closed_through`, or until reopen
  when unbounded. Bounded closure expires at read time; no cron mutates history.
- Future closure is shown as upcoming without yet overriding availability.
- Active closure overrides standing season/days/hours and makes `Open now` false.
- Unknown standing schedule remains unknown unless active closure supplies a truthful closed answer.
- General item/SMS discovery does not present an actively closed location as actionable.
- The stand/location name and owner describe who operates the location, not who supplied current
  items. The owner need not appear in the current-seller list.
- Map/detail may show active participant names as “Also selling here,” separately from one aggregate
  inventory list. Items have no seller provenance.
- A stand may be open with only guest products, or with no currently confirmed inventory.
- Explicit location detail may show preserved inventory with closure and separate recency labels.
- Bounded expiry resumes standing schedule; preserved inventory keeps its real age/stale warning.
- Closing never clears inventory/usual offerings; reopening never refreshes inventory.
- “Closed this weekend; still have eggs” publishes both sections or neither.
- Vague closures, conflicting dates, sub-operation closures, multiple closure windows, or a future
  closure that would silently supersede an active one require clarification.
- Phase 1 stores one current/upcoming location-wide closure instruction.
- `SAME` without an active full-snapshot prompt is harmless and never confirms closure/profile.
- Owner and guest editors updating one location serialize; the loser gets a base conflict, not a
  database error.
- Participant retirement, access revocation, or authority change clears invalid target context and
  suppresses queued prompts.

## Sequence and Migration

### Phase 0: repair current guarantees

Write each failing test, observe failure, then repair:

1. Exact proposal-version activation and atomic provider-acceptance recording.
2. Shared lock order, revocation safety, and clean cross-contact base conflicts.
3. Pending-snapshot composition with draft IDs.
4. Shared public-field validation on web and SMS.

Do not build new behavior on the current seam first.

### Phase 1: schema and readers

1. Make location ownership explicit; add participants, guest access, proposal publisher/access
   bindings, closure revisions, location timezone, prompt preference, typed dispatch subject, and
   target context.
2. Keep existing inventory one-per-location and preserve its current publisher provenance. Remove
   the rule that future publishers must be the location owner; replace it with owner-or-active-grant
   enforcement.
3. Backfill timezone from reviewed current location authority—not a model/runtime geocoder.
4. Map populated inventory proposals one-for-one, preserving ID, base, version, tokens, state, and
   outbox binding. Never reinterpret old queued text as a `SAME` prompt.
5. Add participant readers and canonical closure projection to every public/SMS path before
   accepting new writes.
6. Verify migration from a populated pre-change schema.

No inventory confirmation backfill: revision publication remains recency. Create no closure or
preference from historical CSV data. Do not create participants, links, or guest access from the
CSV. Preserve current seller metadata only if a reviewed authoritative current source exists.
Fingerprint and review existing location/farm links before treating them as owner relationships;
flagged contradictions remain hidden/blocked. An owner is never automatically a current seller.
B-024 requires explicit VIGA resolution rather than an inferred migration.

### Phase 2: behavior

1. Owner-managed participant metadata, guest linking/acceptance, inventory-access grants, and public
   participant display.
2. Shared-inventory owner/guest writes plus owner-only closure/reopening and mixed proposals.
3. `STAND`, multi-authorization `LINK`, and `SETTINGS` across owned/granted locations.
4. Scheduled full-snapshot proposals, `SAME`, prompt controls, and scheduler pass.

Each phase requires its database constraints, readers, concurrency tests, and honest failure replies
before the next.

## Verification Contract

Current-seam proving tests:

- Accept queued v1 after revising to v2: nothing activates/publishes.
- Force failure between acceptance recording and activation: no sent-but-unactivatable proposal.
- Race revocation/confirmation in both lock orders with separate connections/barriers.
- Race two contacts' first publication: one winner, one clean conflict, no unique-index error.
- “Add kale,” then “also eggs”: both persist.
- Inject phone/email/URL/contact instructions through every web/SMS model-writable public field:
  all publication paths refuse.

New behavior:

- Owner farm is distinct from current sellers; owner can be absent while active guests display.
- Unlinked participant names display as owner-confirmed text; no profile link/access exists until
  exact guest acceptance. No automatic name matching.
- Participant linking/access covers pending notice deduplication, no-consent suppression,
  accept/decline contention, signup-before-linking, guest unlink, owner retirement, and audit
  retention.
- Public listing and inventory access vary independently. Retiring a participant revokes access;
  revoking access alone leaves the public participant decision unchanged.
- Owner and granted guest can publish the same aggregate inventory; entries never gain seller IDs.
- Unauthorized, unaccepted, retired, revoked, or unapproved guests cannot create, activate, confirm,
  or receive prompts. Race grant revocation against confirmation in both lock orders.
- Guest closure or participant/access output refuses the whole proposal; owner closure remains
  available and atomic with shared inventory.
- Bounded/open-ended temporary, seasonal, future, expired, superseded, and reopened closure states.
- Mixed inventory/closure publishes both or neither; close/reopen leaves inventory untouched.
- Real workflow reaches detail, map, `Open now`, discovery, customer SMS, and renderers.
- `SAME`: real routing/outbound acceptance, distinct provider events, expiry, replay, stale bases,
  changed closure, revocation, and exact durable row/reply effects.
- `STAND`: expiry, reordering, unauthorized targets, authority changes, and competing prompts.
- `SETTINGS`: exact routing, unauthorized sender, single/multiple authorizations, selected target,
  standing-link replacement/revocation, owned/granted location isolation, participant/access role
  boundaries, hidden contact identity, cadence/default-location change, recipient designation, and
  pause without consent mutation.
- Scheduler: every cadence, 10:00 AM/DST, pause, freshness reset, closure/reopen, delayed runs,
  same-sender locations, duplicate workers, and no catch-up.
- Dispatch suppresses after consent stop, authority/approval revocation, preference/base change,
  fresh inventory, or closure.
- Populated migration preserves proposals, revisions, entries, tokens, states, and outbox bindings.
- Migration preserves reviewed farm/location ownership, leaves flagged contradictions blocked, does
  not invent owner participation, and imports no CSV seller names or access.

Proof quality:

- Use real Postgres and genuine contention barriers; `Promise.all` alone proves nothing.
- Test decisive NULL cases for every closure constraint.
- Hostile model output attempts identity, authority, target, address, visibility, stable profile,
  payment, Farm Bucks, seller, and unsupported sections; refuse the whole output.
- Assert durable rows, current markers, consumer results, and reply bodies—not returned statuses.
- Anchor source tripwires to call sites; remove the protected call and observe failure.
- Sabotage each load-bearing behavior and confirm its test catches the break.
- Build a sanitized corpus evaluation set; never commit usernames/raw CSV.
- Real-model evaluation requires explicit approval because it spends money. Stubs prove containment,
  not interpretation quality.
- Run existing tests, type checks, lint, and builds sequentially; verify effects, not green messages.

## Existing Work and Explicit Non-Goals

Existing ownership:

- GL-012: proactive prompts.
- GL-026: multi-location farmer SMS.
- GL-011/GL-014: broader farmer web/profile and listing completeness.
- B-024: producer/host correction now has an owner-versus-participant model, but its current facts
  still require explicit VIGA resolution.
- GL-028: operator-facing approval-revocation policy.

Non-goals:

- CSV import/backfill or historical inference of current facts, identity, authority, or consent.
- General profile editing by SMS.
- Model or guest control of address, coordinates, visibility, Farm Bucks eligibility, or approval;
  owner changes continue through their existing web/operator paths.
- Item-level provenance, seller-specific inventory snapshots, seller-specific reminders, or public
  claims that a particular item came from a particular farm.
- Automatic seller/profile matching, CSV-derived participants, or edit access implied by public
  listing. Guest farms cannot control location hours, closure, address, visibility, or other guests.
- Payment/Farm Bucks editing here; GL-014 owns display and unknown-vs-false, VIGA owns eligibility.
- Events, promotions, certification taxonomy, orders, reservations, payments, direct farmer contact,
  tenancy, or native apps.
- Automatic location creation/linking, runtime geocoding, or guessed pins.
- Generic classifier/field bag, second inventory-confirmation lifecycle, second scheduler, monthly
  reopening campaign, or closure-driven inventory deletion.

This plan does not create or mutate PM items.
