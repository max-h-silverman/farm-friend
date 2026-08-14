# Farm Friend — Current State & Open Items

> **Live snapshot, overwritten by `/session-wrap` — not a changelog.** Durable contracts live in
> the architecture docs; session history lives in [SESSION_LOG.md](SESSION_LOG.md).

## Release state

- Farm Friend is **pre-go-live**. Production serves customer SMS inquiry and paging, farmer stock
  updates and reminders, stock-out reporting, farmer onboarding/settings, administrator tools,
  the public stand map/details, and the contact card at `/viga-farm-friend`.
- **Customer inquiry classifies before it matches catalog values** (B-068/B-069). The first model
  call sees the message alone and returns a strict route-specific operation. Inventory/payment alone
  use a second value-only catalog matcher; code validates matches, expands them to every supporting
  stand and evidence voice, orders, pages, and renders them. Broad, hours, location, overview,
  clarification, system inquiry, chitchat, and deterministic VIGA Bucks handling make no matcher call.
- **The SMS answer format is B-062/B-063's:** one entry per stand, name → claims → address, explicit
  recency, three stands per page, and a bare `Map:` close. Confirmed inventory remains `Last seen`
  through day 28; usual offerings remain `May have`/`May also have` and cannot displace confirmed
  evidence for the same item. Open-now returns only stands confirmed open at render time.
- **A single-stand answer is rendered wholly by code** (B-071). A product-less question about one
  stand is `overview` and calls no seam; a stand-scoped `inventory` question answers the yes/no and
  then the same full listing, so a matcher miss can no longer shorten what a farmer published. The
  offerings line subtracts confirmed items, and single-stand answers carry no `Map:` link.
- **Broad availability is a first-class operation.** Call #1 sees no catalog, so catalog contents
  cannot change broad into inventory. Generic inventory nouns remain broad; meaningful categories
  narrow the catalog. `when do you open?` is a system inquiry, while second-person stand inventory
  and payment questions remain stand inquiries.
- **Stand cards lead with availability:** confirmed items or `Nothing confirmed recently`, then
  Typical Offerings. The shared freshness threshold is 96 hours for SMS and map warnings.
- **The customer→farmer stock-out path is closed end to end.** A report may name a published item or
  a usual offering; a clarifying question is held for 15 minutes and then completes the report.
- **A removed farm leaves every public surface** (B-066). Hidden test farms remain operator-visible;
  removed real farms do not. `stand_items` holds one item per row corpus-wide (B-067).
- **The public map link carries `#map`** (F-110). Production refuses to start when the configured URL
  differs from the constant embedded in customer copy.
- **Every opt-in keyword offers the contact card** — `JOIN`, `START`, `VIGA` — and farmer onboarding
  completion sends it beside the listing-live message. Carrier recovery remains `START`.
- **Code owns closure timing and consequential output.** Models select bounded values; they do not
  write public claims, authorize publication, resolve mutable open-now state, or choose evidence.
- **Onboarding survives a seeded stand, and a poisoned inbound message is no longer silent** (B-070).
  Redemption supersedes an existing current revision before publishing held stock, and only redeems
  an invitation that existed when the message arrived. `runInboundPass` logs a routing failure by
  sender hash and event id; recovery is still by lapse, but the silence is gone.
- **One stock vocabulary at every age, and the age states itself.** An SMS stock line always reads
  `In stock (…)`; past one week the parenthesis says `over a week ago` rather than a day count.
  `EXACT_AGE_UNTIL_DAYS` (7) governs wording ONLY — `isStale` (4 days) still decides ranking and the
  map's stale warning, and `isConfirmationExpired` (28 days) still drops the claim entirely.
  `renderStockAge` is the single renderer, shared by the paged answer, the single-stand listing, and
  the item verdict.
- **A single-stand listing is grouped and dated.** Blank lines separate name / stock / payments /
  schedule / address; an empty group collapses. A stand with no confirmation says
  "Nothing confirmed recently." before its standing offerings, and a stand with neither fact no
  longer omits the stock block silently.
- **The farmer's proposal prompt asks for its confirmation** — "Reply YES to publish, or NO to
  discard." The gate itself was always real; the prompt simply never named it. No code-owned reply
  carries an emoji: one non-GSM-7 character re-encodes a whole message to UCS-2 and doubles its
  segments (`reply-encoding.test.ts` holds this).
- **The public map serves security headers** — `frame-ancestors` (VIGA plus self), `nosniff`, and a
  trimmed referrer. This does NOT clear the antivirus reputation block a farmer reported on
  2026-08-14; a custom domain is what addresses that, and it is **blocked on DNS access to
  `vigavashon.org`**.
- Neon `neondb` has **42 applied migrations (`0000`–`0041`)**. This release adds no migration.
- Cloud Run web `farm-friend-web-00081-ql9` and worker `farm-friend-worker-00076-8hk` serve digest
  `sha256:14347f34924bca7606d15065bebf145d1999feafa7bb222176d2a94f35cd727a`, built from merged
  `main` `3ee6bc7` and deployed 2026-08-14. Plan assertions 60/60; mounted-secret freshness, public
  API, and served-card assertions pass; neither revision has an error-level log. The map's three
  response headers were read back from the live service.
- **This repo has no CI.** Local suites are the merge gate; `gh pr checks` has no required checks.

## Verification

- **2,055 unit tests pass; 7 corpus-only tests skip.** **963 integration tests across 64 files pass**
  against disposable local Postgres databases (2026-08-14).
- The map still loads inside VIGA's iframe after the `frame-ancestors` header shipped — confirmed in
  a browser by max, 2026-08-14. That was the one real risk in the header change: a policy that named
  the wrong host would have blanked the embed rather than failing loudly.
- Typecheck, lint, production web build, and scripted evals pass: critical 11/11, advisory 4/4,
  adversarial 19/19. The build retains tracked Next configuration/lint warnings (B-008).
- Live model evals pass: containment 4/4, closure 7/7, quality 16/16, operation 5/5, catalog 7/7;
  broad/inventory 13/13, other operations 7/7, second-person boundaries 5/5, VIGA/domain 5/5.
- The full top-level corpus is 52/53 with only the pre-existing `what is viga` miss. The gate fails
  on any new miss rather than treating that known baseline as a B-069 regression.
- Production deployment is verified by immutable digest and revision readback, deploy assertions,
  health/public/protected-route checks, and served-card wire bytes. No schema change was owed.

## Standing facts a cold start needs

- Farmer onboarding sends the farmer to text **VIGA** from their stated handset; `START` remains the
  carrier recovery fallback. Onboarding inventory publishes only after verified handset redemption.
- VIGA Farm Bucks is a farmer-owned acceptance claim, stored apart from payment methods. `LINK`,
  `STAND`, and `SETTINGS` retain their deterministic farmer behavior.
- A dated stock claim has one provenance: `sms`, `web`, or `viga`. `visitability` controls whether
  a stand gets a map invitation and directions link.
- Inquiry matching receives each unique public item/payment value once and no stand association.
  `pending_result_lists.broad` is written but deliberately unread until that table next migrates.
- `DEEPINFRA_API_KEY` is VIGA-owned. Live evals intentionally fail provider errors rather than
  counting a contained refusal as model quality.
- Local integration tests require Postgres and run with `npm run test:integration:local`; the plain
  command fails loudly when `DATABASE_URL` is absent. `psql` lives under Homebrew's Postgres 16 path.
- Migration `when` stamps can land behind their predecessor on this machine; RUNBOOK §Migrations owns
  the repair. Every production plan must include `infra/production.tfvars`.

## Open before go-live

- Finish physical-handset checks: farmer onboarding/consent, contact card, paged SMS, administrator
  and settings flows, F-105 stand details at phone width, Squarespace embeds, and `?hidden=true`.
- **B-068/B-069 still need handset confirmation:** `cucumber` must retain Forest Garden's dated
  evidence — now `In stock (over a week ago)`, not `Last seen` — and representative
  inventory/broad/payment replies should confirm the reduced model-call path under production
  transport.
- **The 2026-08-14 SMS wording changes owe a handset pass.** A grouped stand listing, a stale
  `In stock (over a week ago)` line, the farmer proposal's `Reply YES to publish, or NO to discard.`,
  and the emoji-free greeting all shipped verified in integration and against the live model, but no
  message has been read on a real phone.
- **The map's antivirus block is NOT fixed.** A farmer reported Webroot flagging the embedded map as
  phishing on 2026-08-14. Security headers shipped, but the signal is the hostname: VIGA's page
  iframes the raw `*.run.app` host. The fix is a custom domain (`map.vigavashon.org`) mapped to the
  Cloud Run service — **blocked on DNS access to `vigavashon.org`**, which max is pursuing. It needs
  a domain mapping in `infra/`, `PUBLIC_BASE_URL` updated, the Squarespace iframe src changed, and a
  wall-clock wait for certificate provisioning after DNS resolves.
- **B-071 owes a handset check:** `what's in stock at <stand>?` must list every confirmed item the map
  shows, and `does <stand> have <item>?` must answer yes/no and then the same full listing. Both were
  verified against the live model and in integration, not yet over production SMS.
- **B-066 owes one console check:** remove a test farm, confirm map/SMS disappearance, then restore it.
- **F-111 Phase 2 handset pass is 2/13.** Remaining cases cover STOP/START, HELP, named-stand inquiry
  and report, farmer own/other-stand reports, both VIGA Bucks shapes, map, a partial stand name,
  open-today, and the unclear reply.
- **Classifier known miss:** `what is viga` → `search_stands` rather than `system_inquiry`. Add real
  misroutes to the corpus; do not tune around this advisory fixture without production evidence.
- Provider-failure copy is integration-tested only. A real outage test belongs on an isolated preview
  service, never VIGA's production model account.
- Phone-width visual checks remain owed for onboarding, farmer settings/listing, map details, and the
  three administrator tabs. F-065, F-084, B-008, B-034, B-036, F-101, and B-048 remain planned.
- VIGA must decide whether Vashon Island Farmers Market belongs in the roster as a farm. F-108 remains
  an idea for a per-answer map showing only returned stands.

## Traps worth not rediscovering

- RUNBOOK owns migration generation/order, production fingerprinting, seeding, secret rotation,
  immutable-image deployment, and Neon reachability. DEVELOPMENT owns codebase/test gotchas.
- **One emoji doubles a message's cost.** A single non-GSM-7 character re-encodes the WHOLE body to
  UCS-2, dropping per-segment capacity from 153 to 67 — the greeting billed two segments for 73
  characters. It is an encoding effect, not a length effect, and invisible by inspection because the
  emoji renders correctly everywhere it is read. `reply-encoding.test.ts` sweeps every code-owned
  reply; measure with `estimateSmsSegments` before adding any decoration.
- **A stale local server can serve headers that the config no longer describes.** While verifying the
  map headers, a `curl` returned a 200 with no headers at all against a build whose manifest clearly
  contained them — a server process left running from before the rebuild. The config assertion and
  the wire disagreed, and the wire was stale, not the config. Restart before believing either.
