# Farm Friend — Current State & Open Items

> **Live snapshot, overwritten by `/session-wrap` — not a changelog.** Durable contracts live in
> the architecture docs; session history lives in [SESSION_LOG.md](SESSION_LOG.md).

## Release state

Farm Friend is **pre-go-live**. Production and `main` agree after B-096: customer SMS inquiry and
paging, farmer stock updates/reminders/onboarding/settings, customer stock-out reporting, the public
map/details/contact card, and the VIGA administrator console are live.

- **Consent gates every substantive SMS answer (F-121).** No consent → one `JOIN` invitation;
  opted out → nothing. Carrier compliance commands bypass the gate by routing order; `MAP` does not.
- **Customer inquiry classifies before catalog matching.** Code validates matches, expands evidence,
  orders/pages results, and renders authoritative text with recency. Models never write facts.
- **Payment belongs to the seller (F-125).** She states ordinary methods and Farm Bucks once; a
  stand may only narrow ordinary methods through exclusions. There is no eligibility state.
- **A public stand card is seller-major (F-119).** Each seller carries their own items and recency;
  a single-seller stand shows no redundant native-seller row.
- **Admin Edit details covers the complete onboarding listing:** location/privacy, visitability,
  offering type, season/hours/restocking, usual offerings/prices, payment, Farm Bucks, and prose.
  Live inventory, closures, approvals, retirement, and participation remain separate.
- **The embedded admin is supported at exactly `https://vigavashon.org` (B-096).** Mutation-origin
  and `frame-ancestors` policies agree; absent, `www`, lookalike, and attacker origins are refused.
- **Three public open states:** Open / Closed / Hours unknown. `isDefinitelyShut` is the one closed
  definition; new states default to unknown rather than making a false closure claim.
- **All public/SMS links use `farmfriend.vigavashon.org` (F-113).** Public contact is
  `farmfriend@vigavashon.org`; administrator and Gmail relay identity remain `board@`.
- **No CI exists.** Local suites, production build, and deployment assertions are the release gate.

## Deployment and data

- Serving **`farm-friend-web-00094-bmv`** / **`farm-friend-worker-00089-npl`**, digest
  `sha256:9559a641…`, from merged commit `4d322c2` (PR #141). No schema migration was needed;
  deploy assertions, served contact-card bytes, custom-domain health, and error logs pass.
- Neon `neondb` has **59 migrations (`0000`–`0058`)**, 43 sellers, and 39 stands. Migration output
  is never proof: verify schema/data effect, and repair generated journal ordering when needed.
- The worker carries only its email secret set; it must never hold the admin verifier, geocoding key,
  or privacy salts. `infra/deploy_assertions.py` enforces the split.
- `public_host` lives in tracked `infra/production.tfvars`; omitting that file destroys the domain
  mapping and reverts F-113 while Terraform reports success.
- `inventory_publication_proposals.provider_id` is intentionally nullable: closure-only proposals
  use the alternate checked arm.

## Verification

- **2,504 unit tests across 177 files** (7 corpus-only skips), **1,508 integration tests across all
  111 files**, typecheck, lint, and the production web build pass on 2026-08-22.
- Scripted evals remain critical 11/11, advisory 4/4, adversarial 19/19. No model seam changed in
  this release, so paid live evals were not rerun.
- The B-096 CSRF test was sabotage-proved by accepting every origin: attacker/lookalike cases fail.
- B-073's post-apply production plan is empty; template scaling remains web `0–1`, worker `0–2`.
- The complete admin listing writer is integration-proved to preserve published live inventory.
- Max approved release without a rendered browser pass after browser automation could not connect.
- B-078's environmental signature remains: moving file-level failures with no named failing test.
  A named failing test is real until reproduced and explained.

## Stable data decisions

- Fernhorn Bakery is one seller at Tian Tian and Pacific Crest; Handpicked Homestead sells only at
  Plum Forest; Gracie's Greens is a distinct seller. Vashon Island Honey Co. and Kareli Farm remain
  unresolved.
- Morgan Hill keeps its self-pointer. Its typed participant names are decorative, not identities;
  current inventory and authorization depend on the owning seller row.
- Farm Bucks defaults accepted because it is near-universal; the accepted risk is that an unstated
  refusal can send a customer to a stand that cannot take vouchers.
- A dated stock claim has one source (`sms`, `web`, or `viga`). Usual offerings are standing listing
  facts and never imply current stock.

## Open before go-live

- **Real-device verification remains the largest gap.** Run F-111 Phase 2 SMS flows from a real
  handset, beginning with the unconsented → `JOIN` → welcome → inquiry sequence.
- **Browser/phone-width pass:** admin Stands & Sellers including inline Edit details, map view toggle
  and cards, onboarding, farmer listing/settings, map details, and the once-shown setup link. Check
  the map tooltip first and verify the declared light palette under both OS appearances.
- **B-094 decision:** approval cannot be reversed after the toggle removal; decide whether revoking
  farmer authorization is the complete replacement, then remove the dead writer/branch if so.
- **B-093 decision:** the carrier HELP body still names `board@`. Read Telnyx first, then update the
  registered-value file and constant together.
- Decide whether Vashon Island Farmers Market belongs in the farm roster.
- Stock-out reports with no reachable farmer reach nobody; eight existed when the VIGA queue was
  removed. The reader remains for a future deliberate surface decision.
- **B-081:** production geocoding key is unrestricted. API restriction is safe; IP restriction
  depends on Cloud Run egress and can disable creation of visitable stands.
- **B-066:** Josie's Farm remains deliberately hidden; the restore half is unrun and script-only.
- Webroot/reputation clearance for the custom domain is unconfirmed; ask the original reporter.
- Classifier known miss remains `what is viga` → stand search; corpus gates only new misses.
- Planned gaps remain F-065, F-084, B-008, B-034, B-036, B-048, B-076, B-079, B-097, and provider-outage
  copy against an isolated preview service.

## Operating traps

- Client components import browser-safe `@farm-friend/core/*` subpaths, never the core or database
  barrels; either can pull server-only crypto/database code into the browser bundle.
- Local development starts with `./scripts/dev-setup.sh --run`; root `npm run dev` is intentionally
  absent. Never place the `$`-delimited admin password verifier in `.env.local`.
- Use `npm run test:integration:local`; the plain command needs `PUBLIC_BASE_URL` as well as the
  database URL. Integration tests create and drop disposable local databases.
- Read [DEVELOPMENT.md](DEVELOPMENT.md) §gotchas before touching migrations, constraints, tests, or
  SMS copy; read [RUNBOOK.md](RUNBOOK.md) for production fingerprinting and deployment.
