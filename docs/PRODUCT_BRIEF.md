# Farm Friend — Product Brief

The *product* source of truth: what Farm Friend is, who it serves, and the flows it must get
right. System/data/AI mechanics live in their own docs (see [README.md](README.md)).

## North star: a fresh map

VIGA publishes an embedded Google Map of Vashon Island farm stands and their goods. Today that map
is the *only* resource, and it runs **2–7 days stale** because a VIGA volunteer hand-enters data
from farmer-submitted forms. Power-users cope by keeping private lists of which stands usually
have what. **Farm Friend's core job is to collapse that lag** — let farmers update their own stand
directly (mostly by SMS), so the map is fresh, and remove the volunteer bottleneck.

## The coordinator at a desk

Design every part of Farm Friend as if it were a single trustworthy **coordinator / customer-
service agent** at a desk, serving VIGA and the community. On the desk are **files** (the
source-of-truth data: farm profiles, current inventory + when it was last confirmed,
subscriptions, gleaning opportunities, the report/flag queue) and **ways to answer** (the
map/feed, SMS replies, and its own **inference** — reading messy messages, drafting, suggesting).
When a design question is unclear, ask *"what would a good coordinator at a desk do?"*:
- It **answers from the files**, and when a file is old it *says so* ("confirmed 3 days ago")
  rather than pretending. → grounded, recency-labeled answers.
- Its **inference reads and drafts, but never rewrites the official files on a hunch.** It drafts;
  the responsible person (farmer, VIGA staff) confirms. → the model proposes, code commits;
  publish is confirmation-gated.
- It has **professional boundaries.** A customer saying "you're out of bok choy" doesn't let the
  clerk change the farmer's listing — it takes the message and passes it to the farmer. → customer
  reports alert, never mutate. It protects private info; it knows whose authority governs what.
- Its **customer-service stance**: when unsure it **asks a clarifying question** instead of
  guessing; it's honest about what it doesn't know; and it **hands off to a human** (FLAG → the
  review queue) when something needs judgment.

## How Vashon farm stands actually work

Nearly all stands are **unattended, honor-system** stands with a stable set of *staple* items but
*variable* stock. A stand doesn't know it's out of bok choy until the farmer next checks it. So
"is it in stock right now" is inherently uncertain, and that uncertainty must be shown plainly
rather than hidden — every stand surfaces "updated X ago."

## The three real flows (+ the inquiry route)

1. **Farmer publish** (confirm-to-be-safe). Farmers care about accuracy and their reputation. They
   text a list → the system echoes a clean summary → the farmer replies `YES` → it goes live on
   the map. SMS is the ongoing update channel; web is an additional surface.
2. **Customer discovery — two sub-surfaces:**
   - **The map (primary).** **Farm Friend serves the map itself** (map render + a stable data feed
     the VIGA site embeds), freshness fully under our control rather than Google My Maps'. Each
     stand shows a visible "updated X ago" so customers judge staleness.
   - **The SMS/web inquiry route (first-class).** Customers ask free-form questions and get
     grounded answers. The intent space is **open-ended and often ambiguous** — for "where can I
     get bok choy and green beans?" the customer might want *one stand with both*, the *two
     closest* each with one, *any* stands covering the set, the *freshest*, etc. The design must
     not privilege one reading: `inquiry-parse` determines item(s), farm scope, origin, and a
     **selection/ranking strategy** (proximity / freshness / coverage / any) or an "ambiguous →
     ask" signal; code owns a **general retrieval + ranking layer**; the model composes only over
     the retrieved grounded rows. Empty retrieval → honest "no current listing." Also supports
     farm-scoped listing and farm-/inventory-scoped recipes. *(Example phrasings are illustrations
     of the intent space, never a spec — see CLAUDE.md "Examples are illustrations.")*
3. **Customer stock-out report → farmer alert** (VIGA specifically wants this). Customers **never**
   edit inventory. A customer says "out of bok choy" — via SMS or a **QR code at the stand → web
   form**. This **does not change the map**. It privately alerts the *farmer*, who decides whether
   to act. The farmer is the only one who can change published state.

## The migration & launch moment (the product's riskiest, most important switchover)

Migration is **not a data-loading chore** — it is a **one-time switchover** coinciding with **Eat
Vashon week**, a fixed community-event launch VIGA is doing human outreach ahead of.

- **Migrate ALL existing Google Map data, shown as `current` on the live map.** Day one, Farm
  Friend's map is a **faithful, full clone** of VIGA's map — at least as good as today from moment
  one, *not* a thin "directory-only" downgrade.
- **`current` means "shown as the current listing," NOT "confirmed today."** Two **separate axes**
  (detailed in [DATA_ARCHITECTURE.md](DATA_ARCHITECTURE.md)): lifecycle `status` governs *is it
  shown*; provenance + a real/import date governs *honesty about age*. A migrated pin renders
  "**via VIGA's map, updated [date]**", **never** "confirmed today." On activation, provenance
  flips to `farmer_confirmed` and recency resets to real.
- **Activation = one front-door-agnostic "confirm-or-revise" seam, with TWO triggers.** The old
  Google Form **stays live** as ongoing intake (no forced behavior change). A migrated stand
  becomes farmer-owned via either trigger, both converging on the *same* seam:
  - **Trigger 1 — form-submit:** a farmer submits the existing Google Form → Farm Friend sends a
    quick confirm/claim message ("Provo Farms currently listed: tomatoes, kale, eggs. Still right?
    Reply YES, or text changes.").
  - **Trigger 2 — VIGA outreach:** ahead of Eat Vashon week VIGA points farmers at a claim link /
    QR / SMS keyword → same claim flow.
  The seam **reuses the publish extract+confirm machinery with a PRE-SEEDED draft**: `YES` confirms
  the migrated data as-is (no retyping); a text reply runs `farmstand-inventory-extract` on the
  revision.
- **Non-responders stay `migrated`, honestly labeled, indefinitely** — a useful directory entry
  with an honest age label, not a failure state.

## Actors

- **Farmer** — updates their stand (SMS daily driver; web entry point); owns published state.
- **Customer** — discovers via the map/feed, asks via the inquiry route, reports stock-outs.
  Anonymous public lookup is allowed without signup.
- **VIGA staff** — operate daily ops through a guided web admin (approve/claim farmers, migrate
  data, resolve flags, watch stock-out reports, inspect threads). One tech-comfortable coordinator
  does heavier triage; Max is escalation.
- **Volunteer** — (later) signs up for Food Bank gleaning opportunities.

## MVP scope

**In (launch set, all live by Eat Vashon week):** full migrated-as-current map/feed → two-trigger
farmer activation → farmer inventory publish → stock-out→alert → open-intent inquiry + recipes →
admin flag review/thread viewer (a **hard SMS-compliance gate**). SMS is **critical path** (A2P
10DLC assumed approved by launch).

**Later:** gleaning coordination (staff create opportunities, volunteers reply YES/NO, tallies +
reminders) — designed now (tables in the spine), built after the farmstand loop. A native app
(Expo, scaffolded). Multiple tenants beyond Vashon. **Out:** for-profit farm volunteer flow;
Food Bank partner-facing visibility/export.

## Open questions (non-blocking; noted, not resolved)

- **VIGA export shape:** does the Google My Map / Form export carry a per-stand last-updated date?
  (Determines whether migrated pins show real ages or the import date — blocks nothing.)
- **Non-responder policy:** reminder-nudge cadence + any "hide very-stale migrated pin after N
  days" — defer to F-007 with real response rates.
- **Cold outreach blast:** whether VIGA later wants a proactive "come claim your stand" broadcast
  in addition to the two triggers — a GTM call; the activation seam already supports it.
