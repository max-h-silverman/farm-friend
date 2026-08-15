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
a warning. Active owner-confirmed participant names appear as plain text under **Also selling here**,
separate from aggregate inventory. One canonical read-time closure projection feeds the map/detail
status, the `Open now` decision, destination actions, discovery, and customer SMS: an active
owner-confirmed closure overrides the standing schedule, while a future closure shows as upcoming.
Optional browser geolocation sorts by approximate straight-line distance in the browser;
destination-only Google Maps links delegate routing.

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

- only the authorization's **editable locations**;
- one default SMS target;
- the one inventory-reminder cadence per stand, changed or paused by the farmer (starts at `weekly`
  at setup, F-081);
- the structured one-name-per-line participant save for the selected stand — its own confirmation and
  audit event, routed through db + clock before full model composition, re-resolving the link, and
  unable to grant access or attach names to profiles.

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
- **Admin:** sign-in → **single-level** VIGA administration across three surfaces, one per subject
  (F-100): **Farms** (approval, farm details, who can update it, setup links, its stands, taking a
  farm or stand down), **Messages** (flags, stock-out reports, questions about VIGA's own records),
  and **Users** (everyone who has texted, inviting a farmer, deciding access requests). `/admin`
  redirects to Farms. Organizing by subject rather than by queue keeps one screen owning each
  entity; see ADMIN_OPERATIONS.md.
  `POST /api/admin/stands` carries the per-stand acts: Farm Bucks, retire/restore, and — since
  F-114 Phase C.1 — `invite_seller`, which mints a one-use link inviting a seller to sell at that
  stand. **`invite_seller` has no button yet**: the endpoint is live and tested, the Farms screen
  does not call it, so today it is reachable only by an authenticated request. The acting
  administrator always comes from the session, never the body.
- **Telnyx webhook:** signature-verified inbound SMS → deterministic routing.
- **Scheduled jobs:** farmer prompting, outbound delivery, retry, and retention.

