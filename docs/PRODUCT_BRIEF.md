# Farm Friend Product Brief

## North Star

Farm Friend helps Vashon use more local food and waste less of it by making farm stand inventory and Food Bank gleaning coordination easy through SMS, web, and native app channels.

The product must work for app-inclined users and app-resistant users at the same time. SMS is not a fallback; it is a first-class surface. The web and native app are not separate products; they are richer clients on the same coordination core.

## MVP Use Cases

### 1. Farm Stand Availability

Farmers publish what is currently available at their farm stand. Customers ask what is available now, where to find ingredients, what a specific stand has, or what they can cook with current availability.

Farm Friend replaces the existing VIGA farm map and becomes the source of truth for public farm stand details and current availability. Any old map or site presentation should eventually read from Farm Friend, not compete with it.

Input channels:

- Farmer SMS update.
- Farmer web/native inventory editor.
- Customer SMS query.
- Customer web/native browse and search.

MVP capabilities:

- Farmer profile and staff/admin-managed farmer onboarding.
- Inventory update with item names, optional quantity, optional unit, optional approximate quantity words such as `some` or `a lot`, optional price, and optional stand note.
- Confirmation before publishing SMS-submitted updates.
- Customer item search: "Who has kale today?"
- Farm lookup: "What does Farm Farm have right now?"
- Recipe help grounded in retrieved inventory plus general food knowledge.
- Public web/native inventory view.
- Freshness display based on `updated at` and farmer-configured update cadence. Do not hide older listings by default; show recency clearly so customers can decide whether to roll the dice.
- Support high-specificity customer needs such as "5 lbs of tomatoes" without introducing restaurant procurement workflow.

Not MVP unless explicitly pulled in:

- Payment.
- Farm stand credit ledger.
- Restaurant procurement workflow with purchase commitments.
- Guaranteed stock reservation.
- Delivery or pickup scheduling.

### 2. Gleaning Volunteer Coordination

VIGA staff create gleaning opportunities for Food Bank collection. Volunteers opt in to gleaning texts, reply to sign up, receive reminders, and can back out by text.

Input channels:

- VIGA staff SMS opportunity creation.
- VIGA staff web/native organizer console.
- Volunteer SMS signup and cancellation.
- Volunteer web/native signup and status view.

MVP capabilities:

- Staff creates an opportunity with crop, location, date, time, volunteer range, organizer, and Food Bank destination/context.
- SMS-created opportunities are parsed, echoed back, and require staff confirmation before broadcast.
- Volunteers self-opt in to gleaning.
- Broadcast reaches gleaning subscribers.
- `YES` signs up when an opportunity context is active; overflow signups can be waitlisted.
- `NO` or cancellation flow releases the spot when an opportunity context is active.
- Organizer receives live tally updates as volunteers join or drop.
- Volunteers and organizer receive morning reminders.
- Admin can inspect thread state and manually intervene.

Not MVP:

- For-profit farm volunteer flow.
- Skill matching.
- Training or certification tracking.
- Complex shift swapping.
- Food Bank staff direct notifications, dashboard access, or export reports.

## Actors

- VIGA board/staff: program owners, admins, gleaning organizers.
- Farmers: publish farm stand availability; later may use other programs.
- VIGA volunteers: receive and respond to Food Bank gleaning opportunities.
- Customers: private individuals, restaurants, other organizations, and anyone looking for local food. Restaurants and organizations are not a separate MVP workflow; their main difference is more specific inventory queries.
- Food Bank staff/volunteers: recipients/partners in gleaning operations; partner-facing visibility is explicitly deferred until after MVP.

## Product Principles

- One contact: users should be able to save `Farm Friend` as a single phone contact.
- Channel parity for core actions: if an action matters, it should be possible by SMS and by app unless a compliance or safety reason prevents it.
- Deterministic commitments: actions that affect people, public inventory, or reminders must be confirmed by code-controlled state, not model confidence.
- Grounded answers: customer answers may use general food knowledge, but farm availability claims must come only from retrieved inventory records with clear recency.
- Approximate reality is acceptable when labeled: `some`, `a lot`, and `limited` are useful if the system preserves uncertainty.
- Low administrative load: the system should remember prompts, reminders, freshness, and tallies.
- Public access: anonymous public lookup is allowed without signup and should not be artificially capped for normal use. Infrastructure and abuse controls may still protect the service.

## Open Product Questions

- What minimum farm profile data should VIGA require before public listing?
- What exact farmer onboarding/verification process should VIGA staff use: manual pre-seed, invite link, admin approval, or a combination?
- What public farm map fields must the VIGA website expose from Farm Friend at launch?
