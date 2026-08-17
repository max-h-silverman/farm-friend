# Farm Friend — Runtime surfaces

Every surface Farm Friend exposes and the bounds each one enforces: the public web, the farmer stand
form and settings, farmer onboarding, the migration door, admin, the Telnyx webhook, and scheduled
jobs. **Open the surface you're touching** — this is a reference, not a cold-start read.

The system contract around them is in [ARCHITECTURE.md](ARCHITECTURE.md): package layout, deterministic
routing, confirmation, workflows, provider seams, and the invariants. That doc owns the *rules*; this
one owns the *surfaces* that honor them.

> No build status — that lives in [CURRENT_STATE.md](CURRENT_STATE.md).

## Public web

The model-free map render + listing/filter experience, ungated and embeddable in VIGA's site;
optional transient browser-origin proximity; per-stand pages; destination routing links; and the QR
stock-out web form. Anonymous, no signup. There is **no launch natural-language web inquiry**.

`GET /api/public/stands` serves discovery; the map UI at `apps/web/app/page.tsx` renders those
published records. Every card carries code-rendered recency, and a stale listing stays visible with
a warning. Since F-114 C.5 the payload carries **every seller at a stand** with its own items,
price, freshness and open-now state, and the detail card is **item-first**: each item once, with
its supporting sellers nested beneath it. The stand's own seller renders unlabelled by
SELF-POINTER; every other is credited. An **active closure publishes nothing itemized** — both
registers, every shape, and the recency that would date them. Active owner-confirmed participant names appear as plain text under **Also selling here**,
separate from aggregate inventory. One canonical read-time closure projection feeds the map/detail
status, the `Open now` decision, destination actions, discovery, and customer SMS: an active
owner-confirmed closure overrides the standing schedule, while a future closure shows as upcoming.
Optional browser geolocation sorts by approximate straight-line distance in the browser;
destination-only Google Maps links delegate routing.

`/sellers` is the second public list view (F-114 C.5): a browse list of every seller currently
selling anywhere on the island, grouped by SELLER with their stands nested — the mirror of the
stand card, which groups by item with sellers nested. It exists because a **hosted-only seller**
owns no `sales_locations` row and therefore has no pin and no card; this page is their only
discovery path. Its search matches a seller's own name and goods and deliberately NOT the stands
they sell at, and it carries no confirmed inventory or freshness at all — what is out right now is
the stand card's question, stated there with its own per-seller recency. Reached from the map's
filter header ("Browse by seller"), and covered by the same model-free tripwire.

`POST /api/public/stock-out` is the one public model-backed handler, behind the throttle.

**The model-free property is structural, not a convention:** the public read path imports
`lib/public-context.ts` (db + clock) rather than the full composition root, so no model seam is
reachable from its module graph — asserted by `lib/public-surface-model-free.test.ts`, which walks
the transitive imports of both public entry points.

## Farmer stand form (F-040)

`/stand/<token>` — a farmer's own listing form, reached by a **standing link with no password and no
session**.

- The token is the whole credential, **re-resolved server-side on every request** so a revocation
  takes effect on the next load.
- It is posted in the request **body** to `/api/farmer/stand`, never a query string.
- A leaked link can at worst propose a wrong listing on **ONE** stand;
  `apps/web/lib/farmer-stand.integration.test.ts` asserts and sabotages each bound.

**The web path gets no bypass of the confirmation gate.** A submission opens or revises the farmer's
one pending proposal; publication happens only through `confirmInventoryPublication`, which re-reads
farmer authority, VIGA approval, and stand retirement (F-071) under lock — the retirement read comes
from the location row that transaction already holds, so a retirement racing an in-flight
confirmation resolves at the lock rather than by arrival order.

**What the farmer presses is one button, and that is a screen rather than a gate** (F-097).
`publishStructuredFromLink` composes the propose and confirm calls in one request, so every check
above still runs; the preview was removed because on this surface the farmer reads the rows they
typed rather than code's reading of their prose. The one honest difference from SMS is activation:
there is no carrier prompt to accept, so the window opens against a confirmation message written
**`suppressed`** — it exists because `activation_coherent` requires a message the proposal activated
from, and it is never sent.

`/stand/<token>/settings` reuses that credential and revocation lifecycle, and owns:

- only the authorization's **editable listings** — one row per provider since F-114 C.4, with the
  seller credited beside the stand name only where the two differ (by self-pointer, never a name
  match);
- one default SMS target, named as a LISTING;
- the one inventory-reminder cadence per LISTING, changed or paused by the farmer (starts at
  `weekly` at setup, F-081);
- the structured one-name-per-line participant save for the selected listing's STAND — participants
  are the stand's own record, so two listings under one roof share one list — its own confirmation and
  audit event, routed through db + clock before full model composition, re-resolving the link, and
  unable to grant access or attach names to profiles.
- **the stand owner's own seller invitation** (F-114 Phase C.1) — `invite_seller` on
  `/api/farmer/stand`, which mints the same one-use onboarding link VIGA's door does and records the
  holder's authorization as the vouch, so acceptance lands `approval_source = 'host'`. It takes a
  NAME and never a seller id: offering the roster would widen `resolveFarmerLink`'s projection to
  every seller on the island. It has **its own button**, never "Save settings" — it mints a
  once-shown link rather than writing a setting.

**The SMS half of that door is the link the farmer already holds.** `LINK` and `SETTINGS` both text
this page, so no keyword was added: one would need a free-text grammar for a name that becomes a
public brand plus a way to text a 64-hex link back for forwarding.

**A leaked link can now create a seller and a `pending` relationship at its own stand** — and still
authorize nobody. Acceptance requires the invited seller's own handset and a bare `START`, and
`pending` is excluded by every public reader, so the worst a leak achieves is an unaccepted
invitation VIGA can revoke. Asserted and sabotaged alongside the other five bounds.

**No second login and no consent control**; pausing reminders never changes launch-program consent.

## Farmer onboarding (F-067)

`/farmer/onboarding/<token>` — a one-use invitation link capturing the SMS agreement, the farm's
**listing details**, and the **phone the farmer will text from**, then handing off to a prepared bare
`VIGA` text. The invitation token is the whole credential and is posted in the request **body**
(`/api/farmer/onboarding`, `/api/farmer/listing`). **The token also names the farm**: a `farmId` in
the request body is ignored, which stops one invitation writing another farm's listing.

The listing step is the **first farmer-facing writer of public listing facts**. It asks every farm for
an address and complete resolved location first; the later visitability answer decides whether
customers are invited to drive there, not whether the farm may be placed (F-088). The writer mirrors
`sales_locations_coherent_visitability`: complete address + coordinate for either answer, or a wholly
absent location only for `contact_only`.

- **The coordinate comes only from geocoding the typed address** (F-077, §provider seams); an address
  that will not resolve is **refused** rather than approximated.
- The drawn island is a **read-only display** of the resolved point, so the farmer can check it.
- Editing the address **clears** the coordinate, which stops one address publishing under another.

It also collects **structured season, hours, weekday and restocking facts** into F-035's filterable
columns, and payment methods as a **closed set** plus a free-text tail. **VIGA Farm Bucks sits outside
that set but is offered to every farmer** (max, 2026-08-10): acceptance is the farmer's own claim and
publishes on their word; VIGA's separate eligibility flag does not gate it. It publishes on submit
(max, 2026-08-05) rather than waiting for the JOIN text, and writes **standing item state only** —
never a dated confirmation.

## The migration door (F-079)

`/farmer/start/<secret>` — how a farmer already on VIGA's Google weekly-status form moves onto Farm
Friend: pick your farm, prove you control an address VIGA holds, fill in the same listing form. The
bare `/farmer/start` no longer exists; new farms are invite-only (F-080).

- **The secret is obscurity, not authentication** (DATA_ARCHITECTURE §privacy): it travels in browser
  history, `Referer` headers and access logs, and is neither one-use nor revocable per farmer.
- Absent, blank, or under 32 characters means the door does not exist — and a wrong secret gets the
  **same 404** as an unconfigured deployment, so the response never reveals it is merely switched off.
- **The emailed code is what gates publishing.** `verify-request` always answers the same `sent` (on
  file or not, already issued, budget spent, relay refused), or it becomes a service for asking which
  address VIGA holds. `verify-submit` answers one identical body for every refusal and checks the
  attempt cap **first**, so a capped record is not an oracle for whether a guess was close.
- **Verification grants listing-publish rights only, never farmer authorization** — updating stock by
  text still needs an inbound message from a consented handset. The grant is an `HttpOnly` cookie
  whose hash is re-resolved per request and checked against **that** farm.
- Both routes build from `publicReadContext` plus a narrow config read, **never the full composition
  root** (F-073): `appContext()` validates SMS, model and map configuration, so binding an
  unauthenticated farmer page to it makes it 500 on an unrelated missing variable.

## Other surfaces

- **Farmer address lookup:** `POST /api/farmer/address-lookup` — invitation-gated, throttled,
  server-side geocoding that returns a coordinate and writes nothing. The **only** source of a
  stand's coordinate.
- **Admin:** sign-in → **single-level** VIGA administration across three surfaces (F-100, restructured
  by F-101): **Stands & Sellers** (`/admin/stands` — one destination holding two views: stands with
  who sells there, sellers with where they sell; approval, farm details, who can update it, setup
  links, taking a farm or stand down, and pause/resume/Remove per arrangement), **SMS Users**
  (everyone who has texted, inviting a farmer, deciding access requests), and **Alerts** (flags,
  stock-out reports, questions about VIGA's own records). `/admin` redirects to `/admin/stands`.
  **There is no Farms tab** — VIGA's job is view and edit stands and sellers, so acts about a farm
  live inside that farm's card rather than on a screen of their own. See ADMIN_OPERATIONS.md.
  `POST /api/admin/stands` carries the per-stand acts: Farm Bucks, retire/restore, and — since
  F-114 Phase C.1 — `invite_seller`, which mints a one-use link inviting a seller to sell at that
  stand and answers with the complete onboarding URL, **shown once**. Its button lives inside each
  stand's card, and is absent for a stand that is off the map.
  `POST /api/admin/participation` (F-101) is the **only production caller** of
  `setProviderParticipation`: pause, resume or end one seller's participation at one stand. It is
  deliberately thin — it never writes `stand_providers` itself, so the seam keeps the lock ordering,
  the authority arms and the invalidation of that provider's open confirmations.
  On every admin route the acting administrator comes from the session, never the body. A seller
  name is public text and is refused with the same code-owned copy the farmer's door uses.
- **Telnyx webhook:** signature-verified inbound SMS → deterministic routing.
- **Scheduled jobs:** farmer prompting, outbound delivery, retry, and retention.

