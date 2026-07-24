# Farm Friend — Product Brief

The *product* source of truth: what Farm Friend is, who it serves, and the flows it must get
right. System/data/AI mechanics live in their own docs (see [README.md](README.md)).

> **Design authority.** The settled product contract is
> [CLEAN_ROOM_PRODUCT_ARCHITECTURE_HANDOFF.md](CLEAN_ROOM_PRODUCT_ARCHITECTURE_HANDOFF.md). This
> brief restates it for daily use; where the two disagree, the handoff wins.

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
- It may **connect recent events** when useful — noticing that customers recently asked for
  potatoes after a farmer confirms potatoes. Code still decides who may receive a message, whether
  consent permits it, whether it exceeds frequency limits, and whether the interest has expired.

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
listing and inventory facts available through SMS, with directions or a routing link where useful.

### Customer inquiry (SMS and web)

Customers ask free-form questions and get grounded answers. The intent space is **open-ended and
often ambiguous** — for "where can I get bok choy and green beans?" the customer might want *one
stand with both*, the *two closest* each with one, *any* stands covering the set, the *freshest*,
etc. The design must not privilege one reading, and must not reduce the space to a fixed catalog of
supported request shapes: the model interprets the request, code runs general retrieval and
geographic operations, and the model composes only over retrieved rows. Ambiguous → ask.

A useful answer may be concise rather than conversational:

```text
Provo Farms: potatoes, bok choy (updated yesterday)
Plum Forest: bok choy, strawberry preserves (updated 3 days ago)
```

Farm Friend may also explain relative usefulness:

```text
Plum Forest is more likely to have potatoes, but Paxton Farms is a few minutes farther
and updated its stock today.
```

Empty retrieval → an honest "no current listing," never a guess. *(Example phrasings are
illustrations of the intent space, never a spec — see CLAUDE.md "Examples are illustrations.")*

The system may disclose a **narrow, short-lived passive follow-up**:

```text
I'll let you know if any other stands report potatoes in stock today. MUTE to skip.
```

It must not spam people, repeatedly send low-value messages, or retain a rich personal profile.

### Farmer onboarding and activation

A farmer completes simple web onboarding, verifies control of their SMS number, provides listing
details and communication preferences, and **VIGA approves the farm for publication**. From then
on the farmer is the authority for inventory publication. The process must be at least as easy as
the current ad-hoc Google Form.

### Farmer inventory update

Farm Friend requests an update at the farmer's preferred cadence, or the farmer initiates one. The
farmer describes stock naturally by SMS or web; the model interprets it and proposes a structured
update; **the farmer explicitly confirms**; deterministic code publishes the confirmed revision.
Farmers can also update communication frequency by SMS, and use the web for profile, preference,
and broader listing changes.

**No inventory update is published without farmer confirmation.**

### Customer stock-out report

A customer privately reports that a stand appears to be out of an item. The report **does not
affect the map, answers, or ranking**. Farm Friend may ask the authorized farmer to confirm an
update. Only the farmer's explicit confirmation can change published inventory.

### Recipe assistance

Farm Friend can suggest what someone might make from currently available ingredients and may link
to retrieved online recipes. It does not create an authoritative full recipe, transact, reserve
food, or make commitments on a farmer's behalf.

## Actors

- **Farmer** — owns published listings and inventory (SMS daily driver; web entry point).
- **Customer** — discovers via the map, asks via the inquiry route, reports stock-outs. Anonymous
  public lookup, no signup. Supplies questions and private reports, **never authoritative
  inventory**.
- **VIGA administrator** — verifies and approves participating farms; handles exceptions, flags,
  and requests the system cannot safely handle. **One administrator level at launch.** Routine
  inventory maintenance is *not* a VIGA responsibility.

## Privacy posture

Farm Friend may retain selected lightweight facts (foods requested, preferred stands). It must not
feel as though it knows the customer's identity in depth. Raw message context is short-lived;
precise durable home addresses are not part of the customer profile; raw phone numbers and private
information are tightly contained; only selected preference and safety records survive raw-context
expiration. Public farm listings expose stand addresses and farmer-selected web or social links —
**direct farmer phone numbers and email addresses are not public**. A farmer may optionally publish
a photo or short biography. A farm without a public stand chooses an exact, approximate, or hidden
map location.

## Launch scope

The full Phase 1 launch is publicly available to all participating farmers and customers for VIGA's
Eat Vashon Week beginning **August 8, 2026**.

**In:** public embedded web map and listing experience; natural-language customer inquiry by SMS;
farmer onboarding and VIGA approval; farmer inventory updates by SMS and web; proactive farmer
prompts and preference management; explicit farmer confirmation before publication; private
customer stock-out reporting; concise recipe suggestions and optional external recipe links;
directions; universal STOP, scoped MUTE, JOIN, START, HELP, and safety escalation; minimal
single-level VIGA administration; read-only payment methods and VIGA Farm Bucks acceptance or
eligibility facts.

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

Legacy legend, retained as reference: blue = stands open seasonally; green = stands open
year-round; red flower = flower-only stands that cannot accept VIGA Bucks; red = farm with no farm
stand; purple = VIGA Farmers Market. The underlying facts remain useful; the new product does not
preserve the legacy icon system. **The VIGA Farmers Market is a distinct destination type**, not
merely another farm-stand color.

## Observable success

- A substantially higher percentage of published inventory is current.
- Farmers regularly respond to prompts and can update without VIGA intervention.
- VIGA performs zero or minimal routine oversight.
- Hundreds of unique customers use Farm Friend each month.
- Web and SMS answers agree because they read the same published data.
- Recency warnings are visible and honest.
- Customer reports never alter inventory without farmer confirmation.
- Consent, privacy, authority, and delivery invariants survive hostile model behavior.

## Unresolved launch decisions

Recorded, not resolved; none changes the target architecture:

- exact farmer and admin sign-in experience;
- raw-message retention period;
- freshness warning thresholds;
- prompt and passive-follow-up timing and rate caps;
- initial listing-data entry process;
- final model, mapping, geocoding, image, and recipe-link providers;
- verification that the registered 10DLC campaign and public compliance pages match universal
  STOP, scoped MUTE, and separate future-program enrollment.
