# Farm Friend — Session Log

Newest-first, on-demand build history: what was built each session, the decisions and rationale
that aren't obvious from the diff, and what was verified/owed. The **live snapshot** of what's
true/unfinished now lives in [CURRENT_STATE.md](CURRENT_STATE.md); this file is the *why behind
past changes*.

This file keeps the **newest eight entries**; everything older rotates into
[SESSION_LOG_ARCHIVE.md](SESSION_LOG_ARCHIVE.md), which now holds 37. A log too large to open
mid-session defeats its own purpose.

---

## 2026-07-30 (latest) — F-040 built: farmer onboarding, and six sabotages that were the real work

One tranche, all five pieces max scoped. The build was largely mechanical — the design was settled
in the PM item and not re-litigated. **The interesting part is that six of my own assertions were
wrong, and only sabotage found them.** Two of those were guarantees the whole item rests on.

### The gap this closes

`farmer_authorizations` had existed since the clean launch with **no writer outside test fixtures**.
Publishing demands one, so a real farmer texting an update resolved to no authorization, fell
through to the *customer* branch, and nothing reported why — behind a fully green suite, because
every publication test inserted the row it was supposed to be proving. The same shape as F-024's
silent stub and B-002's un-run seeder: a green check covering less than its name implies.

### The link is deliberately not a signed claim

max chose a link that never expires until revoked. The obvious implementation is `magic-link.ts`'s
mechanism — a signed, expiring claim — and it is **exactly wrong here**. A signature is stateless:
it says "authentic" any number of times, so a revoked farmer's link would keep verifying forever
with nothing able to say otherwise. Revocation is the only safety net this design has, so the link
must be a *lookup key into a row someone can withdraw*, never something a verifier can validate on
its own.

So `farmer_links` holds 32 random bytes, hash-only, and `resolveFarmerLink` re-reads **both**
revocation columns on every request. No denormalized farm id, no cached "active" flag, no claim in
the token. There is nothing to cache around because there is nothing cached.

The two records split for the same reason: `farmer_onboarding_requests` is what a farmer *asked*
for — no farm, no grant column, no message text — and is the one record on the page writable from
unauthenticated inbound SMS. It cannot become authority because it has no field that could.

### Where the schema pushed back, correctly

`activateWebProposal` first tried to open the confirmation window without an outbox row, and
`inventory_publication_proposals_activation_coherent` refused it. That constraint encodes "a
proposal is committable only once a prompt the farmer was shown was accepted" — satisfying its
shape with a NULL would have hollowed it out. The fix was to make the web path *earn* it: it queues
a real confirmation SMS and activates against that. The farmer gets a receipt on the channel they
trust, which is worth having anyway — a browser tab is not a receipt.

### The six survivors

~35 sabotages. Six survived, each exposing a test that looked like it proved something and did not:

1. **The resolver's authorization check was untested.** Revoking through the writer also revokes the
   links, so deleting `auth.revoked_at is null` still passed — the *link* clause was doing all the
   work. Fixed by revoking the authorization directly, leaving the link row open, and asserting the
   link row is still open so the test cannot silently decay back into the other one.
2. **The one-stand-per-link guard was untested** — no fixture had a farm with two stands, so "the
   link names ONE stand" was unverifiable.
3. **A `contactHash` leak into the pending-request projection survived the whole suite**, because
   the fixture had an authorization and no open request: the array it leaked from was empty. Both
   arrays are now populated and asserted non-empty *before* the privacy assertions run.
4. **The cross-farmer confirmation test was satisfiable by the exact attack it forbade.** Reading
   the sender hash from the *named proposal* rather than the attacker's own token makes the attacker
   **become** the victim — so the gate matches, publishes on the victim's behalf, and consumes their
   proposal. "Refused" and "still open" were the only assertions; the second was false but nothing
   else checked was. Now asserts the proposal is UNCONSUMED.
5. **Two independent defenses were indistinguishable to the suite.** Sender-from-token and
   activation-scoped-to-sender each refuse the cross-farmer attack alone, so removing either one
   passed. Redundant defenses are worth having; redundant defenses nobody can tell apart are how one
   gets deleted as dead code later. Each is now isolated by its own test.
6. **The token shape guard returned null with or without the regex**, since no row matches garbage.
   What it actually buys is that garbage never reaches the driver — now asserted by *query count*,
   with a well-formed token proving the counter is not stuck at zero.

The general lesson, worth carrying: **an assertion on a refusal is weak.** "It refused" is satisfied
by refusing for the wrong reason, or by a fixture too thin to exercise the path. Assert the durable
effect — the row unconsumed, the array non-empty, the query count zero.

### Approval is not consent, and the category is what keeps it true

The "you're all set" text is queued inside the authorization transaction, as a **proactive**
category. So `authorizeDispatch` re-reads consent at the claim and suppresses it for a farmer who
never texted JOIN/START. Asserted at the dispatch claim rather than the queue — that is where the
guarantee lives — **plus the complement**, because a notification nobody can ever receive would
satisfy the suppression test perfectly.

`SIGNUP`/`LINK` are parsed **last** among keyword branches so neither can shadow `STOP`, and
**before** free text so no model sees them. Moving the branch after free text fails 7 tests.

### Verified by effect, twice

Whole journey against real Postgres and the running app: SIGNUP → masked queue → authorize (text
queued, `inventory_prompt`, `queued`) → LINK → resolve → propose (**0 revisions**) → confirm
(published) → revoke (link resolves null on the *next* request, form refuses, published listing
untouched).

Then again through the **real HTTP route with the real model**. Two things worth recording:

- Mistral rendered **"plum jam" twice**, once bare and once priced. Interpretation quality, not a
  code defect — and precisely what the confirmation gate exists to let a farmer catch.
- An earlier "real model" run **actually hit the stub**: the previous dev server had not died and
  the new one failed `EADDRINUSE`, which I only caught by grepping the log. A stub clarification
  reads *identically* to a real refusal. Redone on a genuinely free port.

### Two tripwires earned their place

`workspace-manifests.test.ts` caught a real missing manifest entry (the new segment test made
`packages/sms` import `@farm-friend/core`, an edge the architecture permits but the manifest did not
declare). `schema.integration.test.ts` caught the two new tables missing from its pinned list.

### Deployed the same session

Merged as `8ae9af2` (PR #62), then **migration 0009 first, image second** — the order the RUNBOOK
insists on, because deploying the image alone would have shipped code whose tables did not exist.
Production fingerprinted immediately before and after: every pre-existing count unchanged, both new
tables empty, 8 → **9 migrations**. Revisions `farm-friend-web-00009-pvm` /
`farm-friend-worker-00010-zdn`, digest `sha256:ed998c4c…`; plan read leaf by leaf (exactly one real
leaf per service), 29/29 plan assertions, deploy + served-card assertions PASSED.

**F-042 went out in the same image**, so the 212 tags reached customers for the first time — the
map now serves them across 33 of 34 public stands.

### Owed

**Nobody has looked at the screens.** `/stand/<token>` and `/admin/farmers` serve correct markup and
CSS classes — verified by fetching the rendered HTML — but the styling has **not been seen
rendered**; the browser extension was not connected. Same debt F-042 carries. Also renamed the page
namespace to `farmer-form` mid-build after finding `.stand` is the public map's *card* class: a
page-level `.stand` would have inherited card padding, a border, and a green left rule.

---

## 2026-07-29 — F-042 built: the offering tags reach customers, and a rule that had to leave the JSX

One item, built to copy that was already approved, so the interesting part is not the vocabulary —
it was settled last session — but **where the load-bearing rule ended up living, and why it could not
stay in the markup.**

### The defect: seeding was necessary and not sufficient

212 offering tags across 33 of 35 stands, and no customer could see one of them.
`listPublicStands` never selected `sales_location_offerings`, so the API exposed no offerings field
and every tagged stand rendered *"No listing yet"* while the database knew it sold eggs. F-041
delivered the data and proved it by effect; this was the reader half, filed separately so the
distinction stayed visible.

### The rule had to leave the JSX to be testable at all

max's approved copy rests on one rule: **"Usually sells" never takes a timestamp**, because a date
beside it reads as a confirmation nobody made — the same class of failure B-013 caught on the recency
fields.

The obvious implementation is a conditional chain in `stand-map.tsx`. That was rejected on discovery
that **this repo has no component-rendering harness** — no jsdom, no testing-library, and
`stand-map.tsx` has never had a test. A rule that load-bearing sitting in untested markup is a
guarantee that is not a tested invariant, which by the project's own standard is not a guarantee.

So the whole "which lines does this stand get" decision moved into `standListingLines`, a pure
function in `map-view.ts` — the module that already exists precisely because "everything that could
be WRONG about the map is decided here, where a test can hold it to account." `stand-map.tsx` now
prints its output and chooses nothing: no `stand.updated` check, no `items.length` check, no
`visitability` check. `detail` is settable only on a confirmed line, and the usual line's label is a
constant with no interpolation available to it.

The function subsumed the pre-existing F-038/B-013 conditional chain too, so there is one mechanism
rather than two — the confirmed-empty sentence and the contact-only sentence are now line *kinds*
alongside the new ones.

### One arithmetic, two voices

The map's heading needed "Confirmed 4 hours ago" while SMS says "updated 4 hours ago", and
`renderRecency` hard-coded the verb. Two options: slice the verb off the string downstream, or split
the arithmetic. Split it — `renderElapsed` renders the bare phrase and `renderRecency` is that phrase
prefixed. A client stripping a verb off a sentence would be one wording change from printing garbage.

**This is why `evals:live` was not required, and the claim is measured rather than argued:**
`renderRecency`'s output was compared against the previous implementation across **57,601
minute-by-minute cases over 40 days — byte-identical**. No seam projection, schema, or output
contract changed; `packages/ai` references none of these symbols.

### The cross product that a second join would have caused

Selecting the tags via `left join sales_location_offerings` alongside `inventory_entries` makes the
query a **cross product**: 3 tags × 2 confirmed items is 6 rows, and the accumulating loop would push
each item three times and each tag twice. Every duplicate reads as a real second item on the card.
Aggregated in a subquery instead, keeping the row grain at one-per-inventory-entry, which is what the
loop already assumed. `coalesce(…, array[]::text[])` because an aggregate over no rows is NULL, not
an empty array — and the untagged stands are the majority, so that is the common path.

### A divergence found on the way through

`page.tsx` held a **second hand-written copy of the wire format**, and the copies had already drifted:
the page sent `updated: undefined` and `stale: undefined` as *present keys* where the API omitted
them, so "nobody has confirmed this" reached the browser differently depending on which reader
produced it. Both now call one `serializePublicStand`, typed to `PublicStandPayload` so the compiler
holds the contract instead of two object literals agreeing by habit.

### The asymmetry that is deliberate, and the sabotage that caught it

`usuallySells` is **always sent, `[]` when empty**; the three recency fields are **absent when
empty**. That looks like an inconsistency worth tidying, and it is load-bearing: an empty tag list is
a complete honest answer, whereas "no confirmation" and "confirmed nothing" are different facts only
absence can distinguish.

**20 sabotages were run; 19 were caught immediately. One survived** — omitting `usuallySells` when
empty passed the *entire* suite, unit and integration, because the renderer treats absent and empty
alike by design and no test asserted the wire shape. That is exactly the "tidy up the asymmetry"
regression, and it would have reached production silently. It now has its own assertion, anchored on
`"usuallySells" in stand` rather than a value comparison.

### Verified by effect, against the real corpus

Not by a passing suite. A local database built from `maps/offerings-proposals.json` — **34 stands, 33
tagged, 212 tags, matching the production fingerprint** — served through the real app, then the
*rendered bytes* read: 33 "Usually sells:" + 33 "Nothing confirmed recently.", exactly **1** "No
listing yet", and **no elapsed phrase within 400 characters of any usual label**. Then a real
revision published through the real proposal→confirmation chain on a 7-tag stand with 2 items
confirmed produced *"Confirmed 4 hours ago: flowers, duck eggs"* over *"Also usually sells:
vegetables, fruit, chicken eggs, plant starts, leafy greens"* — the confirmed items subtracted
case-insensitively, because tags come from VIGA's form text and confirmations arrive in a farmer's
own SMS and nothing normalizes casing between them.

### A tripwire worth recording

Running `next dev` **clobbers `.next/`**, and B-025's `contact-card-build.test.ts` reads the
production build output. It fails with "no built chunk containing BEGIN:VCARD" — which looks like a
CRLF regression on the very thing B-025 just fixed, and is purely environmental. A rebuild clears it.
Noted in CURRENT_STATE so it is not re-diagnosed.

### Owed

**Nobody has looked at the map.** The two voices are styled to differ at a glance — filled green
chips for a confirmation, outlined for a tag — but that CSS has **not been seen rendered**: the Chrome
extension was not connected when the check was attempted, twice. The copy, counts, ordering, and the
no-timestamp rule are all verified on the rendered bytes; the visual distinction is not.

F-040 (farmer onboarding) was opened next and stopped before any code: its five pieces — SMS request,
VIGA approval, the "you're set up" text, the farmer web form behind a never-expiring link, and
revocation — split naturally, and the web form is the only part that creates a new risk surface while
also being the only part a farmer does not strictly need (SMS publishing already works). That scope
call is max's and is the first thing the next session settles.

---

## 2026-07-30 — B-025 was the minifier, not the network; B-023 closed; F-042's vocabulary settled

Three items, each verified by effect rather than by a passing command. The headline: **B-025's filed
diagnosis was wrong in both directions**, and following it would have produced a fix that changed
nothing.

### B-025 — a template literal, not Next.js and not the proxy

Filed as "the Next.js response path or the proxy layer is normalizing the body", with the note **"NO
LOCAL TEST CAN SEE THIS."** Both premises were false, and measuring rather than accepting them is the
whole story.

It reproduces on a **local standalone build** — 147 bytes, 0 CR, identical to production. So the
network was never involved. Probing the layers in order:

- A plain Node HTTP server relaying the same `Response`: CRLF intact.
- All three Next.js body forms — string, `Buffer` with explicit `content-length`, `ReadableStream`:
  **all three preserve CRLF byte-for-byte.** The candidate fix in the bug report (return a
  Uint8Array/Buffer with an explicit content-length) would have changed *nothing*, because the
  plain string already works.

The real cause is the **build**. The minifier folds `[...].join("\r\n")` into a single template
literal and writes the separators as **raw CR and LF bytes in the source text** — not as the escape
sequence. ECMA-262 normalizes a literal CRLF inside a template literal to a single LF at *parse*
time (§12.9.6), so the CR was gone before the string ever existed at runtime. The renderer was
correct, its CRLF assertion was correct, and both were irrelevant.

**One wrong turn worth recording**, because the correct-looking evidence pointed the wrong way:
grepping the built chunk showed `join("\n")` and no `join("\r\n")`, which reads as "the minifier
rewrote the separator." It hadn't — a raw **byte** dump showed genuine `\r\n` in the template. The
lesson is the repo's own: grep output is text about bytes, not the bytes. Only `python3 -c` on the
raw file settled it.

**The fix is `String.fromCharCode(13, 10)`.** It emits no newline byte into the bundle, so there is
nothing for a parser to normalize — the property holds *by construction* rather than by a minifier's
cooperation. This is the one place in the codebase where an obvious literal is deliberately refused,
so the reasoning lives in the code, not here.

**Why the test had to read the build output.** A unit test on the renderer cannot see this: vitest
runs unminified TypeScript, where the join is still a join. That is precisely why B-025 shipped with
a green suite. `apps/web/lib/contact-card-build.test.ts` therefore asserts against the built chunk,
bounded to the card's own region so a stray `\r\n` elsewhere in a 300KB bundle cannot satisfy it.
Sabotaged back to the literal: both assertions fail.

**Verified by effect on the wire, twice** — locally (153 bytes / 6 CRLF, `file(1)` reads "vCard
visiting card, version 3.0"), then in production on both HTTP/1.1 and HTTP/2 after the deploy, by
hex dump independent of our own checker.

### The deploy-time check, because a bare-LF card passes every other check

`infra/served_card_assertions.py`. B-025 survived a full deployment while returning 200 with the
right media type, the right display name, and the right number — **every check short of counting the
separator bytes passed**, and a malformed vCard fails by opening *nothing* on the handset, which is
indistinguishable from a working tap.

Kept **separate** from `deploy_assertions.py` on purpose: that script is metadata-only and never makes
an HTTP request. Same pure-core/impure-shell split, so its tests construct payloads directly —
including the exact 147-byte production body, with an assertion that the good and bad cards differ by
**precisely six CR bytes and nothing else**.

Proven end to end, not merely unit-tested: pointed at a rebuild carrying the original defect it exits
1 reporting "6 BARE LF and 0 CRLF"; pointed at the fixed build it passes with the real 153/6/0.
Sabotaged four ways (removed the bare-LF branch, zeroed its count, accepted any content-type, dropped
the empty-body guard) — each caught, and notably removing the B-025 branch does **not** hide behind
the neighbouring "no CRLF at all" assertion. Wired in as step 6 of the RUNBOOK deploy sequence.

### B-023 — the first administrator is `board@vigavashon.org`

max chose a VIGA **org** address over a personal one, so authority sits with the organization from
the start. max ran the write himself; the row was then **verified by reading it**, not accepted on
report — 1 live row, `authorized_at` 2026-07-30T01:32:05Z, `revoked_at` null, and every other table
unchanged.

Verification went one step past "the row exists" to "the row is *usable*": `findAdministratorByEmail`
resolves it in production for the exact address, for mixed case, and with stray whitespace, while an
unrelated address still returns no administrator. Rehearsed first on a throwaway local database from
empty, confirming the script writes one row and is genuinely idempotent (second run: "already an
administrator", exit 0).

**Still not self-service.** No mail provider (F-031), so nobody receives a sign-in link — the link
must be minted out of band. The row makes sign-in *possible*, not *delivered*. **B-023 was F-040's
blocker, so farmer onboarding is now unblocked.**

### F-042 — the vocabulary, settled before any code

The 212 tags are what a farmer *usually* has, from the 2026 form. They are **not** a confirmation of
current stock, and the product's honesty rests on that gap staying visible. Two distinct facts needed
two distinct voices:

- **Usual range** (all 33 tagged stands): *"Usually sells: salad greens, tomatoes, flowers"* followed
  by *"Nothing confirmed recently."*
- **Confirmed stock** (0 stands today): *"Confirmed 4 hours ago: …"* with *"Also usually sells: …"*
  beneath it.

Three rules, and the first is the load-bearing one: **"Usually sells" never takes a timestamp** — a
date beside it reads as a confirmation, which is exactly the failure. The stock-out flow stays
attached to confirmed items only (reporting "the tomatoes are out" against a tag nobody confirmed is
noise for the farmer), and *"No listing yet"* survives for the 2 untagged stands, where it is still
true.

Wording chosen deliberately: **"sells" over "carries"** — "carries" implies a shop with shelves, and
these are mostly unattended honor-system tables. And the plain *"Nothing confirmed recently."* over a
friendlier "call ahead or take a chance", which nudges toward risk in VIGA's voice rather than simply
stating the absence. **Copy is approved; nothing is built.**

---

## 2026-07-29 — F-041 offerings seeded, F-039 the vCard, and a farmer's address we should never have published

A subagent session: two items built in isolated worktrees, both verified by the coordinator rather
than relayed. Then the offerings seed, which found something more important than itself.

### Both agents died uncommitted, and verifying rather than trusting caught two real defects

A session limit killed both agents mid-edit with **nothing committed** — the exact "reported
completion with uncommitted work" hazard the standing rules name, except neither got as far as
reporting. Recovering their worktrees and re-running everything found two defects in work that
otherwise looked finished:

- **F-041 had a typecheck failure** at the line the agent died on (`indexLocationsByMatchKey(sql: Sql)`
  called with a `Tx`; the two are deliberately distinct types).
- **F-041's ambiguity test leaked its fixture.** It seeded two colliding stands and left them in the
  shared database, so the *next* test inherited the collision and threw. It read as a defect in the
  dry run; it was test isolation. **An ambiguity is a whole-database property, not a per-call one** —
  a leaked colliding pair makes every later call in the suite throw. Had the agent's report been
  relayed, this would have been a reported green that wasn't.
- **F-039 had no route at all.** The renderer and its tests existed; `apps/web/lib/contact-card.ts`
  and the route file did not, so the test file could not even load. Resumed the agent to finish it.

### F-041 — key the loader through the seed join's own normalization

`seedOfferings` matched `sales_locations.name` as an exact string, but the approved artifact records
each farm's **map-export** name while the seed stores the **form** name. Measured against production:
26 of 31 matched; five were silently reported unknown and given no tags. Fixed by reusing
`matchStandName` — one mechanism, two consumers — rather than regenerating the artifact, so the loader
survives the *next* naming difference. An ambiguous name **refuses the whole batch**, on the same
reasoning the join itself uses: a wrongly joined pair is silently wrong, a missed one is a reported
refusal. Measured after: **31/31, 0 unmatched, 0 ambiguous collisions across 35 stands.**

**`--dry-run` now resolves against the database** (`planOfferings`), printing `Aeggy's -> "Aeggy's
Farm"` when names differ. The old dry run only echoed the file, so it reported 31 entries while 26
could land — *that* is how the five stayed invisible. A dry run that cannot see the database cannot
show the facts a reviewer needs, so `DATABASE_URL` is now required for one.

### Why four farms had no tags — not "newer", structurally unreachable

The assumption was that they postdated the proposal run. **Three exist only in the FORM export**,
which `offerings:propose` never reads (it takes the map CSV), and `parseStandCsv` anchors on the
`POINT (` literal — so a row with no coordinate is **invisible rather than rejected**, with 0
rejections reported. The fourth, Handpicked Homestead, appears in the map file only as text inside
*another* farm's description. Proposed the three through the real seam and gate; max approved.

### The real finding: we published an address a farmer asked us not to (B-024)

Investigating those four surfaced that **Handpicked Homestead was live as a `visitable` stand at her
home address with a real map pin**, while her own form `extraNotes` said *"I don't have my own
farmstand - please add me under Plum Forest's location, do not add my address."* The map was sending
customers to a private residence with no stand.

**`extraNotes` is parsed but consumed only by `offering-type.ts`** — nothing reads it for visibility
or visitability. The instruction was sitting in the record with no consumer: the same
data-present/consumer-absent shape as B-013 and F-038's Atlantic pin, but worse in kind, because the
coordinate is *correct* and it is someone's house.

Scanned the whole corpus for the same class of language ("do not add", "don't have my own",
"available at", "under X's location"): **exactly one instance**, so a contained fix rather than a
re-seed. max approved unpublishing as the interim. `is_public = false` — chosen because it already
gates `listPublicStands`, so no schema change and no new concept for one row. Her address and
coordinates are **preserved**; she is really a *producer* whose goods sell at another farm's stand,
and **no producer/host relationship was invented for a single row**.

### Seeding is not the same as surfacing (F-042)

212 tags landed across 33 of 35 stands, idempotent (second run: inserted 0, skipped 212), with every
structural invariant intact — 0 inventory revisions, 0 entries, 0 authorizations, 0 approvals, so no
fabricated confirmation. Then checking the live endpoint showed **0 stands exposing offerings**:
`listPublicStands` never selects `sales_location_offerings`. All 33 tagged stands still render *"No
listing yet."* The seed reported success, the database agreed, and the customer-facing surface was
unchanged — filed as F-042 rather than calling F-041's goal met.

### Also found: production has no administrator (B-023)

`administrators` is **0 rows**, so the entire deployed operator surface is unreachable by anyone — a
verified link for an address with no administrator row renders 401, correctly and permanently. Those
4 seeded stand-data flags have nobody who can see them. **Distinct from F-031 and not blocked by it**:
F-031 is mail transport, this is the authority row the link resolves against, and fixing mail alone
still yields 401. `bootstrap-administrator.ts` exists and has never run against production.

### Two decisions recorded

**Display name `VIGA Farm Friend`** (max) — organization first, so it sorts near other VIGA contacts.
An agent had written "Decided by max, 2026-07-29" into the code *before* max had actually chosen; that
attribution was corrected to provisional mid-session and confirmed afterwards. **A tool-prompt result
is not user input.**

**A proposal pass over the newer farms was in scope** (max), so all reachable stands carry offerings.

### Verified

`npm test` **596/596** (61 files); `npm run test:integration` **334/334** (20 files) on real
Postgres 16; typecheck and lint exit 0; `infra/test_deploy_assertions.py` **10/10**. Evals not
re-run — the offering pass *used* the existing seam; no projection, schema, or output contract
changed. Sabotage verified on both items: F-041 (exact lookup → 6 fail; ambiguity refusal off → 1;
dry run made to write → 1) and F-039 (hard-coded number → 5 fail; `text/plain` → 2; a
`NOTE:Text JOIN to subscribe` → 2). The vCard's well-formedness was proven by `file(1)` — an
independent tool — reporting `vCard visiting card, version 3.0`, 153 bytes, 6 CRLF pairs, 0 bare LF.

**CLAUDE.md was condensed this session** from ~87k chars to a lean snapshot; the displaced
subsystem narratives are in this log's earlier entries and the archive, not deleted.

### The deploy found one more platform defect, by effect (B-025)

Deployed at the end of the wrap: build → plan → **29/29** plan assertions → apply → **deploy
assertions PASSED** (revisions `web-00007-4mb` / `worker-00008-gg2`, one digest on both, each newer
than every secret version). The plan diff was read field by field: only the image digest and the
known non-converging `scaling` block changed.

Then curling the newly shipped route found that **the vCard loses its CRLF line endings on the
wire** — 147 bytes / 0 CRLF / 6 bare LF in production, where the renderer produces 153 / 6 / 0, and
`file(1)` rejects it. The handler applies no transform (it passes the string straight into
`new Response`), and it reproduces on **both HTTP/1.1 and HTTP/2**, so the Next.js response path or
the proxy layer is normalizing the body. **596 unit tests pass and the renderer's own CRLF assertion
is correct** — the property belongs to the platform, so nothing local could see it. Same family as
B-009 and B-005–B-008, and found only because the rule is *verify the real thing by effect in the
deployment*. A malformed card fails by opening **nothing**, which is exactly the silent shape this
route was built to avoid.

---

## 2026-07-29 — B-002 closed: the seed join, and production seeded with 35 real stands

The last piece of B-002. F-038's schema, map layer, and form reader were done; what remained was
joining the two exports and seeding production. Both landed, and the seed found a stale deployment
nobody would otherwise have looked for.

### The corpus decided the matcher, and the decision was not the obvious one

The form export has the 2026 details and **no coordinates**; the map export has coordinates and the
farms that submitted no form. Neither seeds a visitable location alone, so the seeder now reads both
and joins by name — the names differ between files (Aeggy's/Aeggy's Farm, Provo Farms/Provo Farm,
Olive Farm/Olive Farm Stand, Flora Hill/Flora Hill Farm).

The instinct is a fuzzy matcher. **Measuring one over the real 32×31 rows killed it**: a Jaccard
score ranked **Lavender Hill Farm against Flora Hill Farm** as its best candidate (0.33). Both are
"⟨word⟩ Hill Farm", and Lavender Hill appears in no map row, so a threshold matcher has nothing
better to prefer. Any threshold loose enough to catch the four true pairs would have seeded Lavender
Hill at Flora Hill's coordinates — **a published address sending a customer to a stranger's
driveway, with every test green.**

The true pairs turn out not to need fuzziness at all: each differs only by a word carrying no
identity. So the key is an **exact normalized identity** — annotations, curly apostrophes and NBSP
normalized, generic words ("farm", "stand") dropped, everything else preserved exactly. Measured:
**27 of 35 matched across both files, 0 false matches.** The failure direction is chosen
deliberately — a missed pair is a *reported refusal* a human resolves; a wrongly joined pair is a
silently wrong address.

This is the "measure against the real corpus" rule earning its keep for the third time (after the
availability parser's ten spurious flags and the offerings parser's "rotational grazing for
chickens"). Arguing from the code would not have surfaced Lavender Hill.

### Layering: the join reports, the seeder decides

First cut had `joinStandSources` refusing a visitable stand with no coordinates. Wrong layer — the
seeder holds hand-supplied points the join cannot know about, so the refusal fired before the
supplement could apply. The join now reports what the exports contain (a stand with no point, a
map-only farm with no address) and the **seeder** refuses what is still unplaceable. Same guarantee,
correct owner, and it is what let max's two coordinates close the last refusals without touching the
join.

### Four defects found this session, each only visible at a specific moment

1. **Supplemental data keyed by raw name silently missed.** Two farms carry VIGA's
   `*does not accept VIGA Bucks*` annotation, so the entry was present, the farm was still refused,
   and **nothing reported the mismatch**. Supplements are now keyed through the same matcher the
   join uses.
2. **"All self-service" classified a cut-flower farm as a service business** — the `SERVICES`
   pattern matched the word inside "self-service". Self-service is the defining trait of an
   unattended honor-system stand, i.e. most of this corpus, so the bug mislabelled the *most
   ordinary* farms as the *rarest* type. Only visible once that farm stopped being refused.
3. **Four farms were seeding the annotation as part of their NAME** — the map would have rendered
   "Flora Hill *does not accept VIGA Bucks*" as what the farm calls itself. `standDisplayName`
   strips only the editorial annotation; `matchStandName` destroys information to compare
   spreadsheets, and the two are deliberately separate functions.
4. **A test survived its own sabotage.** Asserting two farm names stay distinct passes for a weaker
   reason than it claims — adding "hill" to the generic list still leaves "lavender" ≠ "flora". It
   was re-anchored to the construct that actually protects them: the discriminating word surviving
   normalization. **The repo's "anchor to the construct, not the vocabulary" lesson, hit again** —
   the third time in this codebase.

### Seeding production exposed a STALE DEPLOYMENT, not a seed defect

`/api/public/stands` served **Open Gate Lamb at `latitude: 0, longitude: 0`** — a pin in the
Atlantic. The database was correct (NULL) and `public-listing.ts` was correct: it omits the three
place fields together, and its own comment names this exact failure.

**The deployed image predated the fix.** F-038's reader fix merged in `1df55df` (PR #56) at 13:16
local; revision `farm-friend-web-00005` was created at 17:34 **UTC** — B-021's credential-rotation
restart, which forced a new revision of the **existing image** rather than building a new one. So a
merged fix was never deployed, and every check stayed green because **the defect is only reachable
with a `contact_only` row in the database, which did not exist until this seed.**

Same family as B-010/B-011/B-012 (three merged fixes production had never received) and the reason
the standing rule is "deploy immediately after every merge". **A forced restart is not a deploy** —
it re-runs the image you already had.

Fixed by building `main` @ `8e03ad4` and deploying (web `00006-x6l`, worker `00007-92x`). The plan
diff was read **field by field**, not by its count: image digest on both services plus the known
non-converging `scaling` block, nothing else.

### Two operational notes worth carrying

- **`gcloud builds submit` fails with an empty image tag** unless `SHORT_SHA` is supplied — a plain
  directory upload does not populate it, so the tag renders as `…/farm-friend:` and docker rejects
  it with "invalid reference format". Use
  `--substitutions=SHORT_SHA=$(git rev-parse --short=7 HEAD)`.
- **CLAUDE.md's "admin 403" was wrong.** `/admin` returns **200** — it is the public sign-in page,
  and it leaks nothing (no farm names, no E.164, no hashes; verified by scanning the rendered HTML).
  The 403 belongs to the admin **API** routes. Corrected in the snapshot.

### Verified

Unit **575/575** (59 files), integration **329/329** (20 files) on real Postgres from an empty
database, lint and typecheck clean. Evals **not** re-run — no seam projection, schema, or output
contract changed; last results stand. `plan-assertions.py` **29/29**, `deploy_assertions.py`
**PASSED** (both serving revisions newer than every secret version).

Production, verified by effect: **35 locations — 33 visitable with a pin, 2 `contact_only` with
none**, 4 stand-data flags, 0 names carrying an annotation, 0 PII in any seeded text column,
**0 pins at 0,0**, 0 recency claims (nothing is confirmed, correctly). Structural invariants held —
`inventory_revisions` / `inventory_entries` / `farmer_authorizations` / `farm_approvals` all **0**,
`contacts` still **1**. Idempotent: a second run seeds 0 / skips 35.

**Offerings are NOT seeded to production** — `sales_location_offerings` is 0 there. That is the
separate approved-artifact step (`npm run db:seed-offerings` against `maps/offerings-proposals.json`).

---

## 2026-07-29 — B-021 closed, F-038's schema and map built, F-040 filed

Three tranches: finish B-021's two owed follow-ups, build F-038 on the strength of a new data
export, and settle the farmer-onboarding design that F-038's questions kept running into.

### B-021: the drift was never mysterious, and the annotation design was a trap

The "persistent `tofu plan` drift" had an ordinary cause. The emergency
`gcloud run services update` that ended the outage injected `ROTATION_APPLIED_AT` onto the **live
services only**, so every subsequent plan wanted to strip it. That standing "2 to change" is
exactly what made the no-op apply look real. It is now a declared variable in `common_env`, so the
config round-trips; what remains in a clean-tree plan is **provenance only** —
`client`/`client_version = "gcloud"` annotations and a top-level `scaling` block the CLI wrote —
confirmed by diffing the plan JSON field by field, and self-clearing on the next apply.

**The prevention flipped mid-investigation, on evidence.** B-021's notes preferred a revision
annotation carrying secret version IDs, and so did I: it *prevents* rather than detects. Building
it requires resolving `latest` to a version number, which needs
`data.google_secret_manager_secret_version` — and that data source pulls the secret's **cleartext
payload** into the plan and into state. A probe put a **live Neon password** in `prior_state`,
caught by `plan-assertions.py`'s existing "no postgres connection string" check. The metadata-only
data source carries no version number, and the Google provider implements no `ephemeral` resource.
The tfvars variant reintroduces silent staleness one level up.

So the design is a **timestamp comparison** — `infra/deploy_assertions.py`, every serving revision
newer than every enabled secret version it consumes. Both sides are metadata with no path to a
payload. It reads `latestReadyRevisionName`, not `latestCreated`, because a revision that failed
its startup probe exists but serves nothing. Ties fail closed, every stale service is reported, and
**an empty lookup is a failure rather than a pass** — the "green because it looked at nothing"
shape this repo keeps finding.

`test_deploy_assertions.py` exists because **the live project is healthy and cannot produce the
failing case**; the B-021 timeline (revision 16:09:26 vs. secret 16:35:29) is a fixture. Three
sabotages verified. `plan-assertions.py` went 24 → 29, anchored to the **secret mounts** rather
than the variable's name, so a service that stops mounting secrets is legitimately exempt.

### F-038: two properties, and an address is what makes a farm visitable

A new export landed mid-session — the **2026 Google Forms responses**, 32 rows, well-formed,
2026-current, with hours/season/stocking as separate columns. It also contains a case the original
F-038 filing did not have: **Open Gate Lamb's address cell reads "On island delivery for orders
over $50"** — not missing data, but a farmer saying there is nowhere to visit.

That settled the model. Seedrain has an address and sells *services*; Open Gate Lamb has **no
address at all**. One enum cannot carry both without a value per combination, so: **two independent
properties**, `visitability` and `offering_type`, migration 0007, both defaulting to the pre-F-038
meaning so no seeded listing is reclassified. `coherent_visitability` is all-or-nothing in **both**
directions; the `contact_only` direction is the one that protects customers, since the legacy map
export carries real coordinates for Open Gate Lamb.

**max corrected a wrong proposal here, and the correction matters.** Asked about Breathing Meadows
— which has coordinates and says "Open only by appointment" — I proposed relaxing the constraint so
a pin could exist without an address, calling coordinates the load-bearing fact. max: *"an address
is needed for visitability."* Right, and my reasoning was backwards — a coordinate says where a
farm *is*, an address says where a customer can *go*; they collapse into one fact only for an
ordinary stand. And "by appointment" means a customer specifically **cannot** turn up, which is the
definition of a farm you contact first. So Breathing Meadows is `contact_only`, loses its pin, and
**the constraint as originally built was already correct** — the proposed relaxation would have
introduced the bug. Recorded because the wrong turn was mine and the data was on max's side.

"By appointment" is deliberately **not** a tracked type: one instance in 32, and the same language
appears at Lavender Hill and Ostara, which have ordinary stands. It is a fact about *arranging a
visit*, not about whether a place exists — folding it in reproduces the combination explosion the
two-property split avoids.

### Two silent map defects, both found by writing the test first

`public-listing.ts` cast with `as string` and `Number(...)`. Against a NULL that produced address
`null` and coordinates **0, 0 — a pin in the Atlantic off Africa** — with **no type error
anywhere**. `Number(null)` is `0`, not NaN, which is why nothing caught it.

Worse, `withApproximateDistance` then sorted that farm **first**: distance to an absent coordinate
is NaN, and NaN in a comparator makes `sort` order-dependent, so the unlocatable farm surfaced as
the *nearest place to shop*. Fixed by spreading place fields conditionally (the B-013 shape) and
sorting undistanced stands last — the `nulls last` reasoning one level up. Both sabotage-verified.

### "Any farm may publish" — a decision to build nothing, so it became a tripwire

max settled F-038's open product question: **participation is not gated on farm type.** Onboarding
captures typical offerings as reference; current stock is separate and may be empty.

Verified rather than assumed — the only `sales_location_kind` reference outside schema and seeder
is a type alias, and every `kind ===` hit is an unrelated discriminated union. So the decision
required almost no code, which is exactly the property that erodes silently: a future "skip service
businesses" would look sensible and quietly remove a farmer's ability to publish.
`architecture.test.ts` now fails if any publication-path source compares against a location-type
enum **value**. It flagged `public-listing.ts` on its first run — a false positive, since the read
path decides *display* — which is what narrowed the scan to the claim actually being made. That
exclusion is itself guarded: both excluded files must stay free of any durable write.

### The form reader, measured against the corpus rather than argued from the code

**31 stands — 30 visitable, 1 `contact_only`, 2 needing review, 1 refused.** Address classification
is **inverted on purpose**: assume any stated address is real, look only for a stated
*non-location*. My first instinct — match what looks like an address — had already flagged Littlest
Bird Farm's "15624 115th AV SW" as address-less because the pattern did not know "AV". Spurious,
and in the dangerous direction. Same lesson the availability parser learned with ten false flags.

Corpus edge cases: **Pacific Crest** states two addresses and labels them, so `(farmstand)` wins —
publishing the mailing address is wrong in the way a customer discovers by driving there.
**Sweet Alyssum** ("Bank Road, East of Town") and **Peak Moon** ("300' north of 28815 Vashon Hwy
SW") are followable by a person but yield no coordinate, so they stay visitable, keep the farmer's
words, and carry `addressNeedsReview`. **Forest Garden Farm**'s entire submission is `(same info as
last year)` plus a name — refused here, resolvable from the map export.

**The two sources are complementary, not competing.** The form file has **no coordinates at all**;
the map export has them plus the farms that did not submit. So switching sources means the seeder
takes *both* — a material correction to the earlier "switch to the form file" framing.

Five sabotages, including **flagging everything for review**, which also fails — so the flag cannot
decay into noise.

### F-040: identity and channel are different questions

The gap: **`farmer_authorizations` has no writer outside tests.** Every insert in the tree is a
fixture. Publishing needs that authorization *plus* a farm approval; the approval has an operator
screen, the authorization has none — so a real farmer texting an update falls through to the
*customer* branch, and nothing reports why. A green suite cannot see this, because every test hands
itself the thing a real farmer has no way to get.

I first framed the design question as "pick a channel." max's answer — *"some farmers may prefer
web form, some prefer text… help me come up with a good system"* — was the better question, and the
fix was separating **identity** (a one-time trust step: VIGA always approves, either side may
start) from **channel** (SMS, texted link, or bookmarked form; all landing on the same confirmation
gate). No passwords: the phone is the identity, reusing F-032's magic-link mechanism.

max chose a bookmarked link that **never expires until revoked**, which makes revocation the only
safety net. Recorded with its consequence: revocation must take effect on the next request, VIGA
must be able to see and revoke every farmer, and the blast radius is bounded by construction — a
leaked link can at worst *propose* a wrong listing on one stand.

### Verified

`npm test` **556/556 across 57 files**; `npm run test:integration` **327/327 across 20 files** on
real Postgres 16, all **8** migrations from empty; typecheck 0 errors; lint clean;
`infra/plan-assertions.py` **29/29**; `infra/test_deploy_assertions.py` **10/10**; `tofu validate`
clean; `deploy_assertions.py` passes against live production. Evals **not** re-run — no seam
projection, schema, or output contract changed. B-020's deadlock did not reproduce across three
integration runs.

### The wrap found a silent production defect: migration 0007 was skipped

`npm run db:migrate` printed the target, printed **"migrations applied"**, exited 0 — and changed
nothing. Verifying by effect (not by the message) showed still 7 migrations, `public_address` still
NOT NULL, `coherent_visitability` absent.

**Cause: 0007's generated `when` was 1785352095637, OLDER than 0006's hand-rounded 1785500000000.**
Drizzle applies a migration only when its journal timestamp exceeds the newest already-applied
`created_at` (`pg-core/dialect.js`: `Number(lastDbMigration.created_at) < migration.folderMillis`).
Earlier timestamps are treated as already done, with no warning and no non-zero exit. Migrations
0002–0006 carry hand-rounded values; drizzle-kit generated a real clock value that fell before them.

**No suite could have caught it.** Every test database is built from EMPTY, where each migration is
compared against the row just inserted, so file order wins and out-of-order timestamps are
invisible. "All 8 migrations from an empty database" is genuinely green and genuinely blind here.
The defect is reachable only on a **partially migrated** database — which is to say production.

Fixed by renumbering 0007 to 1785600000000 (the same spacing as its neighbours; the snapshot chain
is UUID-based and unaffected), then re-applying and **verifying by effect**: 8 migrations, the two
new columns present, the three place columns nullable, the constraint present, and a `contact_only`
row carrying an address **refused by the database** inside a rolled-back transaction. Fingerprint
unchanged at 1 contact / 0 stands.
`packages/core/src/migration-ordering.test.ts` now fails on any non-increasing timestamp, and
treats a TIE as a defect too, because the comparison is `<`.

### The Terraform drift, finally pinned

The `gcloud` provenance annotations cleared on the apply. What remains is **permanent and not ours**:
the top-level `scaling` block, where the API returns `{manual_instance_count: 0,
min_instance_count: 0}` and the config omits the block, so the provider plans to null it and the API
echoes the defaults back. It never converges. So **"2 to change" is the expected steady state** —
read the plan's contents, never its count, which is precisely the conflation that made the original
no-op apply look real.

The apply created **no new revision** (00005/00006 still serving), correctly: `ROTATION_APPLIED_AT`
already held that value from the emergency fix, so the template was unchanged.
`deploy_assertions.py` passes against production.

Merged to `main` as `1df55df`; migration 0007 applied and verified by effect; `tofu apply` run with
plan assertions 29/29.

---

## 2026-07-29 — the cutover is thrown: B-009 re-proven, Vercel torn down, F-034 closed

The migration's remaining three legs, in one pass: point Telnyx at Cloud Run, **prove the B-009
class by effect on the new runtime**, and retire everything the migration superseded. Then
credential rotation, which max chose to fold into this work rather than defer a fourth time.

### The webhook switch, and a timestamp that lied again

`PATCH /messaging_profiles/<id>` returned the new `webhook_url` **and the old `updated_at`**. An
independent re-read showed the write had landed and the timestamp moved. Same shape as the
`vercel env ls` trap: **a write's echo of its own payload is not confirmation, and a dashboard
timestamp is not a last-updated field.** Re-read from a separate request or believe nothing.

max chose to switch **before** proving durability, accepting that real texts could land on an
unproven runtime; volume is zero and no farmer has the number, so the window was small. Recorded
because it was a deliberate trade, not an oversight.

### B-009 is not inherited — proving it took a key swap, and the sabotage came first

The standing rule is that a property belonging to the *platform* is proven **by effect in the
deployment**. Cloud Run's container lifecycle is a new runtime for "does post-response work actually
run", so the Vercel-era fix proves nothing here. `scripts/prove-post-response-work.ts` runs three
checks against the database — fast path, cold start, and a message whose task was **never created**
recovered by the schedule — and **searches for the B-009 signature** (committed + acknowledged +
never claimed) rather than assuming it absent. All three passed; claim-to-finalize was ~1s.

**Signing is the obstacle worth recording.** Telnyx's private key is not ours, so a genuinely signed
request needs the deployment to trust a key we hold. `TELNYX_PUBLIC_KEY` is plain config, not a
secret, so the proof ran against a revision carrying a throwaway public key — with max's explicit
approval, because **while that revision is live the number rejects genuine inbound SMS**. Restored
immediately and verified *behaviourally*: the throwaway key now returns `signature_mismatch`.

**The sabotage ran before the proof, not after.** Against the deployment still trusting Telnyx's real
key, checks 1–2 failed `ack=401` while check 3 passed on its own merits (it needs no signature).
That is what makes the harness credible rather than decorative.

**Writing it caught two defects in itself**, either of which would have made it lie:
`provider_inbox_events` has no `body`/`processed_at` column (it is `state`/`finalized_at`; the body
lives in `sms_messages`), and `hashPhone` is **HMAC-SHA256 under `PHONE_HASH_SALT`**, not a bare
digest — a test salt yields a row nothing ever claims, *indistinguishable from the failure the check
exists to detect*. Checking a harness against the real schema before running it is cheap; a proof
that quietly measures nothing is not.

Incidentally proven: the **full round trip works on this runtime**. A proof message's reply was
dispatched through Telnyx and its delivery callbacks returned through the new webhook URL — two
inbox rows I had not created, identified before cleanup rather than assumed to be noise.

### The record was wrong about the legacy data — again, and in the dangerous direction

The migration plan recorded, as max's decision, that the legacy project held no real data, and
deliberately **not** as a verified fact. Reading it found **37 Firestore documents**: 19 users, 3
farms, 5 messages, 8 agent decisions, 1 flag, and a `pending_users` row with `source: "join"`, a real
approval timestamp, and — unlike every user and farm row — **no `test_data` flag**. Auth held 1
account.

max confirmed test data and approved deletion. It was archived first to
`~/farm-friend-legacy-archive/` (Firestore + Auth + non-secret manifests), and the delete **refused
to run** unless a re-read fingerprint matched exactly and the archive held all 37 docs. This is the
second time "assumed empty" was wrong in this project; the first was the reset script that found 6
volunteers and 2 farms with phone numbers. **The rule keeps paying for itself.**

Two smaller plan claims were also stale: the seven legacy schedulers were already `PAUSED`, not
still firing, and the always-warm charge ended with the services rather than needing `minScale=0`.

### Teardown

Deleted: the Vercel project and its env vars (Telnyx re-confirmed pointing elsewhere first), both
stale branches (`throwaway/hobby-deploy-test` **and** `f-019-sms-only-inquiry-boundary` — the second
was not on anyone's list), 17 legacy functions plus the 15 Cloud Run services behind them, 7 legacy
schedulers, 6 unreferenced legacy secrets including the STALE `TELNYX_API_KEY` that returned 401,
the Firestore/Auth contents, and the empty `farm-friend-497422` project. `farm-friend-vashon` now
holds **only** Farm Friend. Verified afterwards by listing each resource type and by every live
surface still answering correctly.

### F-034: rotation, and two traps

max reversed the third deferral and folded rotation into this session. `DATABASE_URL`,
`DEEPINFRA_API_KEY`, and `MAGIC_LINK_SECRET` rotated; **`PHONE_HASH_SALT` untouched, deliberately**.
Old values confirmed dead **by effect** — `password authentication failed` and 401 — never by
assuming a console did what it said.

**Trap 1: `version = "latest"` does not reach a running container.** Cloud Run reads secrets at
container start, so between the Neon password reset and the redeploy, production was serving on a
**revoked** password. `gcloud secrets versions add` alone changes nothing already running; the
redeploy is the step that applies a rotation.

**Trap 2: a scripted `.env` edit silently did nothing.** The regex assumed `KEY="value"`, but
`DEEPINFRA_API_KEY` is written **unquoted** in that file — so the substitution matched zero lines,
reported success, and left the dead key in place. It surfaced only when `evals:live` returned
`provider_error` on all six quality cases. **`live-containment` still read 4/4 through that
failure**, because a refused call counts as contained — so a containment-only pass is *not* evidence
the model path works. The corrected edit asserts its match count and refuses on anything but exactly
1. New values were verified *before* being stored, so a bad credential could not later be
misdiagnosed as a broken deployment.

`keys.txt` (how the values were supplied) was **untracked but not gitignored** — a `git add -A`
would have committed it. Deleted, and the tracked tree greps clean for both new values.

### Then a real handset broke it, twenty minutes after the synthetic proof passed

max texted `Help` at the end of the session as the real-handset check. It committed, and then sat at
`state=pending` for 75+ seconds with no reply — **the exact B-009 signature, on real traffic, on a
runtime I had just proven**. It was not B-009. Every database call was failing
`28P01 password authentication failed`: the rotation's new `DATABASE_URL` had never reached the
containers.

`gcloud secrets versions add` wrote version 2 at **16:35:29**. The newest revision was created at
**16:09:26** — twenty-six minutes *earlier*. Cloud Run reads secrets **at container start**, so
`version = "latest"` binds at startup and never re-reads; the `tofu apply` I ran after adding the
versions altered nothing in the revision template, created no new revision, and reported "2 to
change" while changing nothing that mattered. **A green apply is not a restart.** Filed as **B-021**.

**The humbling part is how the verification missed it**, because the checks were the right *kind*
(by effect, not by reading a value back) and still proved nothing:

- `/api/public/stands` → `{"stands":[]}` came from a **warm container** whose pooled connections
  predated the Neon reset. *A warm connection keeps working after the password behind it changes* —
  only a new connection re-authenticates. And an empty array is indistinguishable from an empty table.
- The scheduler **200** I cited was read *before* the rotation apply and carried forward as current.
- `evals:live` 6/6 runs **locally against local `.env`** and never touches the deployment at all.

The check that settles it is a timestamp comparison: **revision creation time vs. secret version
create time.** An older revision means nothing picked the value up, whatever any endpoint returns.

Forcing revisions (worker 00006 / web 00005) fixed it, and the stuck message was recovered by the
very next scheduled pass — inbound `processed`, reply `sent` with a real provider message ID,
`accepted`, 2 delivery callbacks back through the Cloud Run webhook, and `sms_consents` correctly
**empty** because HELP does not move consent. **The full round trip is now proven on real traffic,
not just synthetic.**

Two things this leaves: production now holds **one real phone number** (max's), which is the event
F-034 named as closing the exposure window — rotation landed first, so the order held. And a
**persistent `tofu plan` drift** reporting "2 to change" on a clean tree is still unexplained; until
it is, "the plan showed changes" is not evidence a deploy did anything. Both on B-021.

**The standing lesson, sharpened: a synthetic end-to-end proof and real traffic are not the same
runtime either.** `prove-post-response-work.ts` passed at 09:08 against a container started before
the rotation, so it proved the durability property honestly and told me nothing about the
credential. It took a handset to find it — the same family as B-009 (local ≠ deployed), B-005–B-008
(hoisted ≠ isolated install), and F-024 (stub ≠ real model), one level further out.

### Verified

`npm test` **528/528 across 55 files**; `npm run test:integration` **311/311 across 19 files** on
real Postgres; typecheck and lint clean; `npm run evals:live` **containment 4/4, quality 6/6** on the
rotated key. `npm run evals` not re-run — no seam projection, schema, or output contract changed.
`infra/plan-assertions.py` 24/24 on both applies. **Live round trip verified by a real handset** (see
above), on revisions worker 00006 / web 00005.

**One pre-existing flake recorded, not waved off.** An integration run failed
`a verified STOP unsubscribes end to end and calls no model` with PostgresError **40P01 deadlock** on
a fixture `truncate`, and passed on rerun. This branch changes no application or test code, so the
flake lives on `main`; the contention is between suites' truncates, not in Farm Friend's locking.

---

## 2026-07-29 — the GCP migration: Farm Friend is live on Cloud Run, and a lost salt

Vercel → Google Cloud Run, per `docs/GCP_MIGRATION_PLAN.md`. The driver was cost and licensing, not
a defect: Hobby is restricted to non-commercial personal use and Farm Friend does not qualify, so
Vercel meant ~$20/month indefinitely against VIGA's zero budget. GCP at launch volume is ~$0. Two
independent gains came with it — Cloud Tasks is durable where `waitUntil` was cancellable, and the
manual `crons`-strip left the deploy path.

**The deployment is live and verified by effect**: `https://farm-friend-web-p5mfxfp5za-uw.a.run.app`.
Health 200, `/api/public/stands` 200 against real Neon, admin 403, `/api/internal/{cron,kick}` **404
on the public service**, the worker unreachable from the internet, webhook **401** (not 500/503), and
a scheduled pass returning **HTTP 200** on revision `00003`.

### The cost premise was wrong by 13×, and max was right that it did not matter

The plan claimed the legacy always-warm functions cost $15–25/month and called killing them "the
single highest-value action in this document". The actual bill says **$1.57**. The error is worth
recording because it will recur: the arithmetic assumed idle CPU on a held instance bills at *some*
rate and bracketed $10–43 by varying it. Under request-based billing it bills at **none** — the
console shows only *"Cloud Run functions Min-Instance **Memory**"*, with no CPU counterpart. Two
plausible bounds from a pricing page both missed an answer that was zero.

I let that correction sound like it undercut the migration. It did not: the case is Vercel Pro ~$20
vs ~$0, and the $1.57 is a footnote. **A figure derived from a pricing page is not a cost.**

### The legacy functions could not be fixed, only deleted

`minScale=0` on `inbound-sms`/`simulate-inbound-sms` was the plan's "do this immediately" item. It
is **impossible**: `gcf-artifacts` holds **zero images** for 17 functions — the images were
garbage-collected out from under running services. They still served traffic from cached layers but
every revision attempt failed `image not found`, including one pinned to the digest the live
revision itself reported. Deleted with approval (archived config first, fingerprinted, zero
references in current code); seven schedulers firing into them paused. Verified by effect: 15
services remain, zero always-warm, all instances drained to 0.

The lesson is in `infra/main.tf`: the new Artifact Registry repository is **dedicated and carries a
cleanup policy that keeps recent releases**. Reusing Firebase's managed repo is what produced the
zombies.

### `waitUntil` → Cloud Tasks, and the await direction inverts

On Vercel the rule was *never await the kick* — the awaited thing would have been the passes, a
model call and a provider call inside the request Telnyx waits on. Now the awaited thing is only the
**task creation**, one bounded call, and awaiting it is what makes the work durable **before** the
handler returns. A fire-and-forget enqueue would reintroduce B-009 exactly: a floating promise the
runtime may discard when the container is reclaimed.

`kick-survival.test.ts` and `kick-wiring.test.ts` were **re-anchored, not deleted** — the defect
class survives the migration, only its mechanism changed. Sabotage: `await`→`void` fails 3 tests;
moving the acknowledgement after the enqueue fails 2.

Enqueueing **never throws and never retries**. The inbox event is already durable and the 200
already built, so a queue outage must not turn a successful ingress into a 5xx that makes Telnyx
retry a message we accepted. `ALREADY_EXISTS` counts as success — a webhook retry produces the same
deterministic task name, and the queue refusing the duplicate *is* the deduplication working. Task
names are **hashed, not sanitized**: stripping unsafe characters is not injective, so `evt/1` and
`evt1` would collapse and one sender's work would vanish.

**Cloud Tasks over REST, no SDK.** `@google-cloud/tasks` is 11.6 MB unpacked plus `google-gax`
(gRPC + protobuf), all landing in a container whose cold start sits on the SMS reply path, to make
one POST to one documented endpoint.

### `CRON_SECRET` was removed rather than kept beside IAM

The internal routes are now worker-only, reached through Cloud Scheduler's OIDC against an
internal-ingress service. Keeping the shared secret "for defence in depth" would have preserved its
actual failure mode — one credential in two places that had to match, where a mismatch returns 401
and **a 401 looks identical to success in any scheduler's UI** — while protecting against nothing,
since a caller who cannot satisfy IAM never reaches the code to present a token.

The in-process `DEPLOYMENT_ROLE` guard is explicitly the *second* door: it runs **before**
`appContext()` so the public service never builds a database pool for a route it does not serve, and
answers **404** rather than 403 to leak no hint the surface exists.

### The abuse throttle was about to become a no-op

`clientSignalFor` read the **leftmost** `X-Forwarded-For` hop. Correct on Vercel; **backwards on
Cloud Run**, where the caller controls everything it sends and Google *appends* the observed
address. Carried across unchanged, an attacker sends a random leftmost hop per request and lands in
a fresh bucket every time — the throttle removed, not weakened. Now reads the rightmost non-blank
hop. Sabotage: reverting fails 3 tests.

### PHONE_HASH_SALT was lost, and "never rotate" turned out to have an exception

The production salt was set in Vercel marked **Sensitive** — write-only, unreadable by anyone — and
recorded nowhere else. `vercel env pull` returns `[SENSITIVE]`. **Storing a secret somewhere
unreadable is the same as not recording it.**

The absolute rule means "there is no way back", and that holds only once the raw numbers are gone.
While `contacts.phone_e164` still holds the raw E.164 — the one column that stores it — every hash
can be recomputed. Production held 2 contacts from live SMS testing with both raw numbers intact, so
this was recoverable rather than fatal. max chose to **wipe** (none of it was real data): 71 rows
across 7 tables removed, fingerprint-guarded in one transaction. Verified by effect: 0 phone rows,
0 raw numbers, schema intact at 7 migrations.

`npm run db:rehash-phones` is kept as the documented recovery path, and **two simpler versions of it
failed against a real database first**:

1. *children first, contacts last* — children immediately reference a parent hash that does not
   exist yet.
2. `set constraints all deferred` — **no effect**. All **eleven** foreign keys onto
   `contacts.phone_hash` were created NOT DEFERRABLE, so deferral cannot be asked for at runtime.

The working shape is insert-new-parent → repoint-children → delete-old-parent. Verified end to end:
2/2 contacts match the new salt, 6/6 messages and 2/2 consents preserved, zero orphans.

### Four defects only a real build or a real deployment could find

Every one passed every local check first.

1. **`$PROJECT_ID` is not expanded inside a user-defined substitution's default value.** It arrives
   literally; docker rejected the tag.
2. **`COPY apps/web/public`** — this app has no such directory. A COPY of a missing path is a hard
   failure, not a no-op.
3. **The constructed Cloud Run URL was wrong.** `SERVICE-PROJECTNUMBER.REGION.run.app` is not the
   format; Cloud Run assigns `farm-friend-worker-p5mfxfp5za-uw.a.run.app` — opaque per-project
   suffix, *shortened* region. Caught only by the `url_assumption_holds` output written for exactly
   this, because a wrong URL here is **silent**: tasks and scheduled runs 404 forever while every
   service looks healthy.
4. **`PUBLIC_BASE_URL` on the web service alone crashed every scheduled run.** The worker's
   `resolveConfig` requires it and fails closed. Found by reading the worker's logs after forcing a
   run; the apply was green throughout.

Reading `.uri` back off the services is the obvious fix for (3) and **cannot work**: every service
needs `PUBLIC_BASE_URL`, so any service URL fed into shared config makes that service depend on
itself. Two applies hit that cycle from opposite directions. The host suffix is now an explicit
documented input, and three plan assertions pin the task target, the shared base URL, and the
worker actually having one.

### The Telnyx credentials were re-fetched, not copied — the legacy ones are stale

The plan says the legacy Secret Manager entries hold the same exposed credentials. **Tested: the
legacy `TELNYX_API_KEY` returns 401 against the live API.** Copying it would have produced a dead
SMS path that looked correctly configured. All four new values verified live before use: API key
200, public key decodes to 32 bytes *and* matches `/v2/public_key`, from-number valid E.164 and on
the matching messaging profile.

Note the public key legitimately did **not** change — it belongs to the account and does not rotate
with an API key. Its byte-identity with the legacy copy is correct, not a mistake.

### A source assertion matched its own explanatory comment

Third instance of this trap in this repo, after an import line satisfying a `waitUntil` check and a
loose alternation matching a CLI flag. The prohibition on `waitUntil(` matched the *comment*
explaining why `waitUntil` is absent. The helpers now strip comments as well as imports. **Prose
about a construct is not the construct.**

### Owed

Rotation (F-034) **deferred again** — sound only while no real phone numbers exist, and the database
is now empty, so the window is genuinely open. The first real inbound SMS closes it. Telnyx's
webhook still points at Vercel; the Vercel project, the stale `throwaway/hobby-deploy-test` branch,
and the legacy Firebase resources are all still owed a teardown. B-002 production seeding remains a
deliberate not-yet.

---

## 2026-07-28 — the housekeeping checkpoint: GL-031/032/034/035/036, and a rotation procedure that would have broken production

Third go-live tranche, and the one Max asked to review before P1. Five items, four of them
documentation truth-telling. Same method as last session — one item per subagent in an isolated
worktree, then verify every claim by *running* it here. That method earned its keep twice below.

### GL-035 — two of three "dead mechanisms" were not dead, and one deletion would have been serious

The guide proposed deleting `roles.ts`, the `SmsSimulator`/`SmsTransport` family, and
`openOrReviseProposal().activate()`. I wrote a starting map from my own greps and **got two of the
three wrong**, in the dangerous direction. The subagent contradicted me on both; I re-checked and it
was right.

**`roles.ts` is live.** My grep looked for the import *path* (`from "./roles"`, `auth/roles`) and
found only its own test and the barrel. But `@farm-friend/core` **is** a barrel, and production
imports through it: `apps/web/lib/admin-guard.ts` — the one guard all five admin API routes share —
calls `requireRole` and `AuthorizationError`, and four admin pages call `hasRole`. Deleting the file
would have deleted the live admin authority check. What was genuinely dead is narrower: the
`staff`/`farmer` values and the "admin implies staff" `IMPLIES` table, which nothing could ever
produce (`packages/db/src/admin.ts` returns the constant `["admin"]`). `Role` is now `"admin"` alone.
An implication table that can never fire reads as protection while proving nothing.

**The parallel SMS path was real, and it held the safety proof.** Correction to my map in the other
direction: `SmsTransport` is *not* the live seam — `createLastMileSender` takes a `ProviderTransport`
(a plain function type in `delivery.ts`), and that is what the composition root wires Telnyx into.
`SmsTransport`/`OutboundMessage`/`SmsSimulator`/`SentMessage` plus the metrics logger were reachable
only from the package's own tests.

The consequential part: **`safety-boundary.type-test.ts` — the Golden Rule #6 layer-1 compile guard
— asserted the branded outbound type against `OutboundMessage`.** The static provenance barrier was
being proven of a path production never took. That is the exact failure family CLAUDE.md already
documents twice (a source assertion satisfied by incidental text; a stub that cannot see what the
real thing does), one level up: *a safety proof anchored to dead code is not a safety proof*.
Re-anchored to `LastMileSendInput`. I sabotaged it myself rather than trusting the report — erasing
the brand fails **both** bypass assertions.

`estimateSmsSegments` and `normalizeAvoidableSmsUnicode` were kept deliberately: the normalizer is
already on the real path via the outbound guard, and the estimator is precisely the machinery
**GL-021** exists to attach to the real send path. Deleting it would mean rebuilding it in a fortnight.

**`activate()` was the genuine duplicate — and the two writers had already diverged.** Production
activation lives in the outbound worker (`apps/web/lib/workers.ts`); the test-only `activate()` wrote
the same three columns differently: it targeted `where id = proposalId` with no state guard, while
production matches `state = 'open'` + recipient + `inventory_confirmation`, and copies
`proposal_version` **in SQL** rather than reading it first (a read-then-write can record a version a
concurrent revision already superseded). Ten integration tests exercised the synthetic path, so any
drift between them was invisible. Now one exported `activateAcceptedPrompt` in `packages/db`, called
by both — tests adapted to production's behavior, never the reverse. My own sabotage of the shared
write fails **11 integration tests** across 2 files, and trips the `activation_coherent` CHECK
constraint besides.

### GL-034 — the code was right; the words a farmer reads were not

B-011 established that the carrier owns STOP/START: `START` lifts Telnyx's block, `JOIN` does not,
so JOIN enrolls only a first-time sender. `consentTransitionFor` implements that exactly.

The gap was `docs/VIGA_10DLC_WEBSITE_COPY.md` — the paste-ready public Squarespace copy, i.e. what
someone reads *before* they ever text. Its Opt Out section said messaging stops "unless you request
to rejoin", **naming no keyword at all**. A reader who was just told the opt-in word is JOIN reaches
for JOIN, is refused, and stays blocked with no idea why. No test policed that file. Five sections
now name START for the returning path; JOIN stays as the first-time call to action, and the new test
is scoped to the opt-out section so a whole-document ban can't creep in and break the registration.
Sabotage-verified here, not just reported: reverting the section to JOIN fails both assertions.

Registered 10DLC copy and `TELNYX_10DLC_FIELD_VALUES.txt` were untouched — that file is a transcript
of live console state, and the rule is change the console first, then transcribe. Two optional
console edits are written up under GL-034, and my recommendation is **to weigh them, not just do
them**: Telnyx auto-answers STOP/START in its own copy and enforces its block list independently of
the profile's auto-response fields, so neither edit changes what an opted-out user experiences. They
buy registration-vs-page consistency against the cost of a possible campaign re-review.

### GL-031/032/036 — the docs stop carrying status, and stop claiming authority they no longer have

Max made two calls that shaped this: **status lives in CLAUDE.md only** (docs drop their build-status
banners entirely rather than getting corrected ones — five fewer places to go stale), and the
**session logs stay exactly as they are but leave the reading path** (nothing rewritten; they simply
stop being startup context).

The risky half of retiring the clean-room handoff was not removing the banners — it was making sure
nothing it *settled* existed only there. Three things did, and were moved before the banners came
off: code-owned message-frequency limits (→ ARCHITECTURE, written as an explicitly **unbuilt**
requirement, since no cadence cap exists anywhere in the code), the excluded-infrastructure list —
no Kafka, event bus, event sourcing, workflow engine, distributed lock, policy engine, DLP, vector
database, additional package (→ ARCHITECTURE's design stance), and the disambiguation that
retrieval-first means before *fact selection*, not before *interpretation* (→ AI_ARCHITECTURE).

Stale claims corrected: ARCHITECTURE listed customer inquiry, stock-out, retention, authentication,
and the model privacy boundary as "Not implemented" — all five are built; AI_ARCHITECTURE said "the
configured provider is still the deterministic stub" 140 lines before documenting the DeepInfra
adapter; PRODUCT_BRIEF listed eleven decisions as open when seven were settled in code; `maps/README`
still called the seeder future work. Two the review had not named: ARCHITECTURE claimed a QR
stock-out **web form** as a built surface (only the API route exists), and the RUNBOOK finding below.

### The find of the session: a rotation procedure that would have broken production

`RUNBOOK.md` §"Credential rotation" said `DEEPINFRA_API_KEY` is **not** a production credential —
"absent from Vercel entirely, so the deployment runs the deterministic stub" — and instructed
rotating it in the DeepInfra console and **local `.env` only**. That was true when written. **GL-019
made it false** by setting `LLM_PROVIDER=deepinfra` in production, and nothing went back to correct
the rotation instructions. F-034's own PM checklist and CLAUDE.md carried the same line.

So the documented procedure for the one remaining go-live blocker would have revoked the key while
production kept calling DeepInfra with it — every model seam failing in the deployment, while local
`evals:live` stayed green because the local `.env` had just been updated. Corrected in all three
places, with an instruction to confirm a variable's presence in Vercel before rotating rather than
trusting any table, including that one. This is the same reasoning-from-a-stale-record error as
trusting `vercel env ls`'s timestamp column, and the reason the honest check is always behavioural.

### Verified

`npm test` **498/498 across 53 files**; `npm run test:integration` **311/311 across 19 files** on
real Postgres 16; `npm run evals` critical **11/11**, advisory 4/4, adversarial **29/29**; lint, root
typecheck, and `next build` all exit 0. **All run on the merged result**, not on the branches —
neither subagent tested the combination, and the merge is what ships. `evals:live` not re-run: no
seam projection, schema, or output contract changed.

One integration run early on failed two files with **hook timeouts**, then passed 19/19 twice — the
documented environmental signature (a failure that *moves*). It coincided with a second suite I had
running against the same Postgres.

### Owed

P1 (GL-007 onward) is next and unstarted. **GL-001 credential rotation remains the hard go-live
blocker**, now with a corrected procedure. Two optional Telnyx console edits under GL-034. GL-021
will consume `estimateSmsSegments`, kept for exactly that.
