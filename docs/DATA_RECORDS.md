# Farm Friend — Durable Records

The record-by-record catalogue: every durable record Farm Friend keeps, what it is for, and the rules
that govern it. **Look one up when you touch it** — this is a reference, not a cold-start read.

The surrounding data contract lives in [DATA_ARCHITECTURE.md](DATA_ARCHITECTURE.md): scope discipline,
the constraints the database enforces, privacy and retention, and the model-run MAY-store list. That
doc owns the *rules*; this one owns the *inventory*.

> No build status — that lives in [CURRENT_STATE.md](CURRENT_STATE.md). **A record described here is a
> claim until a test can fail on it**; see DATA_ARCHITECTURE's note on the real-Postgres harness.

## farms and sales locations

The farm and its stands or sales points. A location's `owner_farm_id` is the farm authorized to
govern address, hours, closure, and visibility; owner authority is not seller participation. Each
location carries one reviewed timezone used for local scheduled work; launch permits only
`America/Los_Angeles`.

**A location is complete or absent, and any farm may have one** (F-088, narrowing F-038).
`sales_locations_coherent_visitability` requires an address *and* both coordinates together — half a
pair puts a pin in the ocean, and a point with no address cannot be checked by anyone. Only the
`visitable` branch still names `visitability`, forbidding a stand that claims visitors with nowhere to
send them. A `contact_only` farm may be fully placed; **whether a farm is a destination is a rendering
decision, not a storage one**, and the guarantee that nobody is routed to a farm with nothing to buy
lives in `buildMapView` (no directions link for `contact_only`).

**Two display-only switches, same shape, opposite defaults.** Both govern whether a stored fact
*renders*; neither deletes anything, and both withhold **in SQL** so a hidden value never leaves the
database. Admin reads both regardless — support work needs them.

| Column | Default | Why that default |
|---|---|---|
| `address_public` (F-088) | `NOT NULL DEFAULT true` | every row predating it holds an address a farmer typed into a public listing form |
| `prices_public` (F-092) | `NOT NULL DEFAULT false` | a price is something this system never asked for and no existing stand consented to showing, so opting in is the farmer's act |

`address_public` governs the address **TEXT, never the pin**.

**`retired_at` is VIGA taking a stand down, and it is the only "delete" there is** (F-071). A retired
location leaves every public surface and refuses publication, but keeps every revision it published —
the answer to "what did this stand say it had, and when" is exactly what the record exists to hold
(Golden Rule #1). Erasure is not an alternative that was rejected on taste: nearly every reference to
a location is `on delete restrict`, so a hard delete fails at the constraint for any stand with
history.

It is deliberately **not** `is_public`, which is a listing attribute the farmer's own onboarding form
writes on every save — an operator decision expressed through that column would be reverted the next
time the farmer edited their listing. **Two actors owning one column is the failure this separation
prevents.** `retired_at` and `retired_by_administrator_id` move together, enforced by a CHECK stated
as a full disjunction so the NULL case cannot pass silently.

**`farms.retired_at` is the same act one level up** (F-100): VIGA taking a whole farm down, with the
same paired-actor CHECK. `farms` is referenced `on delete restrict` by eight tables, so erasure is
unavailable there too. It deliberately **does not write each stand's own `retired_at`.** Readers treat
a stand under a retired farm as off the map — "is this stand served?" is the farm's state OR the
stand's — but the stand's column stays untouched, so restoring the farm returns exactly the stands it
was holding down while a stand retired on its own stays retired.

**That OR is enforced in two places, and both are load-bearing** (B-066, which found it enforced in
neither). Read surfaces get it from `visibleFarms`, the fragment the map, both SMS retrieval queries
and the public pickers already compose — the farm clause is unconditional there, because
`?hidden=true` and a listed sender hash grant deliberate sight of *fake* farms, never of a real farm
VIGA removed. Publication gets its own locked check inside `confirmInventoryPublication`, beside the
approval it sits with, returning `farm_retired`. Filtering only the stand's column leaves a removed
farm on the map, reachable by text, and still publishing.

**`farms.test_farm_at` is the same rule applied a second time** (F-074): a farm VIGA marked as fake so
the whole journey can be walked against real production without an islander seeing it. It is on
**`farms`**, not `sales_locations`, because the intent is "this whole farm is fake" — one decision
covering every stand it has. It pairs with `test_farm_by_administrator_id` under the same
full-disjunction CHECK, and a test asserts a real listing save does not clear it.

**It decides presence, never presentation.** A test farm is *absent* from the map, from both halves of
SMS retrieval, and from the grandfathered farm picker — no label, no badge, nothing added to the wire
format. All four readers compose **one** predicate, `visibleFarms`, because four copies of a
visibility rule is four chances to miss one.

**It is an operator fact about a fake farm, never a privacy control for a real one.** The web half of
"deliberate viewer" is `?hidden=true`, a guessable query parameter rather than a credential, so it
hides nothing from anyone determined to look. A farmer who does not want her address published sets
**`address_public = false`** (F-088) — a fact about the listing, which is a different kind of thing
entirely. `contact_only` now says only *"there is no stand to visit"*, and no longer implies an
unpublished address or an absent pin.

## Farmer identity, access, and invitation

- **farmer contacts and authorization** — who may act for a farm, and proof they control the phone
  number. **VIGA always grants this**, because a phone proves possession of a phone and not ownership
  of a farm: the only writer is administrator-gated, re-reads the administrator's authority inside its
  own transaction, and records who acted. Revocation updates the row rather than deleting it —
  published revisions reference the authorization they were made under.
- **farm email roster** (F-078) — the addresses VIGA already holds for each farm, so a farmer can
  prove who they are without a volunteer vouching. **Answers exactly one question** — "is this address
  on file for this farm?" — and holds no name, role, or preferences; it must never become a contact
  list. Several rows per farm is normal. **Verifying is not publishing**: farms that declined to put
  contact email on the printed map still authenticate, and no public read path selects from this table.
- **farm email verifications** (F-079) — an issued verification code, and the publish grant redeeming
  it. Both are **hashed at rest**; the code itself exists only in the farmer's inbox. Carries the
  address **hash** and never a second copy of the address. Six digits is a small space, so what makes
  it safe is that guesses are **counted and capped** — the row holds its own attempt count, and
  issuance is throttled per farm and per address from these rows, because a coarse client bucket
  cannot see someone rotating their signal to bury one inbox. **A grant confers listing-publish rights
  and nothing else** — never farmer authorization, which still requires an inbound text from a
  consented handset. One live code per farm is a database guarantee (a partial unique index), and
  redemption commits **exactly once**.
- **farmer onboarding requests** (F-040) — what a farmer *asked* for, waiting for VIGA. **Grants
  nothing, and is shaped so it cannot**: a plain SMS request has no farm, no grant column, no message
  text, and nothing reads it as authority. An administrator-created invite may attach an opaque
  invitation reference so the queue can suggest the selected farm; that reference remains inert. It is
  the one record on this list writable from an unauthenticated inbound SMS, which is why it holds only
  "this phone asked, at this time" plus the optional invite reference. One open request per phone;
  settled requests stay as history and record which administrator answered them.
- **farmer invitations** — an administrator-created, one-use, seven-day onboarding link, bound to an
  existing farm or left unbound for a new one. Only the token hash is stored. Sharing happens through
  the administrator's own text or email app, so the application does not invent an email provider or
  bypass SMS consent. A redeemed farm-bound invitation records its farm on the onboarding request; an
  unbound one leaves that decision for the queue. Both grant nothing until VIGA authorizes the farmer.

  `agreed_to_sms_at` records when the invited farmer accepted the SMS agreement on the onboarding
  page — **where the agreement was shown, not consent itself**. It is stamped once and keeps the first
  time, a CHECK forbids it predating the invitation, and NULL means the box was never ticked, in which
  case the resulting redemption establishes no consent. Anyone holding the link can set it, which is
  exactly why it cannot be the consent write; see §privacy, Consent.
- **farmer standing links** (F-040, hardened by B-031) — a durable key letting a farmer reach *their
  own* listing form in a browser, with no password and no session. Only the **hash** is stored. A link
  is a **pointer to an authorization, never authority itself**: resolution re-reads both the link's
  and the authorization's revocation columns on every request, so there is no cached "active" flag and
  no signed claim that could keep saying "valid" after the authority behind it was withdrawn. Every
  link binds one exact owner+location pair; the duplicated owner id exists only so composite foreign
  keys can prove both the authorization and location belong to the same farm. The link does not
  expire, so **revocation is the entire safety net** — which is why nothing about it may be cached.
  One live link per authorization: re-issuing replaces rather than accumulates.
- **farmer SMS target context** (F-051) — one selected authorization+owner+location tuple per sender,
  plus at most one 12-hour numbered menu whose options bind exact tuples. Selection is convenience,
  never authority: every use revalidates live authorization and location.
- **inventory-prompt preferences** (F-052, F-081) — at most one cadence and designated authorization
  per stand: every 2 days, weekly, every 2 weeks, or paused. A stand **starts at `weekly`** when its
  farmer is set up, and the farmer changes or pauses it from settings or by texting `SETTINGS`.
  Seeding is **first-write only** (`on conflict do nothing` against the per-location unique index) so
  a farmer's own choice, including `paused`, is never overwritten. **No historical behavior, corpus
  statistic, or migration ever creates or infers a preference**: the default is a stated product
  decision, never a guess derived from what a farmer did before. A stand with no farmer gets no
  preference rather than a guessed recipient. Version, next due time, and last due slot let code
  invalidate stale work and advance one slot without a catch-up burst.
- **VIGA approval** — recorded **separately** from onboarding completion, and it is what lets a farm
  publish inventory. Approval and revocation record **which administrator acted, when anyone did**:
  the administrator is nullable, because the honour-system door has none to name and crediting one who
  never acted would be a convenient lie. Revocation updates the row rather than deleting it, and is
  the backstop for any approval nobody granted; published revisions reference the approval they were
  made under.
- **administrator and sessions** (F-056) — the only admitted identity is `board@vigavashon.org`. The
  password verifier is a web-only secret, never a database value. A session is a durable row holding
  only the **hash** of its token, so a database read cannot recover a live credential; authority is
  re-read per request so revocation is immediate. Sessions carry no personal data beyond the
  administrator foreign key.
- **administrator login-failure budgets** — durable account-wide and coarse-client rows carrying only
  salted 64-hex bucket hashes, positive counts, and window timestamps. No raw network address, email,
  password, or verifier enters the table. The bounded retention pass deletes expired rows.

## Listing facts

**structured public listing facts** — payment methods and VIGA Farm Bucks acceptance or eligibility,
the farm's own prose description, farmer-selected web/social links, and an optional photo or short
biography. Direct farmer email addresses and phone numbers never enter the public description.

**`farms.description` is farmer-writable.** Every listing door carries it, and the writer distinguishes
**`undefined`** ("this door states nothing about the prose", leave it) from **`""`** ("the farmer
cleared it", erase it) — collapsing the two is a destructive-by-omission failure. A fact that has a
**structured column of its own never belongs in this prose**: the two then disagree on the same card,
which is what F-061's `buildStandDescription` exists to prevent.

**Payment methods are canonicalized to a closed set** (F-069, `packages/db/src/payment-methods.ts`) so
"venmo", "Venmo" and "VENMO" are one filterable value rather than three a filter cannot join. Methods
outside the set are kept as the farmer's **own words** — a closed set that silently dropped what it
did not recognize would lose a real fact. This is a *spelling* table and must stay one: unlike produce,
payment methods are a small VIGA-known set, which is why folding them is correct here and folding food
vocabulary is forbidden.

**VIGA Farm Bucks remains separate from payment methods** — `canonicalPaymentMethods` recognizes its
spellings and then **drops** them rather than storing a method row (B-054), so ingest, onboarding's
free-text box and any backfill are all closed at one seam. It never sets the boolean either: a farmer
typing "farm bucks" into a text box must not award themselves an acceptance VIGA never reviewed. The
two columns record two different people's facts: `farm_bucks_accepted` is the **farmer's** claim about
their own stand, published on their word; `farm_bucks_eligible` is **VIGA's** own decision, set in
admin. **Neither constrains the other** (max, 2026-08-10) — eligibility lives on a stand row that does
not exist until onboarding saves, so gating the farmer's claim on it made the toggle unreachable for
every new farm.

**structured availability** (F-035) — season, days of week, time of day, and restocking cadence as
**queryable columns rather than prose**, so "what is open right now" is a filter and not a text scan.
Kinds that are not clock times (`dawn_to_dusk`, `daylight_hours`) and cadences that are not schedules
(`variable`, `as_needed`) are **first-class enum values, not missing data** — on an unattended
honor-system stand they are the truthful answer, and a clock time would invent precision the farmer
never stated. The farmer's own wording is kept verbatim beside them as **display-only text that is
never filtered on**, so a caveat like "Saturday and Sunday when available" survives without the
structured fields overstating it. `year_round` is distinct from an absent season: "always open" and
"never recorded" are different facts. The onboarding form's pickers branch to match the five CHECK
constraints, and `coherentAvailability` (`packages/db/src/listing-availability.ts`) mirrors them in
memory so a contradictory answer reaches the farmer as a fixable message rather than a constraint
violation.

## stand items (F-066)

The **one vocabulary a stand talks about its own goods in**. "Eggs" is one record per location, and
the two things anyone can say about it are **independent states, not separate lists**:

| State | Is it dated? | Written by | Meaning |
|---|---|---|---|
| **usually carried** (`usually_carried`) | never | the farmer's web form only | a property of the farm, true in March and September |
| **confirmed present** | always, and attributed by `source` | SMS confirmations and the web form | what is out *right now* |

Either, both, or neither may hold. An item is created by whichever surface first names it and outlives
both states — removing eggs from the usual mix clears that state and leaves the record standing with
its confirmation history intact, because an item that stopped being a standing claim did not stop
having been confirmed in June.

**The states stay structurally apart even though the vocabulary is shared**, and this is load-bearing.
The standing state:

- carries **no confirmation time**;
- can **never** occupy the one-current-per-location slot meaning "the freshest thing anyone has said
  about this stand";
- must **never** be rendered as current availability;
- is **read by the public listing** (F-042) as a field of its own, never merged into the confirmed
  items, under a heading that takes no timestamp — the "no confirmation time" property has to survive
  all the way to the screen to mean anything.

**A standing item may carry an optional STRUCTURED price** (F-092) — four columns rendering as one
sentence, and `renderStandItemPrice` in core is the **only** thing that turns parts into words:

| Column | Type | Note |
|---|---|---|
| `price_amount`, `price_quantity` | `numeric(10,2)` | never floating point |
| `price_unit` | free text | the farmer's own word |
| `price_basis` | `per` \| `for` | `per` is the bundle with an implied count of one |

"$6 / dozen" and "3 lb for $5" are the same four facts with a different joining word — one mechanism,
so a third kind of price is a third `basis` value rather than a fifth column.

- **A price is stated or it is not.** `stand_items_price_complete` refuses anything between, because
  half a price renders as garbage. NULL across all four is *not stated*; **an amount of `0` is FREE**,
  a claim rather than its absence.
- A price is a **standing claim** exactly like the item it belongs to, and carries no date.
- **The unit may be omitted only for `for`** (B-041). A bundle carries its own count, so "$5 for 3" is
  complete with the item as the unit; a unit price has no count to lean on, and "$6 / " is not a
  sentence. `stand_items_price_basis_unit` (migration `0033`) is that asymmetry at the database, and
  `standItemPriceNeedsUnit` in core is the copy every other layer imports rather than restates. A
  unitless bundle of one reads **"$5 each"** (max, 2026-08-08).

**`inventory_entries.price_text` is still free text** and is a different fact — a price on today's
confirmed stock, dated, belonging to the statement rather than to the item. Onboarding writes it by
rendering the structured price into that column.

**Whether any price REACHES a customer is `sales_locations.prices_public`**, not these columns. Hidden
means hidden: the values stay stored so the switch is reversible, and the public query withholds them
**in SQL**, so a withheld price never leaves the database for a later reader to leak.

**Item names are the farmer's own words** ("plant starts", "Gailan"), per-stand and farmer-authored.
There is no shared produce taxonomy, no global food ontology, and no vocabulary any behavioral branch
may reason about. Two stands that both sell eggs share nothing.

**Only the farmer's web form writes the standing state; SMS writes only confirmations** (max,
2026-08-05). A text message is always a dated statement about right now and can never alter a standing
claim — so an SMS-confirmed item outside the usual mix is confirmed and nothing more: no prompt to
adopt it, no automatic add. A farmer changing their core set texts `SETTINGS` and edits the form,
where their confirmed items and their usual mix appear on one screen, which is the one place the two
can be seen to have drifted and the one place drift can be fixed. This keeps the SMS surface to a
single job and puts the deterministic-routing line at the data layer: no inbound message, however
interpreted, reaches a standing fact. The standing state is the `usually_carried` column, and its one
farmer-facing writer is `saveOnboardingListing` (F-067); verified by effect, a farmer submitting the
form writes `stand_items` rows and **zero** inventory revisions.

A card shows a confirmed item under one heading and the rest of the usual mix under another, so one
list is subtracted from the other — as a plain set difference over identical strings, because the
reader resolves a confirmed item to its stand item's spelling before the view sees it. The reader
deliberately does **not** case-fold as a safety net: if the two ever stop being one vocabulary, the
duplicate must show rather than be papered over.

## Records of what was said, and to whom

- **stand data flags** (F-035) — where a contradiction in seeded source data waits for a human.
  Distinct from the customer-message `flags` table, which is keyed to a contact and an inbox event a
  seed flag has neither of. One open flag per (location, reason); resolved flags stay as history.
- **inventory revisions and inventory entries** — a revision is an immutable published version of a
  location's inventory; entries are the items in it, with quantity/unit/price text or an approximate
  label. Revisions have no draft state. Every revision declares its **`source`** (F-063, F-090), and a
  database CHECK makes the three shapes mutually exclusive:

  | `source` | `proposal_id` | `published_by_authorization_id` | `farm_approval_id` | Is |
  |---|---|---|---|---|
  | `sms` | required | required | required | the full handset chain; the proposal carries the token the farmer texted back |
  | `web` | **NULL** | required | required | stock a farmer stated on the onboarding form, published once `START` proved the handset |
  | `viga` | **NULL** | **NULL** | **NULL** | VIGA's own records — the launch import, the weekly stock form, a later admin edit |

  `web` is as strong as `sms` on who stands behind the claim; it lacks only the confirmation exchange,
  which genuinely never happened. Recording it as `sms` would have required inventing a consumed token
  and a consumption event naming a message nobody sent — the exact fabrication this constraint
  refuses. `viga` records VIGA's own facts without fabricating an attestation about an identifiable
  person.

  Written as one biconditional over all four columns rather than per-column rules, because a CHECK
  *passes* on NULL. **The enum is recreated rather than extended** when a value is added: PostgreSQL
  cannot use a newly added enum value in the transaction that added it, and the migrator runs every
  pending migration in one.

  An entry **resolves to its stand item by the normalized name it already carries** (F-066), and the
  entries table is **not modified at all**. There is deliberately no `stand_item_id` column:
  `inventory_entries_guard_history` raises on *every* update with no permitted shape, so backfilling a
  reference onto published rows would mean disabling the immutability guarantee inside a migration —
  which would establish that the guarantee is switchable. It is also unnecessary:
  `(sales_location_id, normalized item_name)` resolves it through the same key the unique index
  enforces. The product has **no rename** — a farmer edits the mix by removing and adding words — so
  the two can never drift apart. Entries keep their own quantity/unit/price text, which belongs to the
  dated statement, not to the item.
- **closure revisions** (F-049) — append-only owner-confirmed close/reopen history, separate from
  inventory. A close carries `temporary` or `seasonal` plus a Vashon-local start date; temporary may
  carry an inclusive end date. Reopen carries no kind or dates. Composite foreign keys bind the
  location, authorization, and approval to the same owner farm. One current instruction per location
  and one revision per proposal are database constraints; bounded expiry is computed by the canonical
  reader and never rewrites these rows.
- **sales-location participants** (F-050) — owner-confirmed public display names for other sellers at a
  location, separate from both ownership and inventory. Names are unlinked plain text: code does no
  farm/profile/alias matching, the owner is not inserted automatically, and inventory entries carry no
  participant or seller provenance. Retirement records the owner authorization and time without
  deleting history. The public reader returns active names under **Also selling here**, separately
  from the single aggregate inventory list.
- **customer stock-out reports** — private; each carries a required sales-location identifier bound by
  the reporting surface, and names its item in **exactly one** of three ways: a published inventory
  entry, one of the stand's usual offerings, or free text for an item the stand lists neither way. The
  two reference kinds are distinct columns, not one widened column — an entry carries a farmer's
  confirmation time and a usual offering does not, and an operator judging the report needs to know
  which. Each is bound to the report's own location by a composite key, so an item belonging to another
  stand is refused by the database. A model does not supply the consequential location identifier.
- **pending stock-out reports** (B-065) — the half-finished report held between a clarifying question
  and its answer, so that answer has somewhere to land. Before it, Farm Friend asked "Which stand are
  you at?" and stored nothing, so a customer who answered correctly was told "Sorry, I did not catch
  which item or farm you meant" and their report was dropped. Holds the **original message** — the
  half that would otherwise be lost — plus which of the two questions was asked (`awaiting`) and, on
  the item arm, the already-bound stand. A CHECK ties those together as one biconditional: awaiting an
  item means a stand is bound, awaiting a stand means it is not. **One open clarification per sender**,
  enforced by a unique index rather than a read-then-write, so a second unfinished report replaces the
  first. Expires (15 minutes), judged against the **message's** clock and not `now()`; deleted on
  resolution and on release. It holds a question, not a conversation: nothing outside the stock-out
  path reads it, it teaches no token, and it is unreachable from deterministic routing, which still
  takes the body and nothing else.
- **minimized SMS inbox and message records** with limited retention — unique provider event/message
  identifiers, event type and `occurred_at`, sender/contact reference, TTL-bound body where needed,
  processing state, and per-sender conversation watermark/claim. The raw provider envelope is not a
  durable record.
- **launch-program SMS consent and universal STOP** — one current launch consent state per recipient,
  provenance for how, when, and where consent was captured, and a separate provider-time STOP/START
  transition watermark. Launch has no program discriminator or future-program enrollment rows.
  `sms_consents` is keyed by `recipient_hash` alone, so a second enrollment for the same recipient is
  not representable; `consent_capture_source` is bounded to `join` / `start` / `farmer_onboarding`,
  all of which establish the same one program (F-016).
- **outbox message category** — `outbox_work.message_category` is a bounded enum naming which launch
  category a queued message is, and it is the typed input to the dispatch consent gate. It replaces a
  former free-text `message_kind` plus `is_required` boolean, which were two overlapping ways to say
  one thing and could not express a direct reply that is permitted by the recipient's own message
  without being carrier-required.
- **one open farmer-update confirmation per sender** — target sales location, explicit inventory and
  closure section-presence flags, an independent base binding for each included section, structured
  complete payload/version, provider-accepted prompt activation, expiry, and consumption state.
  Existing inventory entries retain their opaque reference IDs in that payload; code issues opaque
  draft IDs for new entries so later unconfirmed edits can target them. This is neither an inventory
  nor a closure revision.
- **scheduled inventory-prompt subjects** (F-052) — the exact durable meaning of a queued prompt:
  proposal and version, preference and version, designated authorization, owner and location,
  inventory and closure bases, due slot, outbox row, and whether the complete visible snapshot made
  `SAME` safe to offer. It stores no inferred meaning from message text; dispatch joins this typed row
  and revalidates it. `SAME` publishes an ordinary identical inventory revision, so `published_at`
  remains the one recency fact.
- **one pending result list per sender** (F-046) — the ordered fact identifiers a customer's last
  answer selected, the product words it was about, how far through them they have read, and an expiry.
  `MORE` **replays** this list rather than re-running retrieval, so paging is consistent and costs no
  model call; the accepted tradeoff is that stock confirmed mid-paging waits for the next question,
  which the expiry bounds. **One row per sender**, replaced by each new question, so `MORE` is never
  ambiguous about which list it means. It stores **no message body and no rendered reply text**: the
  customer's question is untrusted inbound text with a short retention life of its own, and copying it
  here would create a second, longer-lived home for it. The requested items are the narrow exception —
  the product words the interpretation seam extracted, not the sender's sentence — because a later
  page must name its subject to read as an answer.
  It also carries **two counts in different units** (B-062, migration `0040`): the offset advances in
  FACT ids, while `stand_total`/`stand_offset` count STANDS, because one stand can contribute two
  facts and the customer is shown stands. Plus `broad` — whether the question was a general
  availability request — which a later page **cannot re-derive**: such a question names no item, so
  code substitutes a placeholder into the requested items, and a page reading that column alone would
  print the placeholder as though the customer had typed it.
- **flags and admin dispositions.**
- **transactional outbox.**
- **minimal audit and model-run evidence.**

