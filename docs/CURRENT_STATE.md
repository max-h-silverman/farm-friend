# Farm Friend — Current State & Open Items

> **Live snapshot, overwritten by `/session-wrap` — not a changelog.** Record only verified facts.
> Architecture docs own enduring contracts; dated reasoning and deployment proof live in the
> session log.

## Release state

Farm Friend is **pre-go-live**. Production runs one image across Cloud Run web revision
`farm-friend-web-00034-77d` (bumped by the geocoding mount, below) and worker revision
`farm-friend-worker-00034-4cn`, both at digest
`sha256:85657998baca6a7416144aff9f990852d429920bc34f4b580ccbffc7fdd2cfff` (`main` at `41412b4`).

> **`main` is AHEAD of production.** The farmer-surface tranche (2026-08-06, below) is merged and
> pushed but **not deployed** — max is running the deploy himself. It carries **no migration**, so
> the RUNBOOK's migrate-before-promote ordering does not apply and production's migration count
> stays at 24. Until that deploy runs, no farmer sees the chip interface, the named removals, the
> farm-name rename, or the "Remove this stand" heading.
>
> **A SECOND undeployed tranche now sits on top of it** (self-onboarding, 2026-08-06, below):
> B-037, the architecture-tripwire fix, F-077 and F-080 are merged to `main`. **F-078 is a
> BRANCH, not merged** — it is now COMPLETE (the real send is done) and carries **migration
> `0024`**, the first migration owed to production since this record was written.
> **`0024` must be applied BEFORE the image that reads it.** See §the self-onboarding tranche.

## The self-onboarding tranche (2026-08-06) — merged, undeployed

Built from `~/.claude/plans/woolly-kindling-origami.md`. Five workstreams; **three merged to
`main`, one on a branch, one not started.** Nothing here is deployed.

**Merged to `main`, no migration:**

- **B-037 — the listing editor no longer erases a farmer's availability.** A live data-loss
  defect: `readStandListing` returned all twelve season/hours/restocking columns, `updateStand`
  wrote all twelve unconditionally, and `ListingDefaults` had fields for none of them — so a
  farmer who opened the edit form to change their hours silently lost their season, open days,
  restocking cadence and restocking days. It shipped because a test named "RESAVES an untouched
  edit form unchanged, **field for field**" held a fixture with only the eight fields the type
  knew about. Fixed fixture-first, so that test failed on its own name first. `ListingDefaults`
  now imports `ListingAvailability` rather than restating it.
- **The architecture tripwires did not cover the web app at all.** `sourceFiles` collected only
  `.ts`, and the geocode block scanned `apps/web/lib` but not `apps/web/app` — so every page,
  route handler and component sat outside the geocode allowlist and the `MapProvider` ban.
  Proven by sabotage: a `geocode()` call plus the Maps host added to `listing-step.tsx` passed
  the suite untouched. It now fails. **No production source was violating any of it.**
- **F-077 — the typed address is the only source of a coordinate.** The tap-to-place picker,
  `drop()`, the confirm gate and `DraftPin.confirmed` are gone; an address that will not resolve
  is **refused**. The island map survives read-only so the farmer can check the point. Editing
  the address **clears** the pin — the sharp edge this creates, since A's coordinate must not
  publish under B's address. **`GEOCODING_API_KEY`'s absence now means no visitable stand can be
  created at all**; the prose calling it a fallback to tapping was corrected everywhere.
- **F-080 — `SIGNUP` is gone; `JOIN <token>` redeems an invitation.** No grace window (max:
  pre-go-live, no farmer to strand). It could not simply be deleted —
  `openFarmerOnboardingRequest` was the only writer of `farmer_onboarding_requests`, which the
  admin fallback requires. **One consent writer, structurally:** bare `JOIN` parses as
  compliance and is handled by `routeCompliance`; `JOIN <token>` parses as `kind: "farmer"` and
  never reaches it, so the two-writer edit the plan anticipated was unnecessary.

**On branch `f-078-email-identity`, NOT merged — COMPLETE, and it carries migration `0024`:**

- **`farm_emails`** — the roster VIGA already holds, so a farmer can prove who they are without
  a volunteer vouching. Raw address in exactly one column read only by the send path; hash the
  only lookup key (Golden Rule #5, second kind of personal data). **Verifying is not
  publishing:** the 6 farms who declined the printed map still authenticate.
- **Every constraint proven to genuinely REFUSE** by sabotage: naive `btrim` (0020's exact
  defect — admits tab-only values), the hex-digest CHECK, the normalized unique index, and
  `restrict` vs `cascade`.
- **`drizzle-kit generate` silently dropped both CHECKs and the unique index** when run against
  the same `schema.ts` — it emitted only the CREATE TABLE and the foreign key. Only its meta
  snapshot was kept; the SQL is hand-written. Recorded first-hand in the migration.
- **The parser was measured against the real corpus before building.** All three plan claims
  held (32/32 rows carry an email, 5 multi-address farms, zero cross-farm collisions), but two
  details were imprecise and change the parser: Lavender Hill's three addresses come from **two
  columns combined**, and separators are **mixed** (`" and "` as well as commas). A comma-only
  splitter turns one farm's cell into a single malformed address — caught by the corpus test,
  not by the fixtures.

**Not started: F-079** (secret link + emailed code). The sending seam it depended on is now
**built and proven** — what remains is the farmer-facing page that calls it.

**The SMTP CREDENTIAL IS LIVE IN PRODUCTION** (2026-08-06, commit `4ff90a5`). The relay is
configured, and the app password is now in Secret Manager and mounted. Sender is
**`board@vigavashon.org`** (max), not a dedicated Farm Friend address — so replies reach a
mailbox VIGA actually reads.

Landed by the same three-step gate as geocoding, for the same platform reason: `version =
"latest"` resolves at container start, so an unconditional mount of a versionless secret makes
Cloud Run refuse the revision and takes the public map down to add an optional feature.

**Verified by effect against the live services, not from the applies' exit status.** Both
services rolled **00034 → 00037**, so they genuinely restarted and re-read the secret — the
check that catches B-021's "apply succeeded, nothing picked it up". The live web service holds
`SMTP_PASSWORD` from Secret Manager plus host/port/username/sender; **the live worker holds no
`SMTP_*` variable at all**. Health 200 and 34 stands, unchanged. The secret version was checked
for **shape without printing it**: 16 bytes, no trailing newline, no embedded space — the
failure that looks correct in every listing and fails every send.

**The sender address is configuration** (`SMTP_FROM_ADDRESS`), so moving to a dedicated address
is an apply rather than a code change. `smtp_port` refuses **25**, which Google Cloud blocks
outbound with no way to open it.

Plan assertions **39/39 → 44/44**. Four sabotages, each failing its named check: the password in
`shared_secret_env` (worker mount), supplied as a literal env value (cleartext in state),
`SMTP_FROM_ADDRESS` dropped from config, and SMTP config in `common_env` (worker configured for a
capability it does not have).

**A tripwire had been RED AND SILENT since commit `737b39b`.** `infra/secrets-lifecycle.test.py`
asserted on the local variable names `initial_secret_changes` / `post_provision_secret_changes`;
that commit renamed the locals and the test has failed ever since — unnoticed because it is a
standalone Python file `npm test` never runs. It now anchors to the **addresses** the guard
allow-lists and **calls** the predicate, asserting a protected survivor can never be deleted.
Sabotage-verified by making the guard return `True`, which it now catches. **It is still not in
any npm script**, so it must be run by hand: `python3 infra/secrets-lifecycle.test.py`.

**The F-078 APPLICATION HALF IS BUILT** (commit `fa1bab1`, branch, not merged): the privacy
layer, the verification code and email copy, the SMTP seam, the ingest, and the privacy proof.

- **The email copy is written to minimize replies** (max), which is a real cost — replies land
  in VIGA's board mailbox and a volunteer answers by hand. The code is in the **subject**, so a
  farmer reading a phone notification never opens the mail; the subject names VIGA so it does
  not read as spam; the farm is named in the first sentence; the expiry is rendered from
  `CODE_TTL_MINUTES` so the promise cannot drift from the behavior; a recipient who did not ask
  is told to ignore it; and there is **no link**, because a code plus a link is the shape of a
  phishing mail. Replies are still invited and the address given.
- **Email privacy is a second instance of `phone.ts`, not a second mechanism.** Normalize at
  ingress, HMAC for lookup, raw address in exactly one column read only by the send path, masked
  in admin. `normalizeEmail` names its whitespace class explicitly to match the index's
  `btrim(email, E' \t\r\n')` — `btrim(text)` strips spaces only, which is 0020's defect.
- **A SABOTAGE CORRECTED THE PRIVACY TEST, and the finding is worth keeping.** The first version
  asserted on the objects `listPublicStands` returns; selecting the email straight into that
  query left all four tests **passing**. The escape was not the test failing —
  `serializePublicStand` is an **explicit allowlist**, so a leaked column cannot reach the wire
  on its own, which is a real architectural property. What fails the test is a leak carried the
  whole way (query, mapping, serializer), exactly what a well-meant "contact the farmer" field
  would look like. The assertion now reads the **served bytes** of `/api/public/stands`, and
  under that sabotage it fails and names the exposed address.
- **Two architecture tripwires**: no email table or column anywhere `packages/ai` can read, and
  the raw column readable only from the send path and the ingest.
- **The ingest is idempotent** against the normalized unique index (`on conflict do nothing` —
  select-then-insert cannot serialize a row that does not exist), proven against real Postgres
  including the case collision only the index can arbitrate. Farms with **no address** and farms
  matching **no seeded name** are reported, never dropped.
- `nodemailer` 9.0.4, **zero transitive dependencies**, in `apps/web` only. **STARTTLS is
  required**, not merely offered, so the app password cannot cross the wire in the clear.

Verified: **1423 unit** (was 1369), **753 integration** (was 744), typecheck, lint, production
build, evals 44/44. Integration ran against local Postgres, never Neon.

**THE REAL SEND IS DONE** (max, 2026-08-06) — a message rendered by the shipped
`renderVerificationEmail`, sent through the shipped transport against the real Google relay,
delivered to a real inbox. That closes F-078's last acceptance criterion. A stubbed mail server
would have proven nothing about whether a farmer receives anything.

**The sender reads `VIGA`, not `board`** (max, after seeing the delivered mail). The address is
unchanged — `board@vigavashon.org` still authenticates to the relay and still receives replies —
so this is only the display name a mail client shows, carried as configuration like the address.
Quotes, angle brackets, and newlines are **refused**: a display name is folded into the From
header, so `"VIGA" <someone@else.com>` would make the visible sender differ from the configured
one, and a newline can append headers outright. The transport also passes name and address as
**structured fields** rather than a hand-built string, so nodemailer owns the header encoding and
the two defenses are independent. `SMTP_FROM_NAME` is in Terraform and read back out of a real
plan; assertions stay 44/44.

**Still owed for the email identity feature as a whole:** wiring verification into an actual
farmer-facing page (**F-079**), and the production ingest of the roster. The machinery is built
and proven; nothing calls it yet.
Production Postgres is `neondb` with **all 24 migrations applied (`0000`–`0023`)**, verified by
effect on 2026-08-06 — the fingerprint (`neondb`, 22 migrations, 36 farms / 35 locations / 2
contacts) was taken before writing, and the pre-change schema was asserted so a pass could not
come from an already-migrated database.

**F-071, F-072, F-073, and F-074 are DEPLOYED** (2026-08-06), together with the stand-card
redesign that had been merged and waiting. Migrations `0022` and `0023` were applied **before**
the image that reads them, per the RUNBOOK's ordering rule. max chose to apply them **without a
pre-migration snapshot** when asked. Both are additive and nullable, and listing data was
unchanged across the migration (36 farms / 35 locations / 2 contacts, before and after).

**Verified by effect in the served bytes, not from the apply's exit status.** Plan assertions
37/37, deploy and served-card assertions pass. The F-074 filter was proven by **marking a real
production farm and watching it leave the served JSON**: `/api/public/stands` went 34 → 33 stands
with `3 Brothers Outpost` absent, `?hidden=true` still served all 34 including it, and unmarking
restored 34. **Production holds zero test farms** — the check put the farm back and confirmed it.
Two identical 34-stand responses would have been produced by a filter that did nothing, which is
why the check marks a farm rather than reading the default twice. The four new CHECK constraints
were each proven to genuinely **refuse** on production, in both directions of each coherence
pair, every attempt rolled back.

**A real defect was found by deploying, and only the container build could see it.** F-073's
`/api/farmer/link-request` built its throttle at **module scope** from `publicReadContext()`,
which constructs the database pool and demands `DATABASE_URL`. `next build` collects page data by
importing every route module in a process with **no environment**, so the image build failed with
"Failed to collect page data" while `npm test`, typecheck, lint, and a local `next build` all
passed — `.env` exists on a developer machine and not in a build container. The throttle only
needed a clock. The guard is a **real import with the variables deleted** across eight routes,
not a source grep, and it reproduces the Cloud Build error locally; sabotage-verified. Fixed in
`41412b4`. The live route now answers `400` to a malformed body rather than `500`.

**PRODUCTION HOLDS ONE TEST FARM** (2026-08-06): `Test Farm` at `20714 Westside Hwy SW`, farm id
`c3b47b9e-d1d4-41ab-9fae-1e7bb8c02bc5`. max onboarded it end to end against the freshly deployed
build — approve → invite → authorize → publish — which is F-074's whole purpose, and it went live
on the public map because the flag is not set automatically. It is now **marked**, recorded as
`farm_marked_test` against `board@vigavashon.org`.

**Verified by effect afterwards**: an islander gets **34 stands with `Test Farm` absent**;
`?hidden=true` serves **35 including it**. So the public count is 34 real stands and the extra one
is deliberate. A future session reading "35 locations" in the database against "34 stands" on the
map should look here first rather than treating it as a defect. Marking is reversible from
`/admin` → **Test farms**.

**F-069 and F-070 are DEPLOYED** (2026-08-06). Neither adds a migration, so none was owed. Plan
assertions 37/37, deploy and served-card assertions pass. **Verified by effect in the served
bytes**, not from the green apply: the root page carries **12 secondary road paths and 1 highway
path** (F-070's exact geometry), and `POST /api/farmer/address-lookup` answers `invalid_request`
to a malformed token and a uniform `invitation_unavailable` to a well-formed unknown one, leaking
no key.

**Nothing is merged-and-undeployed, and no migration is owed.** `main` at `41412b4` is what
production serves.

**`GEOCODING_API_KEY` IS NOW SET IN PRODUCTION** (2026-08-06), so address lookup is on and the
onboarding form offers a draft pin the farmer confirms. Its absence remains a supported
deployment — the form falls back to pin-dropping — and the kill switch is one apply away.

**The production wiring is BUILT and fully applied** (2026-08-06). `infra/secrets.tf` declares
`farm-friend-geocoding-api-key` and `infra/services.tf` mounts it into the **web service only** —
the worker never geocodes, and mounting a billed credential there would put spending in a process
with no throttle in front of it. The IAM accessor grant came free, because `runtime_reads`
iterates the secrets map.

**The mount is behind `var.mount_geocoding_key`, and that flag is the whole point.**
`version = "latest"` is resolved when a container STARTS, and a secret with **no versions**
resolves to nothing — Cloud Run then refuses the revision. An unconditional mount would therefore
take the public map down in order to add an optional feature, inverting the property geocoding is
supposed to have. So it is three steps:

1. **DONE** — applied with the flag `false`: the empty secret container and its IAM grant exist,
   nothing mounts it, and the live service was confirmed healthy afterwards (35 stands, health 200).
2. **DONE** — max added version 1 out of band, never through Terraform.
3. **DONE** — applied with `mount_geocoding_key=true`. Plan assertions 39/39.

**GEOCODING IS NOW LIVE IN PRODUCTION** (2026-08-06). Web serves revision
`farm-friend-web-00034-77d` with `GEOCODING_API_KEY` mounted; the worker stays on
`farm-friend-worker-00034-4cn` and **does not mount it**, confirmed against the live service
rather than from the plan. Health 200, and `POST /api/farmer/address-lookup` answers `400` to a
malformed body — so the route is live and not failing on configuration. Setting the flag back to
`false` and applying is the kill switch; it stops lookup without touching the key.

**That apply was INTERRUPTED partway and still landed**, which is worth knowing rather than
tidying away: the process died holding the state lock, blocking a second terminal with a
misleading "resource temporarily unavailable". The lock cleared itself when the process exited
(`force-unlock` reported `LocalState not locked`). Live state was then verified directly —
revision, mount, worker exclusion, health — instead of inferred from the failed command.
A re-plan still reports **2 in-place changes**, and they are a provider-level `scaling`
normalisation (`min_instance_count 0 → null`, semantically identical) present before this work,
**not** unfinished geocoding.

Plan assertions are **39/39** (was 37): six secrets declared, the geocoding container present, and
**the worker never mounts `GEOCODING_API_KEY`** — that last one asserted unconditionally, so
flipping the flag can never quietly hand a spending credential to the worker.
**Sabotage-verified**: moving the key into `shared_secret_env` fails that named check (38/39).

**The geocoding path HAS now made real billed calls** (2026-08-06, run locally before the key
reached production; production has since had its own key mounted) — the
check that was owed since F-069, and it is done. Three calls through the shipped
`lookupIslandAddress`, not a hand-rolled fetch, so what was exercised is the code production would
run: the request it builds, the live response shape it parses, and the bounds check on the way
back. Every test injects `fetch`, so none of that had ever been verified against the real provider.
  - a real Vashon address → `found`, pinned at **47.4496, -122.4609** (Vashon town — the right
    place, not merely a well-formed answer);
  - **`400 Broad St, Seattle` → `off_island`, REFUSED** — the one that matters, since it is a
    valid geocode the bounds check rejected rather than handing a farmer a pin fifteen miles away;
  - nonsense → `no_result`, degrading to pin-dropping.

**Deployed twice on 2026-08-05, each verified by effect**: plan assertions 37/37 both times,
deploy and served-card assertions pass, and the live site serves **34 stands, 33 reading
`usuallySells` from `stand_items`** — so the promoted image and the migrated schema demonstrably
agree. `POST /api/farmer/listing` answers `400` to a malformed token before touching the database
and a uniform `410` to a well-formed unknown one, so it is not an oracle for whether a guessed token
names anything.

**All 35 seeded farms are now approved** (2026-08-05), recorded against the board account. The
admin's approval queue had held all 35 while approving them changed nothing a customer sees:
`listPublicStands` gates on `is_public`, **not** on approval, so those stands were already on the
map. What approval gates is whether the **farmer may publish an update** — `confirmProposal` and the
scheduled prompts both re-read it. The bulk write was insert-only, idempotent against the partial
unique index, fingerprinted before writing, and verified by effect (queue empty, 35 locations
untouched, a re-run writes zero). `scripts/approve-seeded-farms.ts` is retained and safe to re-run.
Admin copy in three places was corrected to match: approval is now the **exception**, and an empty
queue is the normal state rather than a sign something failed.

`0019`, `0020`, and `0021` were applied **before** the code that reads them was promoted, per the
RUNBOOK's ordering rule. All three are additive and backward-compatible (a column, a table, a
widened constraint), so the pre-tranche image kept serving correctly in the window between the
migration and the deploy. **`0020` backfilled 212 `stand_items` rows from real production data**;
listing data was unchanged (35 farms, 35 locations, 2 contacts, before and after). max declined a
pre-migration snapshot when asked.

The farmer-consent launch blocker closed in the previous tranche and is deployed; see the
[session log](SESSION_LOG.md) for its reasoning.

Four tranches have now landed on `main` and are **DEPLOYED**, with all their migrations applied
ahead of the image that reads them:

- the **listing ingestion work** (F-063, F-061, F-062, and F-064's guard) — migration `0019`
  (`inventory_revisions.source`);
- **F-066's one item vocabulary** — migration `0020` (`stand_items`);
- **F-067's self-serve farmer onboarding** — migration `0021`
  (`farmer_onboarding_requests_coherent_settlement` widened);
- **F-067's onboarding listing form** — the first farmer-facing writer of listing facts; no
  migration of its own.

F-066 and F-067's first half landed together as **PR #80** (`41e6dd0`); the listing form landed as
**PR #81**. Each merged base was re-verified green rather than assumed from the branch's own run.

**The schema is current; the listing DATA is not.** F-064's production ingest has still not run, so
production continues to serve the pre-tranche listing content — see "Open before go-live" below.

An earlier tranche produced two findings that outgrew it and drove the ingestion audit:

- **the map CSV is a hand-maintained derivative**, so the oddities in stand descriptions
  (`WA, WA 98070`, en-dashes in dated lines) are transcription residue from the manual step Farm
  Friend exists to remove;
- **`parseFormResponses` was suspected of describing a source VIGA has never produced. That is
  disproved** (audit 2026-08-04, **B-035 closed wont-fix**). VIGA supplies **three** CSVs, not two:
  a per-farm **profile form** (`2026 Farm Stand Information (Responses)…`, header matches
  `EXPECTED_COLUMNS` byte for byte, parses to 31 stands + 1 known refusal, **still open**), the map
  transcription (31 stands, the only coordinates), and the **weekly stock form** (734 rows, 49 farms
  — **now parsed and ingested for 2026**, F-062). Both "invented" fixtures are real data. The join
  is sound: 35 stands, 0 refusals.

`extractStockUpdate` parses VIGA's dated `"5/26/2026 Update: …"` lines. **How such a line is stored
is now resolved** — F-063's `source = 'viga'` is exactly that record — and the same parser gained
two fixes found only by measuring the real export: the separator is written as a dash in 5 of 18
lines, and one line uses a two-digit year. Its remaining job is to keep those lines out of the
public description, which it does.

## Verification

- **The farmer-surface tranche is MERGED to `main` and PUSHED — NOT deployed.** Four
  farmer/admin defects max reported from using the app, the chip interface below, plus a
  test-harness gap found on the way. Verified 2026-08-06: **1342 unit / 735 integration**,
  typecheck, lint, `evals` 44/44 (critical 11/11, advisory 4/4, adversarial 29/29), and
  `evals:live` 25/25. **No migration** — production stays at 24 (`0000`–`0023`).
  **max chose to run the deploy himself**, so production still serves `41412b4`; everything
  below is live on `main` and not yet in front of farmers.
  - **The stand listing is now DIRECTLY EDITABLE** (max: "maybe instead of a chat input the
    web update form can just be like adding/removing tags"). A listing is a set of short
    strings, so a farmer taking kale off was doing manual labour to express "remove one
    member of a set". Chips are primary; free text remains as the escape hatch for what chips
    cannot say (a closure, a price mentioned in passing), which is also what keeps the model
    seam a live path rather than dead code.
  - **A structured edit skips the MODEL, and nothing else.** `applyInterpretedInventory`
    takes either `taskText` or an `edit` already in the interpreter's output shape; every
    step after interpretation was always code and is unchanged — same
    `validateInterpretation` against the same snapshot, same composition, same confirmation
    gate. **Sabotaged**: bypassing validation for structured edits is caught by a test
    sending an entry id belonging to no snapshot. A strict boundary parser
    (`farmer-stand-edit.ts`) refuses unknown keys rather than stripping them, rejects
    non-finite quantities, and cannot express `clear_all`; two sabotages confirmed those.
  - **A defect only the browser found.** Chips send ENTRY IDS, and the page drew the
    PUBLISHED revision while composition uses the sender's OPEN PROPOSAL as its base. A
    farmer who edited once and returned saw chips for items their own pending proposal had
    dropped; tapping one sent an id absent from the base and was refused — correctly, for a
    change they had every reason to think was available. The free-text path never hit it
    because prose names items, not identifiers. `readCurrentStandEntries` now returns the
    pending base when one is open, scoped to one sender. **Sabotaged and confirmed.**
  - **`button:first-of-type` styled the wrong control.** Written when the screen had one
    button; once the listing became editable the first button was a chip's ×, so the control
    that TAKES AN ITEM OFF rendered as the one that publishes. The affirmative action now
    carries an explicit class, asserted by test. Position is not intent.
  - **Verified in the running app, by effect.** Published via chips with no model call and
    checked against the row: a new current revision carrying the composed items and prices.
    The gate refused twice first (`not_approved` — the local seed farm had no
    `farm_approvals` row), which is the gate working, not a defect.
  - **"Weekly update form" was never the product's name** — it was mine in conversation and
    is dropped. VIGA's "weekly form" (the Google form volunteers transcribe) and the
    `weekly` reminder cadence are real and unchanged; no farmer surface calls itself that.
  - ~~**An `evals:live` run IS OWED**~~ — **DONE 2026-08-06, 25/25 pass** against
    `mistralai/Mistral-Small-24B-Instruct-2501` (containment 4/4, closure 7/7, quality 9/9,
    recall 5/5). `packages/ai/src/projections.ts` changed: the inventory-extraction prompt never
    said *when* to emit a removal, so a bare list of items ("we have eggs and bok choy") could be
    read as a whole-listing replacement and silently delete the kale the farmer never mentioned.
    It now states that omission is not removal, names what does justify one, and requires a
    clarification over a guessed deletion. **Three new `live-quality` fixtures measured exactly
    this against the real model**, and all three passed on the recorded output:
    - "we have eggs and bok choy" → `additions: [eggs, bok choy]`, **`removals: []`** — the
      unmentioned kale survives.
    - "kale is all gone" → `removals: [e2]` — an explicit sold-out still removes.
    - "all we have left today is eggs" → `removals: [e1, e2]` — an explicit replacement replaces.

    The second and third are the mirror cases and are why this is evidence rather than a
    tautology: a prompt that simply never removed would satisfy the first fixture alone.
    **This measures the CURRENT brain, not the harness.** The model is swappable and is never
    vouched for, so the fixtures stay in the suite — a weaker or hostile model must be re-measured,
    and the properties that must survive regardless live in code (`entries` is the sole authority
    on what publishes; `removedItemNames` is confirmation copy no consequence reads).
  - **`ProposedSnapshot` gained `removedItemNames`** — confirmation copy only, never consulted
    by `confirmInventoryPublication`; `entries` remains the whole authority on what publishes.
    A removal was previously visible ONLY as an absence from the rendered result, which is what
    nobody notices in a text message. Both new renderer tests were **sabotaged and confirmed to
    fail**. SMS and web share the renderer, so one seam covered both surfaces. Two integration
    assertions that required a removed item's name be absent from the *whole* confirmation were
    corrected — the real property is that it is gone from the LISTING.
  - **A farm's name was immutable and public.** Written at invitation time (`farmer.ts:95`) and
    changeable by nobody — no farmer path, no admin path, no writer anywhere — while shown to
    customers on the map. It also *looked* editable: the farmer's listing editor passed
    `listing.standName` into a prop named `farmName`, so a field named for the farm held the
    stand's name. `readStandListing` now returns both and the editor prefills each from its own
    source. `renameFarm` reports `unknown_farm` via `returning` rather than treating a zero-row
    update as success — **sabotaged and confirmed to fail**. Verified by effect: the renamed row
    read back from the database, not from the success banner.
  - **Admin stand removal already existed and worked** (retire: leaves the map and text answers,
    stops farmer publishing, keeps everything published, reversible, confirm-gated). It was named
    "Take off the map", sat last inside a collapsed panel, and never used the word anyone searches
    for — so operators concluded stands could not be removed. Heading only. The first version of
    that test **passed against existing body copy** without the heading changing and was tightened
    to anchor on the heading.
  - **Testing Library's `cleanup` never ran.** Without `globals: true` there is no global
    `afterEach` for it to register against, so every mounted component stayed in the document for
    the rest of the file and `getByText` could satisfy a later test from an earlier test's render
    — a component test could pass while the behavior it named was broken. A setup file now runs it.
    Adding it exposed no existing failures.
  - **Exercised in the running app** against local Postgres, not only in tests: current stock
    renders on the update form, the save confirms instead of collapsing, "Change something"
    reopens with answers intact, and the rename landed in the row. **The local `LLM_PROVIDER` is
    `stub`, so the interpretation path returns a clarification and the confirmation screen could
    not be reached in the browser** — the removal copy above was verified through the real shared
    renderer directly. A cooperative stub cannot stand in for the model here.
- **`main` at `41412b4`, MERGED and DEPLOYED** (F-072, F-073, F-074, plus the build fix):
  **115 unit files / 1301 tests**, **53 integration files / 724 tests**, typecheck, lint, and the
  production build pass — **re-run on the merged base**, not carried over from either branch.
  **No `packages/ai` file changed, so no eval or `evals:live` run is owed.** Carries migrations
  `0022` and `0023`, both applied to production ahead of the image.
  The unit count rose 1293 → **1301** on the eight new route-import guards described above.
- **Migration `0023` verified BY EFFECT** against a freshly migrated database, never by exit
  status. The two `farms` columns exist, are nullable, and carry **no default** — which is what
  makes the migration safe to apply ahead of the image that reads it. All four CHECK constraints
  are **hand-written**, because drizzle-kit omits CHECKs entirely, and each is asserted by a
  genuinely *refused* write: both directions of each coherence pair, a hash that is not a
  64-character digest, and four bad suffix shapes. `administrator_phones` is asserted to hold
  **no `phone_e164` column at all**, read from the real schema rather than from the schema file's
  word.
- **Seven sabotages this tranche, each failing named tests**: removing the filter at each of the
  **four** read sites (the map — 2 tests; the confirmed SMS query — 1; the offerings SMS query —
  1; the farm picker — 1), ignoring `revoked_at` on the phone list (1), making the phone list
  grant farmer authority (1), and replacing the coherence CHECK with the naive one-directional
  form that passes on NULL (1).
- **Two test defects were found by running the tests, not by reading them.** A stranger hash
  collided with the fixture's own farmer, so the "visibility only" test would have passed for
  entirely the wrong reason. And deleting `farmer_authorizations` is refused by a foreign key
  from published revisions — revocation is what the real system does anyway, and
  `NO_LIVE_FARMER` keys on it.
- **One assertion was wrong in an instructive way.** The hidden-offerings test expected an empty
  answer and got `rejected`, which is the *stronger* result: retrieval was non-empty because
  another farm had stock, so the model genuinely ran, named the test farm anyway, and code
  refused a selection outside the retrieved set (Golden Rule #4).
- Prior branch `f-072-grandfathered-onboarding` (F-072 + F-073), now **merged and deployed**:
  **115 unit files / 1293 tests**, **52 integration files / 710 tests**, typecheck, lint, and the
  production build passed on the branch. **No `packages/ai` file changed, so no eval or
  `evals:live` run is owed.** **No migration** — both items are new readers, writers, and
  surfaces over the existing schema. Superseded by the merged-base run above.
- **F-072 and F-073 were verified END TO END against the running app**, then read back from
  Postgres and `/api/public/stands` rather than from the screen's success message:
  - a grandfathered farmer publishes a listing with **no invitation and no administrator**, and it
    reaches the public map with address, pin, hours, payments, and their own item words;
  - posting an **already-onboarded** farm's id to the same endpoint is refused `409`, and that
    farm's stand row was confirmed unchanged — the hijack this door had to refuse;
  - an onboarded farmer's phone gets their stand link by SMS: one queued message whose token
    **hashes to a live `farmer_links` row**, while a wrong number, a farmer of a different farm,
    and a revoked authorization each queued **zero** — with all three HTTP responses byte-identical;
  - the texted link opens their stand page, and the new listing-edit surface changed hours,
    address, and items with **zero inventory revisions written** (F-066's separation holding
    through a new writer).
- **A real defect was found only by running it.** `/api/farmer/link-request` was first bound to
  the full composition root, which validates SMS, model, and map configuration — so the
  unauthenticated farmer page returned **500** on a missing unrelated variable. No test could see
  it: every test injects these dependencies. It now builds from `publicReadContext` plus the two
  values it actually needs.
- **Five sabotages this tranche, each failing named tests**: the resolver no longer refusing an
  onboarded farm (2 tests), the claimable predicate ignoring revocation (1), the boundary
  accepting any claim status (1), dropping the farm scope from the phone match so any farmer
  could pull any farm's link (1), the boundary passing the raw phone past the hash (1), the
  prefill reader returning empty payments and items (1), and the edit form failing to prefill
  `hoursText` (1) — the last two are the destructive-edit failure mode, since the writer replaces
  the whole listing and a blank form would erase by omission.
- **The local database held a fixture contact with a placeholder hash** (`aaaa…`), which made the
  first live link-request check queue nothing. The code was correct and the data was fake;
  recorded because it is exactly the shape of failure that would otherwise be blamed on the code.
- Prior `main` (the stand-card redesign): **112 unit files / 1243 tests**, **50 integration
  files / 688 tests**, typecheck and lint pass — **re-run on the merged base**, not carried over
  from the branch. **No `packages/ai` file changed, so no eval or `evals:live` run is owed.** Now
  deployed, and migration `0022` is applied (see Release state).
  ~~**Two live checks remain owed**~~ — **the geocoding one is CLOSED** (2026-08-06, see Release
  state: three real billed calls through the shipped code, including a Seattle address genuinely
  refused as off-island). What remains is the onboarding form in a **real browser** since F-069.
  **Per-tranche browser checks are no longer tracked here** (max, 2026-08-05): he runs browser
  testing himself in a pass before go-live, so listing them per item recorded a debt that was not
  one.
- **The card redesign was browser-checked at both widths, including in dark OS appearance.** Not
  logged as an owed item — the check is done. At 390px the phone sheet leads with the confirmed
  chips, wraps them to two rows and the "usually sells" sentence as prose; with the machine in dark
  appearance the page still served the light palette (body `#fbfaf7`, chips `#eaf3ed`), which is
  the pairing DEVELOPMENT.md §before you ship requires and that F-043 once shipped five defects
  past. Three tests were added and **each was sabotage-verified**; one of them exists because
  deleting a user-facing accessibility signal broke **zero** tests.
- Prior `main` (`3b6e580`, F-069 + F-070): **1234 unit tests**, **48 integration files / 665
  tests**, typecheck and lint pass. **Deployed** 2026-08-06. Superseded by the run above.
- Prior `main` (`84c512d`): **1120 unit tests**, **48 integration files / 655 tests**, typecheck
  and lint pass (2026-08-05). Superseded by the run above.
- Prior `main` (`41e6dd0`): **105 unit-test files / 1075 tests**, typecheck, lint, and **evals
  (critical 11/11, adversarial 29/29, advisory 4/4)** pass (verified 2026-08-05). Superseded by the
  run above and now deployed as part of `7c996a7`.
- Real-Postgres integration runs from an empty schema against a local Postgres — **never** against
  production Neon.
- **F-067's listing form verified END TO END in a real browser**, then read back from Postgres and
  from `/api/public/stands` rather than from the screen's success message: a farmer fills the form
  and the stand reaches the public map with address, pin, hours, payment methods, and their own
  item words, with no VIGA step. The pin landed at 47.4497 / -122.4733 — Vashon town, where the tap
  was — so the projection round-trips in a live browser, not only in tests. **Zero inventory
  revisions** were written, which is F-066's separation holding.
- **Five sabotages this tranche, each failing named tests**: dropping the pin requirement (caught
  by the integration test AND by `coherentVisitability`, proving both layers real), flipping the
  projection's y-inversion (3 tests), sending an address and pin regardless of the visitability
  branch (1), accepting a body-supplied `farmId` (1 — the cross-farm write vector), and adding an
  inventory write to the listing path (1, via a new architecture tripwire).
- **One sabotage escaped, which is the reason to run them.** A plural-stripping normalizer
  ("tomatoes" → "tomatoe") passed all 17 new integration tests: it mangles the key without
  colliding, and the database index applies the correct rule independently, so the stored rows
  looked right while the in-memory dedupe had stopped agreeing with the index that arbitrates.
  `standItemKey` is now exported and asserted directly — including that it returns the word
  itself, the assertion no collision test can make — and the escaped sabotage fails 4 named tests.
- **A test-defect of the same family was found in an existing file.**
  `farmer-onboarding-surface.test.ts` reads page source as raw text, so the comment recording that
  "VIGA reviews your request" was retired satisfied a search for that phrase. It now strips
  comments first, verified by effect (present in the raw file, absent after stripping, markup
  intact). This affected its pre-existing assertions too, not only the new ones.
- **Migration `0021` verified by effect**, and the check found a gap the suites could not: the
  integration suites build their own databases, so all 635 passed while the local dev database
  still held the pre-`0021` constraint. Confirmed via `pg_get_constraintdef` after applying, then
  sabotaged the constraint to confirm it still refuses a settlement recording neither an
  administrator nor an authorization.
- **F-067's self-serve chain verified end to end against real Postgres**, not only by suite: a
  coordinator names a new farm on an invitation, the farmer ticks the agreement and redeems it, and
  the farmer holds a live `farmer_authorizations` row for that farm with **no open onboarding
  request**, the audit event attributing the act to the farmer's contact hash rather than an
  administrator, and exactly one queued text.
- **Migration `0020` verified by effect on BOTH an empty and a populated pre-change schema.** The
  populated run applies every migration through `0019`, writes the rows a real database holds —
  including two offering rows differing only in case, which were legal before and collide under
  the new index — and only then applies `0020`. It asserts it is genuinely on the pre-change
  schema first, so it cannot pass by silently running against an already-migrated database.
- **Five sabotages this tranche, each failing named tests**: removing case normalization from the
  index (3 tests), deleting the confirmed-only half of the backfill (3), breaking the entry →
  item resolution in the public reader (1), and reverting the not-blank CHECK to the default
  `btrim` (1).
- **One sabotage found a gap in the tests rather than confirming them**, which is the reason to
  run them: reverting the seeder's `do update` to `do nothing` broke nothing. An item that exists
  only because a revision confirmed it would silently never become a standing claim — the
  approved tag dropped, no error anywhere. A test now covers it and fails under that sabotage.
- **Two real defects were caught by tests before they shipped**, both in the migration:
  `btrim(text)` strips spaces only, so a tab/newline-only name passed the not-blank CHECK and
  `"\tEggs\n"` was a distinct key from `"Eggs"`; and a padded entry name carried its padding into
  the item's display name. Every normalization now names its whitespace characters explicitly.
- **No model seam was added or changed**, so no eval or `evals:live` run is owed.
- **Migration `0019` verified by effect** against a freshly migrated database (B-022): the `source`
  column exists and is NOT NULL, carries **no default**, the CHECK constraint is present, and
  violating inserts are genuinely *refused* in both directions. The backfill was additionally
  verified against a **populated** pre-change schema, which is what caught that a backfill `UPDATE`
  aborts on `inventory_revisions_guard_history` — it would have failed against production.
- **Seventeen sabotages this tranche**, each failing named tests. Notable: the naive per-column
  CHECK that passes on NULL (5 tests), a surviving column DEFAULT (1), a weekly row overwriting a
  farmer's newer fact (1), and disabling the wrong-database guard (2).
- **Three sabotages found problems with the tests themselves**, which is the reason to run them:
  two early attempts silently failed to apply and proved nothing (every later one asserts its
  anchor is present before editing); the surviving-DEFAULT case passed every refusal test because
  the default quietly satisfied the NOT NULL; and the name-ambiguity guard was checked with a
  string that was a prefix of neither candidate, so the candidate list was empty either way and
  disabling the guard changed nothing. All three now catch their defect.
- **The launch ingest was rehearsed end to end** against a throwaway local database, in F-064's
  order, with every acceptance criterion checked by querying the result rather than reading script
  output: `farm_links` 34 rows and payment methods 53 rows (both empty before), 16 revisions all
  `source='viga'`, **0 unknown stands**, 0 visitable stands missing a coordinate, **0 descriptions
  leaking a structured fact**, and Handpicked Homestead `contact_only` with no address and no pin.
- **No model seam was added or changed**, so no eval or `evals:live` run is owed. The audit expected
  one for the weekly form's open-ended prose; measured against the real corpus those answers are
  comma-separated lists a deterministic parser reads cleanly.

**From the deployed tranche, still true:**

- **Migration `0018` verified by effect, not by exit status** (B-022): against a freshly migrated
  database the column exists and is nullable, the CHECK constraint is present, and a backdated
  agreement is genuinely *refused* by Postgres. Journal entries are strictly increasing.
- The stand-detail layout was measured **in a real browser at 1440px** across 16 stands spanning
  every shape (market, flower-only, contact-only, services): no band gap exceeds the 12px grid gap,
  and the action row wraps without overlap or overflow down to a 260px card.
- **Three surfaces are unverified at phone width**, all because jsdom reports every element as
  zero-sized: the farmer agreement step, the expanded stand detail, and now **F-067's onboarding
  listing form including its pin-drop map**. The browser in the working environment reports a
  successful resize while the viewport stays wide, and AppleScript window control times out; max
  chose to merge and look himself (**F-060**). The listing form was checked in a real browser and
  works end to end, but **at desktop width** — its markup and behaviour are covered by tests, its
  phone layout is not. The pin-drop map is the piece most worth max's own look, since it is
  thumb-driven by design. One cosmetic defect was seen at desktop width and filed as **B-036**: the
  "North ferry" label is clipped at the map's top edge.
- Deployed and verified **by effect** against the live service, not by the apply's exit status:
  `/api/farmer/onboarding` refuses a malformed token with `400` before touching the database, and
  answers a well-formed but unknown token with the uniform `410 invitation_unavailable` — so the
  endpoint is not an oracle for whether a guessed token names anything. Plan assertions 37/37,
  deploy and served-card assertions pass.
- Production build warnings remain unchanged: Next does not recognize `outputFileTracingRoot`, and
  the Next ESLint plugin is not installed. B-008 owns the lint configuration gap.

## What is live

- **Public discovery:** model-free map/list, offering filters, honest recency, closures, participant
  names, transient browser proximity, destination links, and code-bound stock-out reporting.
- **Farmer workflows:** deterministic `JOIN <token>`, `LINK`, `STAND`, `SETTINGS`, and `SAME`; one exact
  stand per credential; SMS/web proposal and confirmation; closures, participants, and reminders.
  Invited onboarding establishes SMS consent.
- **Customer SMS:** model interpretation over typed retrieval, identifier validation, and
  code-rendered grounded answers. `MAP`, compliance commands, and confirmation routing are
  deterministic and run before any model.
- **Administration:** fixed-account password sign-in and server-rendered farm approval, farmer
  access, flag, stock-report, and stand-data workflows. Phones are masked at the query boundary.
- **Scheduled work:** Cloud Tasks handles immediate sender work; one Cloud Scheduler route runs
  recovery, prompts, delivery, callbacks, and retention.

## Two audit findings the build corrected

The [audit](LISTING_INGESTION_AUDIT_2026-08-04.md) is frozen; these are the corrections, measured
against the real corpus on 2026-08-04 while implementing.

- **Payment methods exist ONLY in the map transcription.** The profile form has no payment question
  — its header carries none. The audit's "22 payment lines" were map lines, not form lines. max
  chose to read them from the map's `Accepts: …` prose rather than ship an empty table.
- **The "0/31 stands with an empty remainder" figure measured the map description**, not the form's
  own columns. Rebuilt from the form, one stand of 35 ends with no prose at all — which is honest,
  since its card still carries hours, season, links, and payments from their own columns.

## Open before go-live

- **Approved farmers still start on no reminder schedule.** `authorizeFarmer` writes no
  `inventory_prompt_preferences` row, so the scheduled-prompt machinery — built and correct —
  reaches nobody. Next tranche; see `~/.claude/plans/warm-dazzling-kahn.md` work item 2.
- ~~**Listing facts are frozen for everyone except an ONBOARDING farmer**~~ — **CLOSED by F-073**
  (**deployed** 2026-08-06). An already-onboarded farmer now has an edit surface at
  `/stand/<token>/listing`, under their existing private stand link: `resolveFarmerLink` re-reads
  the authorization per request, so a revoked farmer's link resolves to nothing without the new
  page restating the rule. The form is **prefilled from `readStandListing`**, and that is
  load-bearing rather than polish — `saveOnboardingListing` replaces the whole listing, so a blank
  edit form would erase a farmer's address and payments when they came only to change their hours.
  **Farm Bucks and offering type remain editable by nobody**: Farm Bucks is a VIGA eligibility
  fact with its own admin workflow, and a farmer cannot make themselves eligible from a form.
- **F-072 — the grandfathered onboarding door is BUILT and DEPLOYED** (2026-08-06). VIGA's Google
  "Farm Stand Weekly Status" form is replaced by one global link at `/farmer/start`: a farmer
  picks their farm from a dropdown and fills in the F-067/F-069 listing form with **no invitation
  and no administrator**. max chose the honour system (2026-08-06) because **VIGA supplied no
  phone roster** — `contacts` holds people who have texted Farm Friend, not a record of who owns
  which farm — so there is no possession check available to build, and picking the farm is the
  whole claim.
  **What keeps the door narrow**: the dropdown offers only farms with **no live farmer
  authorization**, which is F-071's `listFarmsAwaitingOnboarding` predicate stated once and shared
  by the public list and the resolver, so the convenience and the guarantee cannot drift.
  `claimGrandfatheredFarm` **re-checks on submit**, since the dropdown's omission protects nothing
  against a posted farm id, and a farm can gain a farmer while the page is open.
  **Publishing is silent** (max, 2026-08-06) — no VIGA notification and no admin queue entry,
  matching the invited form rather than adding a second pattern.
  **A consequence max accepted, recorded once**: a submission through this door OVERWRITES a
  seeded VIGA listing rather than adding a stand, and with F-065 still open there is no record of
  who changed what. The reachable set shrinks to zero as farms onboard, and an onboarded farm is
  never exposed.
  **The credential design question from the item is resolved**: the body must name the farm (there
  is no token to name one), which inverts the invited path's rule — and the protection that
  replaces it is server-side re-resolution, not trust. `parseListingSubmission` is shared by all
  three doors, so one statement of what a listing may contain serves the invited, grandfathered,
  and edit paths.
  **The geocoding gate was deliberately weakened, and this is the note that says so**: a
  grandfathered farmer holds no token, so a claimable farm stands in the token's place on the
  billed address-lookup endpoint. Farm ids are not secret, so the **throttle is the real cost
  defense on that path**; what the claim check still buys is that the lookup closes for a farm as
  soon as it has a farmer.
- **F-069 is MERGED and DEPLOYED** (2026-08-06). Two changes max asked for on 2026-08-05:
  1. **Structured season / hours / stocking, and payments as a closed set.** F-035's filterable
     columns existed since the seeder but the onboarding form wrote none of them, so a farmer's
     listing was prose in `hours_text` and NULL everywhere a filter looks. `stocking_days`,
     `dawn_to_dusk` and `until_dusk` were already in the schema and are now offered as real
     answers. Payments became checkboxes over a closed set with a free-text tail
     (`packages/db/src/payment-methods.ts`), so "venmo"/"Venmo" stop being two unjoinable values.
     No migration was needed: **no schema change, columns only newly written.**
     `coherentAvailability` mirrors the five CHECK constraints in memory so a contradictory answer
     returns `incoherent_availability` rather than a 500.
  2. **The no-geocoder boundary was NARROWED, not removed** (max reaffirmed after pushback).
     `apps/web/lib/address-lookup.ts` is the one approved call site, behind
     `POST /api/farmer/address-lookup`. The lookup offers a **draft pin the farmer must confirm**;
     an off-island result is refused rather than shown, and every failure degrades to tapping the
     map. `MapProvider`, coordinate-inventing stubs, and mapping **dependencies** remain forbidden
     everywhere, and `architecture.test.ts` now fails on a *second* geocode caller. Its
     comment-stripping fix also closed a real weakness: the old tripwire matched its own prose.
  **The live geocoding call is DONE** (2026-08-06): three real billed calls through the shipped
  `lookupIslandAddress` against the real provider, including a valid Seattle geocode genuinely
  refused as off-island. Still owed: a real **browser** round trip. `GEOCODING_API_KEY` is
  **optional and unset in production** — until it is set there (which needs the infra wiring
  described in Release state), the form asks the farmer to tap the map, the pre-F-069 behaviour.
- **F-070 put the island's main roads on the map (deployed 2026-08-06; 12 secondary road paths verified in the served bytes).** F-043 drew one road on
  purpose ("side roads would turn a legible poster into a street map"), which was right while the
  artwork only oriented a customer. **The onboarding form gave it a second job** — it is how a
  farmer places their own pin — and one spine gives them nothing to place themselves against. max
  chose main arteries plus Westside Highway: twelve roads, 101 vertices against the coastline's
  246, residential grid excluded, drawn at half the highway's weight so the spine still reads as
  the spine (asserted in a test, not left to a screenshot). All traced from OpenStreetMap through
  the same `projectToIsland` as the pins; **Vashon Highway itself was replaced**, since its 13
  hand-placed vertices carried a comment admitting guessing "put the line in the water twice".
- **The ingestion tranche (F-063 → F-061 → F-062, plus F-064's guard) is merged and DEPLOYED —
  but its DATA has not been ingested.**
  F-063 added `inventory_revisions.source` (`sms` requires the full handset chain under a CHECK;
  `viga` requires none of it). F-061 rebuilt the description from the profile form's columns and
  gave `farm_links` and `sales_location_payment_methods` their first writer and reader. F-062
  ingests the weekly stock form as dated `viga` confirmations. **The two on-screen contradictions
  are gone at the data level**, verified over the real corpus — but **still not on the live map**.
  The code that fixes them is now deployed; what is missing is F-064's ingest run, so production
  continues to serve the pre-tranche listing CONTENT through the new code.
- ~~Migrations `0019`, `0020`, and `0021` are owed to production~~ — **DONE 2026-08-05**, in that
  order, before the image that reads them, and verified by effect rather than by exit status.
  `0020`'s table is now the only source of what a stand usually sells and `0021`'s widened
  settlement CHECK is what lets a farmer's own redemption settle their request, so deploying the
  image without them would have broken every listing read.
- **F-064's production run has NOT happened.** Still owed: a re-export of all three CSVs (the
  profile form is **still open**), a **`neondb` snapshot** — with an insert-only utility and GL-015
  open, the snapshot *is* the rollback — max's explicit approval for the bulk write, and the render
  check on a real card afterwards.
- **The three unmatched weekly farms were duplicates, and now resolve** (max confirmed
  2026-08-04). `Venison Valley Farm` and `Ostara` are word-prefixes of their seeded keys;
  `Maggie's Farm` is a **rename** stated in Green Ears' own form row ("Formerly Maggie's Farm")
  and reachable by no spelling rule. `resolveStandKey` stays an **exact** comparison of whole
  words anchored at the start — never a similarity score — and an ambiguous prefix resolves to
  nothing. Measured over the real 35: no seeded key is a word-prefix of another. Unknown stands
  went 3 → 0 and published rows 13 → 16.
- **Attribution for an admin inventory edit is still owed (F-065)** — a revision row carries no
  `admin_actor_id` and there is no general admin audit log, so that workflow must record its own
  action, matching how `stock_out_reports` and `farm_approvals` already work. **F-072/F-073 widened
  this**: there are now three writers of public listing state (invited, grandfathered, edit) and
  none records who wrote. The edit path is the one holding an authorization to attribute to.
- **F-074 — test farms are BUILT and DEPLOYED** (2026-08-06, verified by effect in the served bytes). VIGA can mark a farm
  as a test farm, and it is then **absent** from the map, from `/api/public/stands`, from both
  halves of customer SMS retrieval, and from F-072's farm picker — appearing only for a viewer
  who deliberately asked: `?hidden=true` on the web, a listed sender hash over SMS. Carries
  migration **`0023`** (additive, nullable, safe ahead of the image that reads it).
  **The two ways to be a deliberate viewer are different kinds of thing, and the docs should not
  blur them.** `?hidden=true` is a URL parameter, **not a credential** — anyone who guesses it
  sees test farms, which is acceptable only because a test farm holds no real data. That is
  exactly why this must **never** be used to hide a real farm that wants privacy: B-024's case
  stays `contact_only`.
  **The administrator phone list is a real credential and the riskier half** — a second way to be
  privileged, reachable from untrusted inbound SMS. Three properties contain it, all structural
  rather than promised: it grants **visibility and nothing else** (no path but retrieval reads
  `administrator_phones`, proven by a test that a listed sender still holds no farmer authority);
  it is **code's decision from the sender hash before any model call**, so the model never learns
  it and cannot be argued into naming a test farm; and removal takes effect on the very next
  message. Removal is a **revocation, not a delete**, so the audit trail still answers who was
  listed and when.
  **The flag has its own column on `farms`** — not `is_public`, which the farmer's own form
  rewrites on every save (F-071's lesson, asserted here through the real writer rather than a
  hand-written UPDATE), and not `sales_locations`, because the intent is "this whole farm is
  fake".
  **Four read sites share ONE predicate** (`visibleFarms`), the same shape as F-072's
  `NO_LIVE_FARMER`. The item named three; the farm picker is the fourth.
  **The picker and the resolver deliberately disagree, and that is the design**: a test farm is
  hidden from `/farmer/start`'s dropdown so a real farmer cannot pick it by accident, but
  `claimGrandfatheredFarm` still resolves it — walking onboarding end to end is the one thing a
  test farm exists for, and a farm nobody can claim could never be walked.
  **No "test farm" label anywhere** (max, 2026-08-06): test farm names will already read as test
  farms, so the flag decides presence and never presentation. Nothing was added to the card, the
  wire format, or an SMS answer.
  **Still open, and max's call**: whether `?hidden=true` needs to survive the Squarespace embed,
  or whether working on the direct URL is enough (the embed is how the island actually reaches
  the map — F-044).
- **F-066 — one item vocabulary is BUILT, merged, and DEPLOYED.** `stand_items`
  holds one record per (stand, item name) with two independent states — `usually_carried`, and
  whether a dated revision names it. The separation that justified two tables survives: sharing
  the vocabulary is not sharing the one-current-per-location slot, proven by the schema test that
  standing claims leave a stand with no current revision. Migration **`0020`** creates the table,
  its unique index over `(location, lower(btrim(display_name)))`, and backfills from **both**
  `sales_location_offerings` and `inventory_entries` — the second half is what keeps a
  confirmed-only item as vocabulary without making it a standing claim. `sales_location_offerings`
  survives as the backfill's source with **no reader left**; dropping it is a later change.
  **`inventory_entries` was not modified**: its history guard refuses every update, so the entry →
  item link is the normalized name it already carries, and a confirmed item is resolved to its
  item's spelling in `readPublicStands` so both lists reach the view as one vocabulary.
  Normalization is case and whitespace only — never singular/plural or synonyms, asserted by a
  test that must be deleted before anyone can loosen it.
  **The farmer web form now EXISTS** (F-067, branch `f-067-listing-form`): `saveOnboardingListing`
  is the standing state's farmer-facing writer, so F-066's last acceptance criterion — SMS cannot
  write standing state — is now provable and proven. **Migrations `0019` and `0020` are on
  production** (2026-08-05); `0020`'s backfill wrote 212 item rows from the real listing data.
- **F-067 — self-serve onboarding is COMPLETE and DEPLOYED.** Redeeming an agreed invitation that
  **names a farm** now writes `farmer_authorizations` **and `farm_approvals`** in the same
  transaction as the consent and the redemption, so no administrator acts. Both were required:
  `confirmProposal` checks authorization and then approval independently, so granting only the
  first left the farmer authorized, texted "your farm is ready", and refused with `not_approved`
  on their first update. The approval names the administrator who **created the invitation** —
  the person who decided this farm participates — and is written via `on conflict do nothing`
  against the partial unique index, since `for update` cannot serialize a row that does not exist
  yet. The invitation is the authorization decision; the queue
  click it replaces re-approved a decision already made. The three paths that still need a human
  are unchanged and still queue — except that F-080 removed one of them: an invitation naming no
  farm, and an invitation whose agreement was never ticked. (A bare uninvited `SIGNUP` was the
  third; there is no bare keyword any more.) Migration **`0021`** widens the settlement CHECK from
  "an administrator settled it" to "an administrator **or** the authorization the redemption
  granted" — a settlement recording neither is still refused. The admin invite now **names a new
  farm at invite time**, which is what makes a brand-new farmer reachable by self-serve at all. The
  redemption acknowledgement is omitted for a self-served farmer, since "VIGA will review it" is false
  for someone already set up and arrived beside the "your farm is ready" text.
  **The listing form is now BUILT** (branch `f-067-listing-form`, undeployed).
  `packages/db/src/onboarding-listing.ts` is the **first non-seeder writer of `sales_locations`** —
  before it, `public_address`, `hours_text` and the rest were read everywhere and only ever seeded.
  It supplies the three columns the schema refuses to default, writes payment methods and F-066
  standing items, and **updates the farm's existing stand rather than adding a second**, so a
  farmer invited against a seeded farm does not appear twice on the map. max chose **publish
  immediately, no VIGA review** ("the admin can fix anything that's erroneous", which leans on
  F-065) and **full listing details** over a minimal set.

  **The visitability branch is the form's structure, not a field on it.** `coherentVisitability`
  requires an address and a complete coordinate pair for a visitable stand and forbids all three
  for a contact-only one, so the form asks whether there is a stand to visit before it can know
  what to require. Refused in the writer AND enforced by the database: the constraint is the
  guarantee, the writer's check is what turns it into an answer the farmer can act on.

  **The pin is DROPPED, not looked up.** Nothing in the codebase can turn a typed address into a
  coordinate, and nothing should — a runtime geocoder/map package is a named non-goal and
  `maps/README.md` records that there is deliberately no mapping-provider seam. max chose
  (2026-08-05) that the farmer taps the drawn island; `unprojectFromIsland` is F-043's projection
  run backwards, so it is one statement about where the island is rather than a second one.

  **`apps/web/lib/farmer-listing.ts` is the boundary.** The invitation token is the only credential
  and it names the farm — a `farmId` in the request body is **ignored**, which is what stops any
  link overwriting any farm's public listing. It also strips an address and pin sent alongside
  `contact_only`, since a farmer who fills in an address and then changes their answer is the
  ordinary case rather than an attack.

  **A consequence max accepted, recorded once:** publish-on-submit means anyone holding an
  onboarding link can put a stand on VIGA's public map without proving they hold the farmer's
  phone. Flagged before building; max chose it anyway. Links are one-use, expire in seven days,
  and an admin can remove a bad listing.

  **The page no longer promises a VIGA review** — that copy was retired rather than reworded, since
  redemption now authorizes and approves in one transaction and a promised review is a step nobody
  performs.
- **F-029:** finish live carrier/JOIN launch verification.
- **F-056:** finish protected-page, logout, copied-cookie, throttle, expiry/revocation, mobile,
  keyboard/focus, and recovery-copy browser proof.
- **B-024:** **fixed in code** (F-061) and verified by effect on a rehearsal database — a farmer's
  written refusal makes the stand `contact_only` with no address and no pin, read as a general rule
  from her own words rather than by naming a farm. **Production still publishes her address** until
  F-064's ingest runs; the approved interim correction remains in place.
- **B-008:** replace the incomplete deployed-build lint gate.
- **B-034:** upgrade affected production dependencies and assess advisory reachability.
- **F-044:** verify public-map and authenticated-admin embeds on VIGA's actual Squarespace pages.
- Physical-handset vCard and paged-SMS checks remain owed.
- Exercise the full farmer onboarding/update, administrator, settings, customer inquiry, and farmer
  SMS journeys against production and verify database effects rather than screen messages. The
  consent path in particular is proven against real Postgres but **never against a real handset**.
