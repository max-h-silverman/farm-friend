# Farm Friend — Session Log

Newest-first, on-demand build history: what was built each session, the decisions and rationale
that aren't obvious from the diff, and what was verified/owed. The **live snapshot** of what's
true/unfinished now lives in [../CLAUDE.md](../CLAUDE.md) "Current State & Open Items"; this file
is the *why behind past changes*.

Older entries are rotated into
[SESSION_LOG_ARCHIVE.md](SESSION_LOG_ARCHIVE.md) (last rotated 2026-07-29 at 19 entries / 159k
chars — the char count is the binding threshold, since a log too large to open mid-session defeats
its own purpose). The archive now holds 34 entries.

---

## 2026-07-29 (latest) — F-041 offerings seeded, F-039 the vCard, and a farmer's address we should never have published

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

---

## 2026-07-28 — P0 closed except rotation: one-use links, a truthful typecheck, a repaired migration generator

Second go-live tranche. **GL-004, GL-005, GL-006 closed**; P0 now holds only GL-001, whose
remaining work is max's provider-console rotation. Delegated one item at a time to subagents in
isolated worktrees, then verified every claim by running it here rather than reading the summary —
which is what caught the two corrections below.

### GL-004 — the magic link was a signature, and a signature repeats

`verifyMagicToken` was pure HMAC over `{email, issuedAt, expiresAt}`. A signature says "authentic"
every time it is asked, so every callback inside the 15-minute window minted a fresh session, while
`sign-in-email.ts` had promised "can be used once" since F-032. A link forwarded, scanned by a mail
gateway, or sitting in a shared inbox was a working credential for the whole window.

**The fix is a column, not a table.** Each link carries a random 32-byte nonce inside its signed
payload; the callback stores its SHA-256 in `admin_sessions.magic_nonce_hash` under a unique index,
written by the *same insert that creates the session*. A link being spent and a session existing
are the same event, so there is no second record to reconcile and no window where one exists
without the other.

The rejected design is the more interesting half. A separate credential table would have to be
written at **mint** time — that is, from the internet, by anyone who can guess an operator's
address. That is both an unauthenticated write path and a per-address row whose presence is exactly
the membership oracle `/api/auth/request-link` exists to deny. Minting still writes nothing; the row
appears only when a link is *opened*, by someone already holding a validly signed one.

The arbiter is `on conflict (magic_nonce_hash) do nothing returning id`, where the empty result is
the signal someone else won — not a check-then-write, since `for update` cannot lock a row that does
not exist yet (the B-011 lesson). Authority is re-read **before** the link is spent, so a revoked
operator's link is refused without being burned. `link_already_used` and `not_an_administrator` both
render 401, so a replayed link is not a probe for which links were genuine. Legacy tokens with no
nonce fail closed as `malformed` rather than defaulting to a placeholder — a placeholder would give
every such link the same identity, so opening one would consume all of them.

**A race test that could not fail, caught by sabotage.** The first draft ran eight `Promise.all`
calls through one `Db` handle, whose pool holds three connections — so each transaction completed
before the next began and the read-then-write sabotage passed untouched. Each claimant now gets its
**own connection** plus a barrier so all eight reach the insert together. This is the `Promise.all`
rule with a pool-size twist the standing rules did not previously state.

### GL-005 — the typecheck was blind to the whole web app, and hid a production defect

Root `tsconfig.json` referenced only the four packages, so "typecheck passes" was a claim about
`packages/`, never `apps/web`. Behind that blindness sat **57** errors — and 17 of them were a
latent **production** defect, not test noise: `type Sql = ReturnType<typeof postgres>` picks the
last of two overloads and evaluates its conditional against the *unresolved* generic, collapsing the
type map to `never`, so the tagged template accepted **no parameters at all**. `sql`…${id}`` failed
to typecheck while working perfectly at runtime. `Sql`/`Tx` now live once in `packages/db/src/sql.ts`
(`Tx` had separately drifted to a contravariantly incompatible type map).

The other 27 were fixed by **narrowing the production signature rather than widening the test's
lie**: `resolveConfig`/`createAppContext` now take `Record<string, string | undefined>`, which is all
they ever read, and which `resolveSmsConfig` already used — so this made two conventions agree
rather than adding a third. Nothing suppressed: zero `@ts-expect-error`, `any`, or `exclude` globs
added.

Root `typecheck` is now `typecheck:packages && typecheck:web`, two halves because
`apps/web/tsconfig.json` is `composite: false` and `tsc -b` cannot reference it. **Proof it is
genuinely truthful:** a deliberate `TS2322` in a web file — GL-004's callback route, which the
subagent never saw — exits **1** under the new typecheck and **0** under the old bare `tsc -b`.

### GL-006 — the migration generator was guessing at history

Seven migrations journaled, snapshots stopped at `0001`. Reproduced before fixing: a generation
trial stopped and asked *"Is message_category column in outbox_work table created or renamed from
another column?"* — a column migration `0002` added. Snapshot `0001` described 22 tables against a
schema of 25.

**Applying was never affected**, which is precisely what kept this invisible: the integration suite
builds a database from empty and applies all seven on every run. Only *generation* was
untrustworthy, and the danger is not that the tool errors out — it is that a wrong answer to a
rename prompt writes a plausible migration that re-creates existing tables or renames a column out
from under production data.

**Repaired with one file.** Reading drizzle-kit 0.22.8's source rather than assuming: it diffs
against `snapshots[snapshots.length - 1]` **only** (`preparePrevSnapshot`) and enumerates snapshots
from the directory listing, not the journal. So a single current `0006_snapshot.json` chained onto
`0001` is the complete fix. Reconstructing the five missing intermediates was deliberately **not**
done — five point-in-time pictures nobody can verify against a database would be fabricating
evidence rather than repairing metadata, and the tripwire asserts the rule the tool actually has
rather than a stricter invented one. No `.sql` file changed: the md5 over all seven is byte-identical
before and after. The trial now reports *"No schema changes, nothing to migrate."*

### Two subagent claims that did not survive verification

Both found by running the thing rather than reading the report, which is the whole reason the
verify-don't-relay rule exists.

- **"`npm run lint` exits 0 while printing errors"** — filed as a proposed new item. It does not: a
  deliberate unused import produces `✖ 1 problem` and **exit 1**. The likely cause is reading a
  piped exit status (`${PIPESTATUS}` vs `$?`). No item filed.
- **CLAUDE.md's "54 web type errors"** was stale; the real baseline was **57**, confirmed twice
  before GL-005 started.

Also corrected mid-session: the main agent committed the three agent worktree directories into the
repo by accident (`git add -A` swept them in). Removed from the commit and `.claude/worktrees/`
added to `.gitignore` so it cannot recur.

### Deployed and migrated, verified by effect

Pushed straight to `main` (max's call — the work was already verified, and the repo's Vercel check
is permanently red for unrelated reasons). Migration **0006** applied to production and the CLI
deploy promoted, in that order, so production never ran code ahead of its schema.

The connection string came from max — **Vercel's `DATABASE_URL` is unreadable** (`vercel env pull`
returns `[SENSITIVE]`), which is a standing constraint, not a one-off. Before migrating, the target
was **fingerprinted** rather than trusted: `neondb`, 6 migrations applied, 21 `sms_messages` and 21
`outbox_work` rows from live testing, 0 stands. That is unmistakably production and not a copy — the
discipline the reset-script near-miss taught. max used the **direct (non-pooled)** Neon string, which
is the right endpoint for DDL and does not affect what the app runs.

Proof by effect after the deploy: 7 migrations, `magic_nonce_hash` present and nullable,
`admin_sessions_one_per_magic_nonce` created; health 200, `/api/public/stands` 200 `{"stands":[]}`,
cron **401**, webhook **401**, admin **403**. The webhook's 401 rather than 500 is the load-bearing
check — under the three-way diagnostic it proves configuration still resolves. Sign-in returned
**202 for every address**, including a real administrator address, a stranger, and a malformed one,
so enumeration resistance survived; the callback answered **401** to a garbage token rather than
500, which is what a schema mismatch would have produced.

`apps/web/vercel.json`'s one-minute `crons` block was stripped **uncommitted** for the Hobby deploy
and restored immediately after, per the standing procedure.

**Honest limit on the GL-004 proof:** production holds **0 administrators**, so the one-use replay
was not exercised end to end against the live deployment. It is proven by the integration suite and
by hand-run sabotage locally, and the deployed code path is confirmed only as far as "does not error
against the real schema." Closing that gap needs a bootstrapped administrator, which is a deliberate
authorization grant rather than wrap housekeeping.

---

## 2026-07-28 — three defects the green suites could not see, and production was running the stub

First tranche off `docs/GO_LIVE_GUIDE.md`. GL-002, GL-003, GL-019 and GL-033 closed; GL-001
scoped and deferred by max. Every finding was reconfirmed against the code before being fixed —
the guide is a review artifact, not a spec, and one of its claims was wrong.

### GL-001 — the scope was wrong in both directions, and the repo was never leaking

Checking the live environment instead of the notes corrected two things. **The DeepInfra key is
not a production credential**: `LLM_PROVIDER`, `DEEPINFRA_API_KEY`, and `DEEPINFRA_MODEL` were
absent from Vercel entirely. It rotates in the DeepInfra console, not Vercel — and that absence
turned out to be a live defect in its own right (GL-019, below). **The repository is clean**:
`git grep` over the tracked tree finds no real connection string, key, or Neon host; every
secret-shaped literal is a test fixture and `.env` has never been committed. So rotation is the
complete remedy — no history rewrite, nothing published to recall.

The procedure now lives in RUNBOOK §"Credential rotation" with proof-by-effect tables for both the
new values and the old. max decided **rotate in place** — the throwaway Hobby project and its Neon
database become production, so F-034's "tear down the project" line is withdrawn (its stale branch
is still owed a deletion) — then **deferred the rotation itself**. Sound only while the database
stays unseeded; that constraint is now written into the item rather than assumed.

### GL-002 — a delayed STOP was silently discarded

`runInboundPass` rejected every stale event *before* parsing it. So a `STOP` delayed in the carrier
network, arriving after a newer ordinary message had advanced the conversation watermark, was
finalized `stale_conversation_event` and never reached `applyConsentTransition`. The sender opted
out; Farm Friend recorded them active and would have kept sending.

The staleness rule was sound but **scoped wrong**. It protects *conversation* state, and the two
watermarks are independent — consent orders itself on `consent_transition_watermarks`, where an
older START cannot undo a newer STOP and STOP wins an exact tie. The conversation watermark
therefore has no standing over a compliance keyword.

So the fix is not an exception carved out for STOP; it is the rule applied to the state it actually
protects. `routeInboundMessage` takes staleness as an input and owns the decision: compliance
parsed **before** the gate, the gate applied to free text and confirmation tokens only. Consent
ordering is untouched. Finalizing a routed stale event `processed` is safe because
`claimNextInboundEvent` already guards the watermark update with `!isStale`.

The test asserts the opt-out comes back from `authorizeDispatch` as **`suppressed`** — consent that
changes state without reaching the dispatch guard is a paper opt-out. Sabotage both ways: restoring
the old order fails only the delayed-STOP test; deleting the gate fails only the two stale-refusal
tests.

### GL-003 — two holes, not one

`authorizeDispatch` commits `dispatching` before the body read, redaction, recipient resolution,
provider call, and result recording. `dispatching` was written in **exactly one place and read by
nothing** — `releaseAbandonedClaims` recovers inbound events only, outbound enumeration selects
`queued`. And `runOutboundPass` had **no error handling at all**, so one throw aborted the whole
pass and blocked every other sender's reply.

Two defenses, deliberately different in kind, because neither substitutes for the other: a per-row
`catch` (a lease cannot isolate a row mid-pass) and a durable 10-minute lease (a killed process
runs no catch block).

Recovery resolves to **`ambiguous`**, never `queued`. We cannot know whether the provider accepted
the message before we lost the thread, and requeueing would resend an SMS a real person may already
be holding. That is precisely what `ambiguous` already meant here, so it reuses the state and
**needed no migration** — the elegant path was also the correct one. The lease is deliberately
generous: expiring it on a merely slow call would quarantine work about to succeed, and a delayed
reply is a smaller harm than a duplicate message.

**Deliberately not built:** an operator view of quarantined work. The state is durable and
queryable; somewhere to *read* it belongs with GL-016/GL-018, and the dependency is noted in both
items rather than becoming a third bespoke surface.

### GL-019 — production had been running the test double its whole life

Pulled forward from P2 at max's request, because it was affecting the live site right then.
`resolveModelConfig` defaulted to `"stub"` when `LLM_PROVIDER` was absent, and production never had
it set. Every model-backed journey degraded into a clarification while health checks, the webhook,
and all 479 tests stayed green — because from the code's point of view nothing was wrong. The
default had been chosen.

The guide asked for "explicit provider selection **in production**," which invites environment
sniffing. This codebase already refuses that: `cron-auth.test.ts` asserts the cron route contains
no `NODE_ENV`/`VERCEL_ENV`, on the reasoning that a guard which relaxes in development is one
misconfigured deploy from being public. **That is exactly how this defect survived** — the default
behaved identically everywhere it was tested. Put to max, who chose **refuse everywhere**:
`LLM_PROVIDER` is now required with no default, like `PHONE_HASH_SALT`. The stub is unchanged and
still used by tests, evals, and local dev; it lost only the ability to be selected by accident.

Six unit fixtures and two integration suites relied on the implicit default. They now state
`LLM_PROVIDER=stub` — the assertion was not loosened to accommodate them. A source assertion
anchored to the selector pins both "no `??` default" and "no env flag"; sabotage-verified against
the old default *and* against a `VERCEL_ENV === "production"` variant.

`.env.example` was created (**GL-033**), which this change turned from merely missing into
load-bearing: without it a developer cannot start the app.

### Production configuration, verified by effect

max set `LLM_PROVIDER=deepinfra`, `DEEPINFRA_MODEL=mistralai/Mistral-Small-24B-Instruct-2501`, and
`DEEPINFRA_API_KEY` in Vercel, and un-marked four variables that were needlessly **Sensitive**
(`SMS_PROVIDER`, `PUBLIC_BASE_URL`, `TELNYX_PUBLIC_KEY`, `TELNYX_MESSAGING_PROFILE_ID` — a provider
name, a public origin, verification material, and an identifier). Vercel's Sensitive flag is
one-way, so each had to be deleted and re-added; the cost of the flag is losing the ability to
confirm what production is set to.

Verified after redeploy: health 200, cron 401, stands 200, admin 403, and webhook **401 rather than
500** — under the three-way diagnostic that proves every Telnyx credential still resolves. The
sharper check: a deliberately malformed signature returns **`malformed_signature`**, which means
the handler loaded `TELNYX_PUBLIC_KEY` and decoded it as a valid 32-byte ed25519 key before
rejecting the junk. "Non-empty" and "correct" look identical in a dashboard; this distinguishes
them. `vercel env pull` now reads back the four un-marked values and still returns `[SENSITIVE]`
for all six real secrets.

**Consequence: DeepInfra calls now cost money on real traffic.** Under $1/month at launch volume,
but no longer zero.

Merged as `c0c2b4e` (PR #53, squash) and **deployed the same session** — the standing rule after a
past session found three merged fixes production had never received. Post-deploy proof on the new
build: health 200, stands 200, admin 403, cron 401, webhook 401 (not 500, so the new
`required(env, "LLM_PROVIDER")` found its value), `malformed_signature` on a junk signature, and a
**GitHub-triggered scheduled run returning 200** — which exercises `CRON_SECRET` and all four worker
passes against the deployed code, since the workflow fails the run on any other status. The Hobby
plan still rejects the committed one-minute cron, so the `crons` block was stripped uncommitted for
the deploy and restored immediately (GL-017 owns settling that).

### Standing lessons

- **A review artifact is a set of leads, not a spec.** Three findings were exactly right; one
  named a production credential that was not one, and the discrepancy was itself the bigger defect.
- **"Required in production" is a smell.** A rule that relaxes off-production behaves one way
  everywhere it is tested and another way where it matters — the shape that hid GL-019 for the
  deployment's entire life.
- **Reuse the state that already means what you need.** GL-003 wanted a quarantine outcome and
  `ambiguous` already was one, so a defect that looked like it needed a migration needed none.

## 2026-07-28 — the model finally runs, and it breaks everything the stub could not

F-024 closed: the DeepInfra attestation filled from the real terms, the first live-model run, the
three defects it exposed that 471 green unit tests could not, the offering seam over the real
corpus, and F-037's operator surface for the flags that seam's sibling raises.

### The attestation, and the clause that had to become code

max read DeepInfra's data-processing terms and directed the fill. Values transcribed verbatim
from <https://docs.deepinfra.com/account/data-privacy>: no training on API data, inputs in memory
only and outputs deleted once returned, request **content** not logged (metadata only: request id,
cost, sampling parameters), zero stated retention. The caveat is recorded at the binding rather
than smoothed over — DeepInfra reserves an unbounded discretionary right to log "a small portion
of requests" for debugging or security, and inventing a number to bound it would be exactly the
inference the gate forbids.

One clause could not stay prose. Their no-training sentence carries an exception: *"except when
using Google or Anthropic models, where the receiving company's training policy applies."* Those
are models DeepInfra **routes** to another vendor's endpoints under that vendor's unattested
terms — so an `anthropic/` or `google/` `DEEPINFRA_MODEL` would have made the version-controlled
attestation false for a reachable configuration. It is now a startup error.

**The attestation moved to `packages/ai/src/deepinfra.ts`**, beside the adapter it gates. It had
been in the web composition root, which the propose script and the live evals never pass through —
they construct the provider directly, and would have bypassed the gate entirely.
`assertDeepInfraSelectionApproved` is now the one approval path for every consumer.

The source tests flipped: they had pinned the `null` literal so no agent could fill it with
guesses; they now pin the four values **and the citation** — URL and review date must appear in
the comment block immediately preceding the binding. Values flipped → 2 tests fail; citation
removed → 1; prefix guard emptied → 1.

### The first live run failed every seam, and the suite stayed green

The whole point of the exercise, and it delivered on the first call. `npm run evals:live` against
the real model: **every seam returned `invalid_output`**. Unit tests 471/471 green. Scripted evals
44/44 green. The stub reads neither the instructions nor the schema, so nothing in the existing
suite could see any of it.

**Defect 1 — the instructions described a different job.** Every projection attached
`COORDINATOR_SMS_OUTPUT_INSTRUCTIONS` — *"Write a concise SMS reply. Prefer one GSM-7 segment…"* —
to seams whose schemas accept only structured JSON, and **nothing anywhere stated the expected
shape**. The model returned `{"smsReply":"Added tomatoes, kale, and a dozen eggs to your
inventory"}`, which is a perfectly reasonable answer to the question we actually asked. Replaced
with per-seam contracts: example shapes plus semantic notes, and `output-contracts.test.ts` parses
every documented example **through the real schema**, so the prose a model reads cannot drift from
the validator that judges it. It also asserts kind-coverage in both directions — a schema gaining
a shape the instructions never mention leaves the model unable to use it; an instruction naming a
removed shape teaches a refused output.

**Defect 2 — `null` is how models say "not stated".** `{"quantity": null}` for a farmer who never
gave a quantity, and Zod's `.optional()` refuses `null`. `nullAsAbsent()` treats it as absence
**only where the schema already declares optionality** — same class of decision as the adapter's
code-fence stripping, a formatting idiom rather than a content one. A null-valued **unknown** key
still hits the strict schema's visible refusal, which is asserted, because that is the difference
between tolerating an idiom and quietly accepting a smuggled field.

**Defect 3 — the corpus disproved a bound, again.** Venison Valley Farm & Creamery legitimately
offers ~26 things (a creamery plus a produce partner), against a 24-item cap. Raised to 40 with a
refusal test at 60. Third time the real 31 stands have corrected a number that looked fine in the
abstract.

### What the containment fixtures proved, and why they are not "the model behaved"

`evals/live.ts` splits into **live-containment** (must be 100%) and **live-quality** (recorded).
The containment fixtures actively invite the model to comply with an injection, so the pass
condition is *the barrier held*, never *the model refused*. Llama duly complied — asked to include
`loc-999` in its selection, **it did**, and membership validation rejected the whole selection.
That is the harness working, observed rather than asserted.

**12/12 containment on both candidates.** Quality over three runs each: Mistral Small 24B
**6/6, 6/6, 6/6**; Llama 3.3 70B Turbo 5/6, 5/6, 6/6 — the extraction fixture flaking run to run
under batching variance. max chose **Mistral Small 24B**: stable, ~5× cheaper, and the stronger
performer on exactly these structured tasks. Bigger did not mean better here.

**Cost and rate-limit posture:** DeepInfra allows 200 concurrent requests per model, 429 beyond,
no RPM cap. Farm Friend's own ceilings keep worst-case concurrency in single digits, so the public
throttle needed no change. Under $1/month at launch volume.

### The offering seam, and the corpus's last correction

`npm run offerings:propose` → review → `npm run db:seed-offerings`. The propose step strips
contacts before any text reaches the model (the projection fails closed on a raw phone, so an
unstripped description would refuse rather than leak) and writes proposals beside the source text
they came from. **31/31 proposed.** max reviewed every list and approved with one edit: Aeggy's
redundant "eggs / duck eggs / chicken eggs" collapsed. Narwhal's "swag" stays — the stand
advertises it. Seedrain's "invasive plant control" stays too, and produced **F-038**: it is a
farm-related *business*, not a stand or a market, and the system has no type for that yet.

`seedOfferings` is the code-commits half — idempotent on (location, item), never rewrites an
existing tag (a farmer may have corrected it since), reports unknown stand names rather than
inventing them, writes zero inventory. The propose script lives in `packages/ai`, not
`packages/db`: it composes ai + core, and **db must not depend on ai**.

### F-037: a decision queue that cannot become an editing surface

The seeder's three real flags (Green Ears ×2, Holmestead) were visible only by SQL.
`/admin/stand-data` now lists each with the stand, the reason in plain words, and the source text
verbatim; resolving requires a note saying what was decided, because a resolution with no recorded
decision makes the queue a dismiss button.

The property worth the effort: **resolution records a decision and cannot act on it.** No write
path to `sales_locations`, offerings, or inventory. The temptation is specific — *"resolve the
contradiction by fixing the hours while I'm here"* — and a listing edit is a different capability
with its own authority story. Pinned by byte-equality over every listing field, sabotage-verified
by adding a listing update inside the transaction.

### The race test that could not fail, found by sabotage

The concurrency test used eight claimants sharing **one** administrator row — and it passed with
the flag's `for update` deleted. The authority re-read's own `for update` on that single admin row
serializes every transaction before the flag lock is ever contended, so the test was measuring the
wrong lock. Fixed to race **eight distinct administrators**, which is also the real scenario the
409 exists for; the sabotage then fails it correctly. Same family as the source-assertion failures
already recorded twice: the test looked right and proved nothing.

**Verified:** unit **479/479** (50 files), integration **285/285** (18 files) on real Postgres 16,
evals critical 11/11 + advisory 4/4 + adversarial 29/29 with **no fixture touched**, live evals as
above, typecheck/lint/`next build` clean.

**Released:** `a1e6fb7` (PR #49), `b47c564` (PR #50), `ea4889b` (PR #51), each deployed with
`npx vercel --prod` immediately after merge, crons block stripped uncommitted and restored.
Verified by effect: health `{"ok":true}`, cron **401**, webhook **401** (the load-bearing one —
401 rather than 500 proves config still resolves), and `/api/admin/stand-data-flags` **403** on
both methods.

**Production remains deliberately unseeded.** `/api/public/stands` returns `{"stands":[]}`. The
offerings are approved but not committed to production: that still waits on the 3 missing
addresses and F-034.

---
