# Farm Friend — Product Brief

The *product* source of truth: what Farm Friend is, who it serves, and the flows it must get
right. System/data/AI mechanics live in their own docs (see [README.md](README.md)).

> This document is the **product authority** — what Farm Friend is for, who it serves, and the
> launch scope. It carries no build status: what is actually built and open lives in
> [CURRENT_STATE.md](CURRENT_STATE.md).

## North star: current information, without VIGA doing data entry

VIGA publishes an embedded Google My Map of Vashon Island farm stands and their goods. Today that
map is the *only* resource, it carries free-form and largely unfilterable text, and it runs stale
because a VIGA volunteer hand-enters data from farmer-submitted forms. **Farm Friend's core job is
to keep farm-stand information current with little or no routine VIGA data management** — farmers
own and update their own listings (mostly by SMS), and customers discover what they can buy locally
right now.

Six months after launch, the product has worked if: VIGA board members and volunteers are largely
relieved of manual map maintenance; a much higher percentage of farm-stand inventory is current;
farmers respond to proactive SMS prompts; hundreds of unique customers use Farm Friend monthly;
people have learned to text Farm Friend with natural requests; and the public web experience is
substantially more useful than the embedded Google My Map.

## The coordinator at a desk

Design every part of Farm Friend as if it were a single trustworthy **coordinator / customer-
service agent** at a desk, serving VIGA and the community. On the desk are **files** (the
source-of-truth data: farm listings, current inventory + when it was last confirmed, consent, the
report/flag queue) and **ways to answer** (the map, SMS replies, and its own **inference** —
reading messy messages, drafting, suggesting). When a design question is unclear, ask *"what would
a good coordinator at a desk do?"*:
- It **answers from the files**, and when a file is old it *says so* ("updated 3 days ago")
  rather than pretending. → grounded, recency-labeled answers.
- Its **inference reads and drafts, but never rewrites the official files on a hunch.** It drafts;
  the responsible person (farmer, VIGA staff) confirms. → the model proposes, code commits;
  publication is confirmation-gated.
- It has **professional boundaries.** A customer saying "you're out of bok choy" doesn't let the
  clerk change the farmer's listing — it takes the message and passes it to the farmer. → customer
  reports alert, never mutate. It protects private info; it knows whose authority governs what.
- Its **customer-service stance**: when unsure it **asks a clarifying question** instead of
  guessing; it's honest about what it doesn't know; and it **hands off to a human** (FLAG → the
  review queue) when something needs judgment.

And picture the desk itself: a **minimalist, zen office** — a beautiful walnut desk with a few
folders stacked neatly, color-coded labels on indexed racks, like things grouped together — *not* a
harried bureaucrat's old metal desk buried in loose paper. The coordinator is trustworthy *because*
the office is orderly: few files, each in its place, nothing duplicated, nothing kept "just in
case." Simplicity and elegance are architectural requirements
([ARCHITECTURE.md](ARCHITECTURE.md) "Design stance"; CLAUDE.md "Simplicity and elegance").

## How Vashon farm stands actually work

Nearly all stands are **unattended, honor-system** stands with a stable set of *staple* items but
*variable* stock. A stand doesn't know it's out of bok choy until the farmer next checks it. So
"is it in stock right now" is inherently uncertain, and that uncertainty must be shown plainly
rather than hidden — every stand surfaces "updated X ago." **Stale information stays visible with a
prominent warning rather than disappearing.**

## Canonical launch journeys

### Public discovery

A customer opens the ungated, VIGA-branded Farm Friend web app — including embedded on VIGA's
site. The default view centers on **actionable purchase locations**; other farm layers stay
prominent and easy to view so farms without stands don't feel omitted. The customer sees the same
listing and inventory facts available through SMS. With permission, transient browser geolocation
may show approximate straight-line proximity. Destination-only Google Maps links may be offered;
the mapping application resolves the customer's origin and route. When a location hosts other
sellers, active owner-confirmed names appear as plain-text **Also selling here** metadata, separate
from the aggregate current-inventory list; no item is attributed to a seller. Public discovery is
model-free.

### Customer inquiry (SMS)

Customers ask free-form questions and get grounded answers. The intent space is **open-ended and
often ambiguous** — for "where can I get bok choy and green beans?" the customer might want *one
stand with both*, *different stands covering the set*, *any* stands with either item, the
*freshest*, etc. The design must not privilege one reading, and must not reduce the space to a
fixed catalog of supported request shapes: the model interprets the request, code runs general
retrieval, the model selects or orders identifiers from the retrieved facts, and code renders the
authoritative factual answer and recency. Ambiguous → ask.

A useful answer may be concise rather than conversational:

```text
Provo Farms: potatoes, bok choy (updated yesterday)
Plum Forest: bok choy, strawberry preserves (updated 3 days ago)
```

Farm Friend may also present deterministically derived comparison facts:

```text
Paxton Farms lists both items and updated its stock today;
Plum Forest lists bok choy and updated its stock 3 days ago.
```

The model does not author factual answer text, and Farm Friend does not attempt to verify
unrestricted natural-language prose claim by claim. Empty retrieval → a code-rendered honest "no
current listing," never a guess. *(Example phrasings are illustrations of the intent space, never a
spec — see CLAUDE.md "Examples are illustrations.")*

A customer-initiated inquiry permits its relevant direct response but does not enroll the customer
in later proactive notifications. Launch sends no passive customer follow-up and stores no
follow-up interest.

Launch does not resolve an arbitrary address or current location supplied by SMS. An
origin-dependent request receives a code-rendered limitation and public-map link.

### Farmer onboarding and activation

**The invitation is the approval.** A VIGA coordinator decides who joins and which farm they run at
the moment they mint a one-use onboarding link and send it to that person — so a farmer who accepts
the SMS agreement and redeems that link from their phone **is onboarded**, with no second VIGA step.
They complete simple web onboarding, verify control of their SMS number by redeeming from it, and
provide listing details and communication preferences. From then on the farmer is the authority for
inventory publication. The process must be at least as easy as the current ad-hoc Google Form.

**VIGA still decides the cases the invitation cannot.** A request that names no farm, or arrives
from someone never invited, carries no decision to inherit and waits for a coordinator. Farmer
listing content is published as the farmer enters it and corrected by VIGA afterwards rather than
gated before — max's call: an unreviewed typo is cheaper than a farmer blocked on a queue.

### Farmer inventory update

Farm Friend requests an update at the farmer's preferred cadence, or the farmer initiates one. The
farmer describes stock naturally by SMS or web; the model interprets it and proposes a structured
update; **the farmer explicitly confirms**; deterministic code publishes the confirmed revision.
Farmers can also update communication frequency by SMS, and use the web for profile, preference,
and broader listing changes.

**No inventory update is published without farmer confirmation.**

### Customer stock-out report

A customer privately reports from a web/QR surface whose sales location is bound by code. The
report **does not affect the map, answers, or ranking**. Code resolves the authorized farmer from
that location and may ask them to send current inventory. The reply follows the ordinary structured
inventory proposal and `YES`/`NO` confirmation flow; there is no separate `OUT`/`IGNORE` stock-out
action. Only the farmer's confirmed inventory revision can change published inventory. A free-text
SMS may direct the customer to the reporting surface but cannot select a location or queue a farmer
alert.

### Recipe requests

Phase 1 does not generate meal ideas, recipes, preparation instructions, food-safety guidance, or
external recipe links. A recipe request may still receive code-rendered authoritative availability
and recency for named ingredients, followed by a code-rendered statement that launch does not
provide recipes or food-safety guidance.

## Actors

- **Farmer** — owns published listings and inventory (SMS daily driver; web entry point).
- **Customer** — discovers via the map, asks natural-language questions by SMS, and reports
  stock-outs. Anonymous public lookup, no signup. Supplies questions and private reports,
  **never authoritative inventory**.
- **VIGA administrator** — decides who participates, by inviting them; handles the requests no
  invitation covers, plus exceptions, flags, and anything the system cannot safely handle, and
  corrects farmer listing content after the fact. **One administrator level at launch.** Routine
  inventory maintenance is *not* a VIGA responsibility, and neither is approving an invited farmer
  a second time.

## Privacy posture

Farm Friend may retain selected lightweight facts (foods requested, preferred stands). It must not
feel as though it knows the customer's identity in depth. Raw message context is short-lived;
precise durable home addresses are not part of the customer profile; raw phone numbers and private
information are tightly contained; only selected preference and safety records survive raw-context
expiration. Public farm listings expose stand addresses and farmer-selected web or social links —
**direct farmer phone numbers and email addresses are not public**. A farmer may optionally publish
a photo or short biography. A farm without a public stand chooses an exact, approximate, or hidden
map location. A browser origin used for proximity is transient and is not stored, logged, put in
model context, or retained as a preference.

## Launch scope

The full Phase 1 launch is publicly available to all participating farmers and customers for VIGA's
Eat Vashon Week beginning **August 8, 2026**.

**In:** public embedded web map and listing experience; natural-language customer inquiry by SMS;
farmer onboarding by invitation; farmer inventory updates by SMS and web; proactive farmer
prompts and preference management; explicit farmer confirmation before publication; private
customer stock-out reporting; optional browser-origin approximate proximity and destination routing
links; one launch operational SMS program, universal STOP, JOIN, START, HELP, and safety escalation;
minimal single-level VIGA administration; read-only payment methods and VIGA Farm Bucks acceptance
or eligibility facts.

**Explicit non-goals:** native mobile applications; gleaning or volunteer coordination; VIGA Farm
Bucks claim, redemption, or accounting transactions; reservations, ordering, or payment; direct
customer-to-farmer contact; speculative support for multiple organizations.

Gleaning, volunteer coordination, and VIGA Farm Bucks transactions are **plausible future
programs**. Each would require separate enrollment, and universal STOP applies across all Farm
Friend messaging. The architecture should leave clean room for them **without building their
tables, states, packages, or UI now**.

Farm Friend is built for VIGA. Similar organizations may benefit later, but launch is a single VIGA
operation — **do not add speculative tenancy machinery**.

## Relationship to the existing map

The current VIGA page is <https://www.vigavashon.org/farm-stand-map>. It embeds a Google My Map of
free-form, largely unfilterable text.

This is a **greenfield build with no production-data compatibility or non-destructive migration
requirement**. Existing content is **reference input, not a schema contract** — initial listing
data is *seeded*, not migrated under a provenance model.

Reference legend from the VIGA map data: blue = stands open seasonally; green = stands open
year-round; red flower = flower-only stands that cannot accept VIGA Bucks; red = farm with no farm
stand; purple = VIGA Farmers Market. Farm Friend's public map reuses that visual index from
structured location, season, payment, and approved-offering facts, and exposes sanitized source
listing text with farmer-selected web/social links and details such as hours and stocking cadence.
**The VIGA Farmers Market is a distinct destination type**, not merely another farm-stand color.

## Observable success

- A substantially higher percentage of published inventory is current.
- Farmers regularly respond to prompts and can update without VIGA intervention.
- VIGA performs zero or minimal routine oversight.
- Hundreds of unique customers use Farm Friend each month.
- Web and SMS answers agree because they read the same published data.
- Recency warnings are visible and honest.
- Customer reports never alter inventory without farmer confirmation.
- Consent, privacy, authority, and delivery invariants survive hostile model behavior.

## Product decisions since settled

These were open at the clean-room reset and are now decided. Recorded here because the decision, not
just the code, is the product answer:

- **Raw-message retention: 30 days.** A body is written with an expiry that far outlives any
  conversation, and a scheduled purge clears it — see DATA_ARCHITECTURE §privacy & retention. A
  thread under open safety review is exempt only until the flag is disposed of.
- **Freshness threshold: 48 hours.** Past it a listing is shown with a stale warning. It never
  disappears — that is the honor-system reality above, not a tuning knob.
- **Inventory proposals: patch language in, complete snapshot out.** Farmers speak in edits; code
  applies them to the current snapshot and the farmer confirms the *complete* result, so every
  confirmation publishes one immutable revision (ARCHITECTURE §confirmation).
- **Admin sign-in: one fixed VIGA account and password.** The database admits only
  `board@vigavashon.org`; the web service verifies its Argon2id password and re-reads durable
  authority before issuing a hashed 12-hour session. Every refusal is identical, and durable
  client plus account-wide budgets limit guessing.
- **Model provider: one attested vendor behind the seam**, approved through the provider privacy
  gate rather than chosen by preference (AI_ARCHITECTURE §provider privacy gate).
- **Seed geocoding: no provider at all.** Coordinates are validated seed input; an unresolved
  location becomes an operator task and never a fabricated coordinate.
- **Onboarding address lookup: a draft the farmer confirms** (max, 2026-08-05; narrows the line
  above for **farm stand onboarding only**). Typing an address offers a *suggested* pin; the
  farmer confirms it or taps the map to move it, and only the confirmed coordinate is written. A
  result outside the island bounds is refused rather than shown, and every failure — no result,
  no key, a provider error — falls back to the farmer tapping the map, which is how the form
  worked before. The lookup can save a farmer work; it can never decide where a stand is, because
  a Vashon stand is often at the road rather than at the mailing address and only the farmer knows
  that. Still no `MapProvider` seam, no mapping package, and one approved call site
  (ARCHITECTURE §provider seams).
- **10DLC campaign alignment: verified against the live console.** The registered keyword set,
  universal STOP, and the one operational program agree with the parser, and the transcript of
  console state is what the tests pin.

## Unresolved launch decisions

Recorded, not resolved; none changes the target architecture:

- exact **farmer** sign-in and account experience (admin sign-in is settled above);
- proactive farmer-prompt timing and rate caps — a farmer's preferred cadence is a stated product
  promise, and the frequency limit that enforces it belongs in code at the dispatch boundary;
- initial listing-data entry process for stands whose reference input is incomplete;
- image provider, if farmer photos ship at launch.
