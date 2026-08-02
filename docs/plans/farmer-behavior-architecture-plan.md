# Farmer-Behavior Architecture Plan

Status: adversarially reviewed against the historical response corpus, authoritative docs, current
implementation, and PM work on 2026-07-31. Product decisions are settled.

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
