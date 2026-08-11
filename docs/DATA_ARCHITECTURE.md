# Farm Friend — Data Architecture

The *data* source of truth: the minimum durable records, the constraints the database must
enforce, privacy/retention, and the model-run audit MAY-store list.

> This document states the **enduring data contract** — the durable records Farm Friend must keep and
> the constraints the database must enforce. It carries no build status: what is actually built,
> migrated, and open lives in [CURRENT_STATE.md](CURRENT_STATE.md).
>
> **A constraint here is a claim until a test can fail on it.** The real-Postgres integration harness
> is what makes these real: it creates an empty throwaway database, applies every committed migration
> in order, reruns the journal as a no-op, and exercises the checks, foreign keys, partial uniqueness,
> and published-history guards against live constraints. A guarantee proven only by a repository
> function — never by the constraint itself — is not proven.

## Scope discipline

Launch is a **single VIGA operation** and a **greenfield build**. Accordingly:

- **No tenancy.** No `tenant_id`, no tenant registry, no tenant-scoped queries.
- **No gleaning, volunteer, or Farm Bucks transaction state.** These are plausible future programs;
  the architecture leaves room for them by staying small, **not** by pre-creating their tables.
- **No import provenance.** Initial listing data was **seeded** from reviewed reference
  input, while later schema migrations preserve live rows. There is no `migrated` vs
  `farmer_confirmed` provenance axis, no corpus backfill, and no claim-state machine.
- **No native-app or multi-level-role state.** One administrator level at launch.

Recency is expressed by **when a revision was published, by whom, and from where** — the third being
`source` (F-063), which distinguishes a farmer's own handset from VIGA's records without a second
axis of its own. That is sufficient to render an honest "updated X ago".

## Minimum durable data

- **farms and sales locations** — the farm and its stands or sales points. A location's
  `owner_farm_id` is the farm authorized to govern address, hours, closure, and visibility; owner
  authority is not seller participation. Each location carries one reviewed timezone used for
  local scheduled work; launch currently permits only `America/Los_Angeles`.

  **A location is complete or absent, and any farm may have one** (F-088, narrowing F-038).
  `sales_locations_coherent_visitability` requires an address *and* both coordinates together —
  half a pair puts a pin in the ocean, and a point with no address cannot be checked by anyone.
  Only the `visitable` branch still names `visitability`, forbidding a stand that claims visitors
  with nowhere to send them. A `contact_only` farm may be fully placed; **whether a farm is a
  destination is a rendering decision, not a storage one**, and the guarantee that nobody is routed
  to a farm with nothing to buy now lives in `buildMapView` (no directions link for `contact_only`)
  rather than in this constraint.

  **`address_public` governs the address TEXT, never the pin** (F-088). `NOT NULL DEFAULT true`,
  because every row predating it holds an address a farmer typed into a public listing form. The
  address is always stored; this decides whether it renders. Admin reads it regardless — support
  work needs the address — and the SMS answer path suppresses it in SQL so a hidden address never
  leaves the database on that path.

  **`prices_public` is the same shape for item prices, defaulting the other way** (F-092). `NOT NULL
  DEFAULT false`: an address is information a farmer already supplied for publication, but a price is
  something this system never asked for and no existing stand consented to showing, so opting in is
  the farmer's act. Prices stay stored when it is false — the switch is reversible, not destructive —
  and the public query withholds them in SQL for the same reason the address path does. Admin reads
  them regardless.

  **`retired_at` is VIGA taking a stand down, and it is the only "delete" there is** (F-071). A
  retired location leaves every public surface and refuses publication, but keeps every revision it
  published — the answer to "what did this stand say it had, and when" is exactly what the record
  exists to hold (Golden Rule #1). Erasure is not an alternative that was rejected on taste: nearly
  every reference to a location is `on delete restrict`, so a hard delete fails at the constraint
  for any stand with history.

  It is deliberately **not** `is_public`, which is a listing attribute the farmer's own onboarding
  form writes on every save — an operator decision expressed through that column would be reverted
  the next time the farmer edited their listing. Two actors owning one column is the failure this
  separation prevents. `retired_at` and `retired_by_administrator_id` move together, enforced by a
  CHECK stated as a full disjunction so the NULL case cannot pass silently.

  **`farms.retired_at` is the same act one level up** (F-100): VIGA taking a whole farm down, for
  the same reasons and with the same paired-actor CHECK. `farms` is referenced `on delete restrict`
  by eight tables, so erasure is unavailable there too.

  It deliberately **does not write each stand's own `retired_at`.** Readers treat a stand under a
  retired farm as off the map — "is this stand served?" is the farm's state OR the stand's — but the
  stand's column stays untouched, so restoring the farm returns exactly the stands it was holding
  down while a stand retired on its own stays retired. Writing through would collapse two
  independent decisions into one and leave restore guessing which stands to bring back.

  **`farms.test_farm_at` is the same rule applied a second time** (F-074): a farm VIGA marked as
  fake so the whole journey can be walked against real production without an islander seeing it.
  It is on **`farms`**, not `sales_locations`, because the intent is "this whole farm is fake" —
  one decision covering every stand it has. It is its own column for exactly the `retired_at`
  reason, and a test asserts a real listing save does not clear it. It pairs with
  `test_farm_by_administrator_id` under the same full-disjunction CHECK.

  **It decides presence, never presentation.** A test farm is *absent* from the map, from both
  halves of SMS retrieval, and from the grandfathered farm picker — there is no label, no badge,
  and nothing added to the wire format (max, 2026-08-06: test farm names already read as fake).
  All four readers compose **one** predicate, `visibleFarms`, for the reason `NO_LIVE_FARMER`
  exists: four copies of a visibility rule is four chances to miss one.

  **It is an operator fact about a fake farm, never a privacy control for a real one.** The web
  half of "deliberate viewer" is `?hidden=true`, a guessable query parameter rather than a
  credential, so it hides nothing from anyone determined to look. A farmer who does not want her
  address published sets **`address_public = false`** (F-088) — a fact about the listing, which is
  a different kind of thing entirely. It was `contact_only` until F-088 separated the two: that
  value now says only *"there is no stand to visit"*, and no longer implies an unpublished address
  or an absent pin.
- **farmer contacts and authorization** — who may act for a farm, and proof they control the phone
  number. **VIGA always grants this**, because a phone proves possession of a phone and not
  ownership of a farm: the only writer is administrator-gated, re-reads the administrator's
  authority inside its own transaction, and records who acted. Revocation updates the row rather
  than deleting it — published revisions reference the authorization they were made under.
- **farm email roster** (F-078) — the addresses VIGA already holds for each farm, so a farmer can
  prove who they are without a volunteer vouching. **Answers exactly one question** — "is this
  address on file for this farm?" — and holds no name, role, or preferences; it must never become
  a contact list. Several rows per farm is normal (five of VIGA's farms list more than one).
  **Verifying is not publishing**: farms that declined to put contact email on the printed map
  still authenticate, and no public read path selects from this table.
- **farm email verifications** (F-079) — an issued verification code, and the publish grant
  redeeming it produces. Both are **hashed at rest**; the code itself exists only in the farmer's
  inbox. Carries the address **hash** and never a second copy of the address. Six digits is a
  small space, so what makes it safe is that guesses are **counted and capped** — the row holds
  its own attempt count, and issuance is throttled per farm and per address from these rows,
  because a coarse client bucket cannot see someone rotating their signal to bury one inbox.
  **A grant confers listing-publish rights and nothing else** — never farmer authorization, which
  still requires an inbound text from a consented handset. One live code per farm is a database
  guarantee (a partial unique index), and redemption commits **exactly once**.
- **farmer onboarding requests** (F-040) — what a farmer *asked* for, waiting for VIGA. **Grants
  nothing, and is shaped so it cannot**: a plain SMS request has no farm, no grant column, no
  message text, and nothing reads it as authority. An administrator-created invite may attach an
  opaque invitation reference so the queue can suggest the selected farm; that reference remains
  inert. It is the one record on this list writable from an unauthenticated inbound SMS, which is
  why it holds only "this phone asked, at this time" plus the optional invite reference. One open
  request per phone; settled requests stay as history and record which administrator answered them.
- **farmer invitations** — an administrator-created, one-use, seven-day onboarding link that may
  be bound to an existing farm or left unbound for a new farm. Only the token hash is stored.
  Sharing happens through the administrator's own text or email app, so the application does not
  invent an email provider or bypass SMS consent. A redeemed, farm-bound invitation records its
  farm on the onboarding request; an unbound invitation leaves that decision for the queue. Both
  still grant nothing until VIGA authorizes the farmer.

  `agreed_to_sms_at` records when the invited farmer accepted the SMS agreement on the onboarding
  page — **where the agreement was shown, not consent itself**. It is stamped once and keeps the
  first time (a farmer who reloads and re-ticks has not agreed twice), a CHECK constraint forbids it
  predating the invitation, and NULL means the box was never ticked, in which case the resulting
  redemption establishes no consent. Anyone holding the link can set it, which is exactly why it
  cannot be the consent write; see §privacy, Consent.
- **farmer standing links** (F-040, hardened by B-031) — a durable key letting a farmer reach *their own* listing form
  in a browser, with no password and no session. Only the **hash** of the token is stored, as with
  a session token. A link is a **pointer to an authorization, never authority itself**: resolution
  re-reads both the link's and the authorization's revocation columns on every request, so there is
  no cached "active" flag and no signed claim that could keep saying "valid" after the authority
  behind it was withdrawn. Every link binds one exact owner+location pair; the duplicated owner id
  exists only so composite foreign keys can prove that both the authorization and location belong
  to the same farm. The link does not expire, so
  **revocation is the entire safety net** — which is why nothing about it may be cached. One live
  link per authorization: re-issuing replaces rather than accumulates.
- **farmer SMS target context** (F-051) — one selected authorization+owner+location tuple per
  sender, plus at most one 12-hour numbered menu whose options bind exact tuples. Selection is
  convenience, never authority: every use revalidates live authorization and location.
- **inventory-prompt preferences** (F-052, F-081) — at most one cadence and designated
  authorization per stand: every 2 days, weekly, every 2 weeks, or paused. A stand **starts at
  `weekly`** when its farmer is set up (F-081), and the farmer changes or pauses it from settings
  or by texting `SETTINGS`. Seeding is **first-write only** — `on conflict do nothing` against the
  per-location unique index — so a farmer's own choice, including `paused`, is never overwritten
  by a later edit. **No historical behavior, corpus statistic, or migration ever creates or infers
  a preference**: the default is a stated product decision, never a guess derived from what a
  farmer did before. A stand with no farmer gets no preference rather than a guessed recipient.
  Version, next due time, and last due slot let code invalidate stale work and advance to one slot
  without a catch-up burst.
- **VIGA approval** — recorded **separately** from onboarding completion, and it is what lets a farm
  publish inventory. Approval and revocation record **which administrator acted, when anyone did**,
  and when: the administrator is nullable, because the honour-system door has none to name and
  crediting one who never acted would be a convenient lie. Revocation updates the row rather than
  deleting it, and is the backstop for any approval nobody granted; published revisions reference
  the approval they were made under.
- **administrator and sessions** (F-056) — the only admitted identity is
  `board@vigavashon.org`. The password verifier is a web-only secret, never a database value. A
  session is a durable row holding only the **hash** of its token, so a database read cannot recover
  a live credential; authority is re-read per request so revocation is immediate. Sessions carry no
  personal data beyond the administrator foreign key.
- **administrator login-failure budgets** — durable account-wide and coarse-client rows carry only
  salted 64-hex bucket hashes, positive counts, and window timestamps. No raw network address,
  email, password, or verifier enters the table. The existing bounded retention pass deletes
  expired rows.
- **structured public listing facts** — including payment methods and VIGA Farm Bucks acceptance or
  eligibility, plus the farm's own prose description, farmer-selected
  web/social links, and an optional photo or short biography. Direct farmer email addresses and
  phone numbers never enter the public description.
  **`farms.description` is farmer-writable as of 2026-08-07** and was seeded-only before, so VIGA's
  prose sat under every listing a farmer published with no surface able to change it. Every listing
  door now carries it, and the writer distinguishes **`undefined`** ("this door states nothing about
  the prose", leave it) from **`""`** ("the farmer cleared it", erase it) — collapsing the two is
  B-037's destructive-by-omission failure one column over. A fact that has a **structured column of
  its own never belongs in this prose**: the two then disagree on the same card, which is what
  F-061's `buildStandDescription` exists to prevent.
  **Payment methods are canonicalized to a closed set** (F-069, `packages/db/src/payment-methods.ts`)
  so "venmo", "Venmo" and "VENMO" are one filterable value rather than three a filter cannot join.
  Methods outside the set are kept as the farmer's **own words** — a closed set that silently
  dropped what it did not recognize would lose a real fact. This is a *spelling* table and must stay
  one: unlike produce, payment methods are a small VIGA-known set, which is why folding them is
  correct here and folding food vocabulary is forbidden. **VIGA Farm Bucks remains separate from
  payment methods** — `canonicalPaymentMethods` recognizes its spellings and then **drops** them
  rather than storing a method row (B-054), so ingest, onboarding's free-text box and any backfill
  are all closed at one seam. It never sets the boolean either: a farmer typing "farm bucks" into a
  text box must not award themselves an acceptance VIGA never reviewed. The two columns record two
  different people's facts:
  `farm_bucks_accepted` is the **farmer's** claim about their own stand, stated on the listing form
  and published on their word; `farm_bucks_eligible` is **VIGA's** own decision, set in admin and
  read by the admin surfaces. **Neither constrains the other** (max, 2026-08-10). The
  acceptance-requires-eligibility CHECK was dropped in `0037` along with the writer guard that
  pre-empted it: eligibility lives on a stand row that does not exist until onboarding saves, so
  gating the farmer's claim on it made the toggle unreachable for every new farm — which is every
  farm the onboarding form exists for.
- **structured availability** (F-035) — season, days of week, time of day, and restocking cadence as
  **queryable columns rather than prose**, so "what is open right now" is a filter and not a text
  scan. Kinds that are not clock times (`dawn_to_dusk`, `daylight_hours`) and cadences that are not
  schedules (`variable`, `as_needed`) are **first-class enum values, not missing data** — on an
  unattended honor-system stand they are the truthful answer, and a clock time would invent
  precision the farmer never stated. The farmer's own wording is kept verbatim beside them as
  **display-only text that is never filtered on**, so a caveat like "Saturday and Sunday when
  available" survives without the structured fields overstating it. `year_round` is distinct from an
  absent season: "always open" and "never recorded" are different facts.
  **Written by the onboarding form since F-069** — before it, the seeder was these columns' only
  writer, so a farmer who onboarded through the form got prose and NULLs in every filterable column.
  The form's pickers branch to match the five CHECK constraints, and `coherentAvailability`
  (`packages/db/src/listing-availability.ts`) mirrors them in memory so a contradictory answer
  reaches the farmer as a fixable message rather than as a constraint violation.
- **stand items** (F-066) — the **one vocabulary a stand talks about its own goods in**. "Eggs" is
  one record per location, and the two things anyone can say about it are **independent states, not
  separate lists**: *does this stand usually carry it*, and *was it confirmed present on a date*.
  Either, both, or neither may hold. A stand's item is created by whichever surface first names it
  and outlives both states — removing eggs from the usual mix clears that state and leaves the
  record standing with its confirmation history intact, because an item that stopped being a
  standing claim did not stop having been confirmed in June.

  **The states stay structurally apart even though the vocabulary is shared**, and this is the part
  that is load-bearing: a standing claim is a property of the farm, true in March and in September,
  dated by nothing; a confirmation is a statement about what is out *right now*, always dated and
  always attributed by `source`. The standing state carries no confirmation time, can never occupy
  the one-current-per-location slot that means "the freshest thing anyone has said about this
  stand", and must never be rendered as current availability. **Read by the public listing** (F-042)
  as a field of its own, never merged into the confirmed items, and rendered under a heading that
  takes no timestamp — the "no confirmation time" property has to survive all the way to the screen
  to mean anything.

  **A standing item may carry an optional STRUCTURED price** (F-092) — four columns that render as
  one sentence: `price_amount` and `price_quantity` (`numeric(10,2)`, never floating point),
  `price_unit` (the farmer's own word, free text), and `price_basis` (`per` | `for`). "$6 / dozen"
  and "3 lb for $5" are the same four facts with a different joining word, and `per` is the bundle
  with an implied count of one — one mechanism, so a third kind of price is a third `basis` value
  rather than a fifth column. `renderStandItemPrice` in core is the **only** thing that turns parts
  into words; every surface calls it.

  A price is stated or it is not — `stand_items_price_complete` refuses anything between, because
  half a price renders as garbage. NULL across all four is *not stated*; **an amount of `0` is
  FREE**, which is a claim rather than its absence. A price is a standing claim exactly like the
  item it belongs to and carries no date.

  **The unit is the one part a stated price may omit, and only for `for`** (B-041). A bundle carries
  its own count, so "$5 for 3" is complete with the item itself as the unit — what a corn stand
  letters on its sign. A unit price has no count to lean on: "$6 / " is not a sentence, so `per`
  must name what the amount is per. `stand_items_price_basis_unit` (migration `0033`) is that
  asymmetry at the database; `standItemPriceNeedsUnit` in core is the copy every other layer —
  the renderer and both boundary parsers — imports rather than restates. A unitless bundle of one
  reads **"$5 each"** (max's call, 2026-08-08).

  This **replaced** a free-text `price_text` (F-090, migration `0030`) whose own reasoning argued for
  free text and was right about roadside signs. The corpus settled it: 285 stands in VIGA's export
  hold one dollar sign, and it is a delivery threshold. Nothing was migrated because nothing existed.

  **`inventory_entries.price_text` is still free text** and is a different fact — a price on today's
  confirmed stock, dated, belonging to the statement rather than to the item. Onboarding writes it by
  rendering the structured price into that column.

  **Whether any price REACHES a customer is `sales_locations.prices_public`**, not these columns —
  the same display-only shape as `address_public`, and `false` by default because a price is
  something this system never asked for before. Hidden means hidden: the values stay stored so the
  switch is reversible, and the public query withholds them **in SQL**, so a withheld price never
  leaves the database for a later reader to leak.

  **Item names are the farmer's own words** ("plant starts", "Gailan"), per-stand and
  farmer-authored. There is no shared produce taxonomy, no global food ontology, and no vocabulary
  any behavioral branch may reason about. Two stands that both sell eggs share nothing.

  **Only the farmer's web form writes the standing state; SMS writes only confirmations** (max,
  2026-08-05). A text message is always a dated statement about right now and can never alter a
  standing claim — so an SMS-confirmed item outside the usual mix is confirmed and nothing more:
  no prompt to adopt it, no automatic add. A farmer changing their core set texts `SETTINGS` and
  edits the form, where their confirmed items and their usual mix appear on one screen, which is
  the one place the two can be seen to have drifted and the one place drift can be fixed. This
  keeps the SMS surface to a single job and puts the deterministic-routing line at the data layer:
  no inbound message, however interpreted, reaches a standing fact.

  **That writer now exists** (F-067, 2026-08-05): `saveOnboardingListing`, behind the onboarding
  form. Until it landed the seeder was the only thing that had ever written `usually_carried`, so
  the rule above was a contract with nothing on the farmer's side of it — and the criterion "SMS
  cannot write standing state" was unprovable, there being no farmer-facing writer to separate SMS
  from. Verified by effect: a farmer submitting the form writes `stand_items` rows and **zero**
  inventory revisions.

  A shared vocabulary is also what **removes the reconciliation the view currently performs**.
  `standListingLines` case-folds and subtracts confirmed items from the usual list so nothing
  prints under both headings; `sellsMatch` case-folds both lists into one search haystack;
  `isFlowerOnlyStand` classifies a whole stand from the usual list alone. Each carries a comment
  that nothing normalizes casing between the two — independent workarounds for a join the data
  model did not have.

  What goes is the **case-folding**, not the subtraction. A card still shows a confirmed item
  under one heading and the rest of the usual mix under another, so one list is still subtracted
  from the other — but as a plain set difference over identical strings, because the reader
  resolves a confirmed item to its stand item's spelling before the view sees it. The reader
  deliberately does **not** case-fold as a safety net: if the two ever stop being one vocabulary,
  the duplicate must show rather than be papered over.
- **stand data flags** (F-035) — where a contradiction in seeded source data waits for a human.
  Distinct from the customer-message `flags` table, which is keyed to a contact and an inbox event a
  seed flag has neither of. One open flag per (location, reason); resolved flags stay as history.
- **inventory revisions and inventory entries** — a revision is an immutable published version of a
  location's inventory; entries are the items in it, with quantity/unit/price text or an
  approximate label. Revisions have no draft state. Every revision declares its **`source`**
  (F-063, F-090), and a database CHECK makes the three shapes mutually exclusive:

  - **`sms`** requires the full handset chain — `proposal_id`,
    `published_by_authorization_id`, `farm_approval_id` — so what was previously convention is
    now enforced. The proposal carries the token the farmer texted back.
  - **`web`** (F-090) requires an authorization and an approval and **no proposal**. This is
    stock a farmer stated on the onboarding form, published when their `START` proved the
    handset. As strong as `sms` on who stands behind the claim; it lacks only the confirmation
    exchange, which genuinely never happened. Recording it as `sms` would have required
    inventing a consumed token and a consumption event naming a message nobody sent — the exact
    fabrication this constraint exists to refuse.
  - **`viga`** requires all three to be **NULL**, which is how VIGA's own records (the launch
    import, the weekly stock form, a later admin edit) are recorded without fabricating an
    attestation about an identifiable person.

  Written as one biconditional over all four columns rather than per-column rules, because a
  CHECK *passes* on NULL. **The enum is recreated rather than extended** when a value is added:
  PostgreSQL cannot use a newly added enum value in the transaction that added it, and the
  migrator runs every pending migration in one — `ALTER TYPE … ADD VALUE` applies cleanly and
  then fails on first use, on a fresh database (0001 records the same lesson).

  An entry **resolves to its stand item by the normalized name it already carries** (F-066), and
  the entries table is **not modified at all**. There is deliberately no `stand_item_id` column:
  `inventory_entries_guard_history` raises on *every* update with no permitted shape, so
  backfilling a reference onto published rows would mean disabling the immutability guarantee
  inside a migration — which would establish that the guarantee is switchable. It is also
  unnecessary. An entry belongs to a stand and holds the farmer's words, so
  `(sales_location_id, normalized item_name)` resolves it through the same key the unique index
  enforces. The product has **no rename** — a farmer edits the mix by removing and adding words,
  never by declaring one thing is now called another — so the two can never drift apart. Entries
  keep their own quantity/unit/price text, which belongs to the dated statement, not to the item.
- **closure revisions** (F-049) — append-only owner-confirmed close/reopen history, separate from
  inventory. A close carries `temporary` or `seasonal` plus a Vashon-local start date; temporary may
  carry an inclusive end date. Reopen carries no kind or dates. Composite foreign keys bind the
  location, authorization, and approval to the same owner farm. One current instruction per
  location and one revision per proposal are database constraints; bounded expiry is computed by
  the canonical reader and never rewrites these rows.
- **sales-location participants** (F-050) — owner-confirmed public display names for other sellers
  at a location, separate from both ownership and inventory. Names are unlinked plain text: code
  does no farm/profile/alias matching, the owner is not inserted automatically, and inventory
  entries carry no participant or seller provenance. Retirement records the owner authorization
  and time without deleting history. The public reader returns active names under **Also selling
  here**, separately from the single aggregate inventory list.
- **customer stock-out reports** — private; each carries a required sales-location identifier bound
  by the web/QR reporting surface, and may reference a listed entry or name an unlisted item. A
  model does not supply the consequential location identifier.
- **minimized SMS inbox and message records** with limited retention — unique provider event/message
  identifiers, event type and `occurred_at`, sender/contact reference, TTL-bound body where needed,
  processing state, and per-sender conversation watermark/claim. The raw provider envelope is not a
  durable record.
- **launch-program SMS consent and universal STOP** — one current launch consent state per
  recipient, provenance for how, when, and where consent was captured, and a separate provider-time
  STOP/START transition watermark. Launch has no program discriminator or future-program enrollment
  rows. `sms_consents` is keyed by `recipient_hash` alone, so a second enrollment for the same
  recipient is not representable; `consent_capture_source` is bounded to `join` / `start` /
  `farmer_onboarding`, all of which establish the same one program (F-016).
- **outbox message category** — `outbox_work.message_category` is a bounded enum naming which
  launch category a queued message is, and it is the typed input to the dispatch consent gate. It
  replaces the former free-text `message_kind` plus `is_required` boolean, which were two
  overlapping ways to say one thing and could not express a direct reply that is permitted by the
  recipient's own message without being carrier-required.
- **one open farmer-update confirmation per sender** — target sales location, explicit inventory
  and closure section-presence flags, an independent base binding for each included section,
  structured complete payload/version, provider-accepted prompt
  activation, expiry, and consumption state. Existing inventory entries retain their opaque
  reference IDs in that payload; code issues opaque draft IDs for new entries so later unconfirmed
  edits can target them. This is neither an inventory nor a closure revision.
- **scheduled inventory-prompt subjects** (F-052) — the exact durable meaning of a queued prompt:
  proposal and version, preference and version, designated authorization, owner and location,
  inventory and closure bases, due slot, outbox row, and whether the complete visible snapshot made
  `SAME` safe to offer. It stores no inferred meaning from message text; dispatch joins this typed
  row and revalidates it. `SAME` publishes an ordinary identical inventory revision, so
  `published_at` remains the one recency fact.
- **one pending result list per sender** (F-046) — the ordered fact identifiers a customer's last
  answer selected, the product words it was about, how far through them they have read, and an
  expiry. `MORE` **replays** this list rather than re-running retrieval, so paging is consistent
  and costs no model call; the accepted tradeoff is that stock confirmed mid-paging waits for the
  next question, which the expiry bounds. **One row per sender**, replaced by each new question, so
  `MORE` is never ambiguous about which list it means.
  It stores **no message body and no rendered reply text**: the customer's question is untrusted
  inbound text with a short retention life of its own, and copying it here would create a second,
  longer-lived home for it. The requested items are the narrow exception — the product words the
  interpretation seam extracted, not the sender's sentence — because a later page must name its
  subject to read as an answer.
- **flags and admin dispositions.**
- **transactional outbox.**
- **minimal audit and model-run evidence.**

## Constraints the database must enforce

These are **database-level** requirements, not application conventions:

- **Unique provider-event processing** — a provider event ID is accepted once. Retry or duplicate
  delivery cannot produce another state transition, model call consequence, publication, or outbox
  entry.
- **One ordinary stateful claim per sender** — concurrent workers cannot claim overlapping
  conversation work for one sender. An abandoned claim is recovered on the same inbox row.
- **An abandoned dispatch authorization is recoverable and resolves as ambiguous** — outbound work
  authorized but never resolved carries `dispatch_authorized_at`, and past a fixed lease it becomes
  `ambiguous` rather than being retried or left `dispatching` forever. It is never returned to
  `queued`: the provider may already have delivered the message (GL-003).
- **One address per (farm, normalized address)** (F-078) — the roster ingest is re-run whenever
  VIGA re-exports, so a duplicate must be impossible rather than merely unlikely. The index
  normalizes case and the **explicitly named** whitespace class `E' \t\r\n'`, because
  `btrim(text)` strips spaces alone — migration 0020 shipped that naive form. Scoped to the farm,
  not global: one couple farming two plots from one inbox is real. What must never happen — one
  address verifying the **wrong** farm — is enforced by scoping the query, not by this index.
- **One live verification code per farm** (F-079) — a partial unique index over unconsumed rows.
  Two live codes would mean the older one still opens the listing while the farmer types the
  newer, so "one open confirmation" would be a fiction. `select`-then-`insert` cannot serialize a
  row that does not exist yet, so the **index is the arbiter**: issuance is `on conflict do
  nothing` and an empty result means someone else won.
- **A verification code is consumed exactly once** (F-079) — redemption is a conditional UPDATE
  on `consumed_at is null`, which both commits and decides the race; the grant is minted in the
  **same statement**, so a spent code can never leave the farmer with nothing.
- **Every stored hash is a 64-character lowercase hex digest** — asserted by CHECK on the phone,
  email, code, and grant columns. A malformed hash is a row nothing can ever look up, and the
  miss would be silent: the farmer's correct value would simply never match.
- **One open farmer-update confirmation per sender** — a partial uniqueness constraint prevents
  overlapping proposals from making generic `YES`/`NO` ambiguous. `NO` and expiry create no
  revision; `YES` creates every included immutable section or neither only after the transaction
  rechecks the current prompt/version, independent bases, owner authority, and VIGA approval.
- **One currently published inventory revision per sales location** — "which revision is current"
  is a constraint, not a fragile `max(published_at)`.
- **One item per stand per name** (F-066) — a unique index over the location and the normalized
  name is what makes "eggs exists once here" structural rather than a convention the readers
  case-fold their way around. Normalization is **case and surrounding whitespace only**: it exists
  so `Eggs` and `eggs` are one item, and it must never fold singulars into plurals or synonyms into
  each other, which would be a produce taxonomy wearing a different hat. The farmer's own casing is
  kept for display beside the normalized key.

  That index is also the **first-insert arbiter** when two confirmations name the same new item at
  once — `insert … on conflict do nothing returning …`, an empty result meaning another writer won
  and the existing row is read. A row lock cannot serialize a row that does not exist yet, and the
  two confirmations do not share a parent row to lock. Same rule F-050 already relies on.
- **An item's standing state is unreachable from the SMS path** (F-066) — enforced by which code
  holds the capability to write it, not by a column a message handler could set. The inbound
  message path can create an item and confirm it; only the farmer's authenticated web form can
  make it a standing claim. A test that publishes an inventory revision naming an unknown item and
  then asserts the usual mix is unchanged is what proves it.
- **An inventory entry's published words never change** (F-066) — the entries table gained no
  column and no backfill, because its history guard refuses every update unconditionally. Editing
  the usual mix touches item state only. The rendered card resolves a confirmed item to its stand
  item's current spelling so both lists speak one vocabulary; the **published row keeps its own
  words**, which is what makes the confirmation still a record of what was said.
- **One current closure instruction per location and one closure revision per proposal** — partial
  and ordinary unique indexes make both claims structural. CHECK constraints reject malformed
  reopen/close shapes, seasonal end dates, reversed dates, and incoherent current/superseded state;
  each nullable case is tested against real Postgres because a CHECK otherwise passes on NULL.
- **One active normalized participant name per location** (F-050) — a partial unique index is the
  first-insert arbiter; row locks cannot serialize a row that does not exist. Composite foreign
  keys bind the location and confirming/retiring authorization to the same owner. CHECKs reject
  blank names, half-populated retirement state, and retirement before confirmation; deletion and
  mutation of history are refused.
- **Farmer authority over inventory publication** — only an authorized farmer for that location can
  publish, and only an approved farm publishes publicly. Both are re-read while the confirmation
  transaction holds the sender and pending-confirmation locks.
- **One live approval per farm, one fixed administrator identity** — partial unique indexes over
  unrevoked rows, plus a CHECK that refuses every administrator email except
  `board@vigavashon.org`. Revoked administrator rows remain for audit history and authorize nothing.
- **One live authorization per (farm, contact), one open onboarding request per phone, one live
  link per authorization** (F-040) — the same partial-index discipline. The authorization index is
  per *pair*, not per farm: a household where two people both text is ordinary, and refusing the
  second would be a product defect dressed as a constraint. The request index is what stops an
  impatient farmer texting five times from producing five queue entries, and it is the **arbiter**
  rather than a read — concurrent inserts would both observe "none open", and `for update` cannot
  lock a row that does not exist yet, so the writer uses `on conflict do nothing returning`.
- **One coherent farmer target context per sender** (F-051) — selected target columns are all null
  or all populated; menu issue/expiry/purpose are all null or all populated with expiry after
  issue; every option number is positive and unique within the sender's exact menu. Targeted
  standing-link owner/location columns are both null or both populated, with composite foreign
  keys binding both the authorization and location to that owner.
- **One prompt preference per stand and one subject per preference due slot** (F-052) — unique
  constraints make both facts structural. Preference versions are positive; paused rows have no
  next due time; active rows do. Subject versions are positive, owner/location/authorization and
  inventory/closure bases are composite-FK bound, and a subject may offer `SAME` only when an
  inventory base exists. The due-slot unique constraint, not a row lock on a nonexistent subject,
  arbitrates concurrent schedulers.
- **A farmer's standing link resolves through its authorization, every request** (F-040) — the link
  carries no claim and no cached state, so there is nothing that could still resolve after the
  authority behind it was revoked. This is a *shape* requirement rather than a constraint the
  database can express, and it is the reason the never-expiring link is defensible: revocation is
  the only safety net, so it must be impossible to cache around.
- **Administrator authority is re-read at the moment of the write** — approval and revocation check
  the administrator row inside their own transaction, so a revocation that committed after a request
  began still wins. A principal proves who the caller was; only the locked row proves who they are.
- **Universal STOP before dispatch authorization** — a globally stopped recipient cannot claim a
  queued non-required message for dispatch. The atomic outbox claim is the boundary: work claimed
  before STOP may already be in flight and cannot be recalled.
- **Outbox uniqueness and bounded attempts** — business state and one logical outbound item commit
  together. A definitive retryable rejection may create another bounded attempt; a result that may
  have been provider-accepted becomes `ambiguous` and is not automatically resent.
- **Accepted confirmation dispatch and exact proposal activation are atomic** — after the external
  provider call, recording acceptance and opening the named current proposal version's window are
  one transaction. A failure leaves neither a `sent` outbox row nor an activated proposal; an old
  version or non-confirmation category activates nothing.
- **Monotonic provider delivery state** — duplicate or out-of-order delivery events cannot regress a
  terminal result.
- **Bounded valid states and transitions** — states are enumerated and illegal transitions rejected.
- **Separation between private customer reports and published inventory** — a stock-out report can
  **never** write inventory. This must be structural, and proven end-to-end rather than by checking
  that a returned object lacks a property.
- **Bound location before stock-out alerting** — a report capable of queuing a farmer alert must
  reference a valid sales location supplied by the code-bound web/QR surface. Recipient resolution
  follows that location's current farmer authorization in code; no model-produced location or
  recipient identifier is accepted.

## Privacy & retention

- **Phones:** normalized at ingress; the raw E.164 lives in **exactly one column**, read **only** by
  the outbound send path (SMS cannot be sent to a hash); the **hash is the only lookup/log key**.
  Raw numbers are **never logged**, **never enter model context**, and are masked in admin.

  **`administrator_phones` (F-074) does not weaken this, and the reason is worth stating.** It is a
  second table holding phone-derived data, and it deliberately has **no `phone_e164` column at
  all** — asserted against the real schema, not left to this document's word. `contacts` keeps the
  raw number *only* because the sender needs something to send to; nothing on the test-farm path
  ever sends, so a raw column there would be stored personal data with no reader. What it keeps
  beside the hash is the **last four digits**, the same lossy fragment the admin surface already
  shows everywhere (`right(phone_e164, 4)` → `maskPhoneSuffix`), so an operator can tell which row
  to remove. Four digits identify a row to a human being; they do not identify a subscriber.
- **Emails (F-078/F-079):** the same discipline as phones, applied to a second kind of personal
  data — **one instance of one mechanism, not a second mechanism**. VIGA's roster is largely
  *personal* addresses (`dhusch@hotmail.com`), so they carry the same weight. Normalized at
  ingress; the raw address lives in **exactly one column** (`farm_emails.email`), read **only** by
  the send path and the verification lookup; the **hash is the only lookup and log key**. Raw
  addresses are **never logged**, **never enter model context**, and are masked in admin
  (`maskEmail`). `farm_email_verifications` holds the hash and never a second copy of the address.

  Where the two differ, it is because the data differs: a phone has one canonical form derived by
  discarding punctuation, while an address is canonicalized by **case and whitespace only**. The
  whitespace class is named explicitly (`E' \t\r\n'`) to match the unique index, because
  `btrim(text)` strips spaces alone — migration 0020 shipped that naive form.

  **Verifying is not publishing.** Six farms declined to put contact email on the printed map and
  two left it blank; their addresses are still stored and still authenticate. Nothing in
  `farm_emails` is a display column, and no public read path selects from it — a query property
  proven by test against the **served bytes**, since a schema cannot enforce it.
- **The F-079 farmer-start secret is OBSCURITY, not authentication, and must be documented as
  such.** `FARMER_START_SECRET` is a path segment, so it lands in browser history, `Referer`
  headers on any outbound link, access logs, and any proxy in between. Unlike `/stand/[token]` it
  is **neither one-use nor revocable per farmer** — it is one shared value for everyone VIGA sends
  it to. It therefore protects nothing on its own: what it buys is that the migration door is not
  crawled or casually walked into. **The credential that actually gates publishing is the emailed
  code**, which is per-farm, single-use, expiring, attempt-capped, and rate-limited by farm and by
  address. A deployment with no secret configured has no door at all, and answers every request
  under `/farmer/start` with the same 404 it gives a wrong secret.
- **Raw message context is short-lived** and deleted on expiry. A body is written with a **30-day**
  `body_expires_at` (`DEFAULT_BODY_TTL_MS`); the scheduled retention purge clears it once that
  instant passes. Only the body text goes — the `sms_messages` row, its inbox projection, dispatch
  attempts, flags, and audit events are retained.
- **Messages in a flagged thread stay readable while the flag is open** — flag review needs readable
  threads. The exemption is keyed on `flags.status = 'open'` for any flag on the message's inbox
  event, and it **fails safe**: a body is purged only when the absence of an open flag can be shown,
  because over-retention is recoverable and destroying evidence under an open safety review is not.
  Resolution makes the body immediately eligible; there is **no** bounded grace period after
  resolution, since no consumer needs one and an unowned window would be speculative state.
  **F-030 built the resolution path**: `disposeFlag` moves a flag to `resolved` or `dismissed`, and
  either one ends the exemption, so the next purge pass clears that thread's expired bodies. Proven
  end to end in `packages/db/src/review.integration.test.ts` — including that a *dismissed* thread
  purges, which is what a drift from `= 'open'` to `<> 'resolved'` would break.
- **The purge never races live delivery.** Outbound bodies are cleared only in a terminal state
  (`sent`/`failed`/`ambiguous`/`suppressed`), because the dispatcher reads `outbox_work.body` to
  send it. It reports **counts only** — never a body, an identifier, or a phone.
- **Only selected preference and safety records survive raw-context expiration.** Farm Friend may
  retain lightweight facts such as foods requested or preferred stands; it must not accumulate a
  rich personal profile, and **precise durable home addresses are not part of a customer profile**.
- **Browser origins are transient.** Optional browser geolocation may be used to calculate
  approximate proximity to validated public sales-location coordinates; it is not stored, logged,
  sent to the model, or retained as a customer preference.
- **Model inputs are task-specific projections, not records or transcripts.** A seam receives only
  its current task text, permitted public facts, and opaque identifiers as specified in
  `AI_ARCHITECTURE.md`; it receives no other actor's message, unrelated thread history, raw contact
  data, authentication/consent state, admin/audit rows, internal notes, or secrets. Model-authored
  prose may return only to the actor whose current task text supplied that context. Cross-actor
  messages are code-rendered without relaying customer free text.
- **The configured model provider passes a privacy gate.** It must not train on Farm Friend
  requests/responses; calls are stateless with no provider-managed conversation, file, memory, or
  retrieval store; request/response logging is disabled where supported; and any unavoidable
  provider retention has an approved documented maximum compatible with Farm Friend's raw-context
  retention.
- **Public listings expose** stand addresses and farmer-selected links from their code-owned listing
  fields. Model-writable public strings are validated together at publication and the whole write is
  refused — never sanitized — when they contain phone numbers, email addresses, web links, or
  direct-contact instructions. **Direct farmer contact is never public.**
- **Consent:** active launch-program consent gates every proactive non-required SMS. `START`
  establishes **or restores** it with provenance; `JOIN` and documented farmer onboarding establish
  it only for a sender with **no** consent record, because the carrier's own opt-out list is cleared
  by `START` alone (B-011, docs/SMS_COMPLIANCE.md). Onboarding is therefore never a way back in
  after an opt-out — a farmer who texted `STOP` and later completes a web form is not re-enrolled. A customer-initiated inquiry
  permits its relevant direct response but creates no durable consent for later proactive
  notifications. `STOP` clears launch consent immediately and applies across all Farm Friend
  messaging. STOP/START transitions are ordered separately from conversation state by provider
  occurrence time, with STOP winning an exact timestamp tie. A future program gets separate
  enrollment only when built; launch stores no future-program state. **Active** consent is
  required — an absent consent row is not permission, and the gate that once asked only "has this
  recipient STOPped?" was a real defect fixed in F-016.
- **Pending confirmations are GC'd on expiry.** A confirmation is live only after its current prompt
  is provider-accepted; a token that predates that activation or names no live proposal commits
  nothing.
- **Raw webhook bytes are ephemeral.** They are used to verify the Telnyx signature and then
  discarded after the minimized inbox projection commits; the raw envelope is never logged or
  retained.
- **Flags and audit rows are retained.**

## Model-run evidence — what it MAY store (never the model input)

The audit row must be **debuggable without becoming a PII leak**. It stores **no raw or stripped
model input** and no output content that could carry PII. It **MAY** store:

- the **seam** name;
- the **provider** and **model** id;
- the **schema version** the output was validated against;
- the **validation status** (passed / repaired-then-passed / rejected) and repair count;
- an **opaque id set or hashes** linking to the durable rows involved (not their contents);
- timing and cost metadata.

To debug *content*, reproduce from the durable source rows through the assembler — this row is a
provenance/telemetry record, not a transcript.

**Verified against the schema (F-026):** `model_runs` carries exactly these columns and no other —
nothing holding a prompt, a completion, or a transcript. The list and the table agree, so the
retention purge has nothing to reach here. `retention.integration.test.ts` asserts the column set
and fails if a content-bearing column is ever added.
