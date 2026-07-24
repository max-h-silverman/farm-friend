# Farm Friend Clean-Room Product and Architecture Handoff

**Reference date:** July 24, 2026  
**Repository:** `/Users/max/farm-friend`  
**Audited repository baseline:** clean `main` at `2cb39e4`, including PR #7  
**PM reset commit:** `da7e223` in `/Users/max/pm`  
**Current phase:** Phase 3 audit proposal presented; awaiting approval to begin Phase 4 finding review

> This is the handoff and audit reference for the clean-room design session. The existing
> architecture documents remain useful evidence of the previous design, but they are not design
> authority where they conflict with this document or with decisions recorded here.

## How to resume in a fresh session

1. Read this document before the existing Farm Friend architecture documents.
2. Do not repeat the product discovery or clean-room derivation unless the user changes a settled
   product decision.
3. Confirm whether the user wants to enter Phase 4.
4. In Phase 4, present exactly one finding at a time:
   - cite concrete evidence;
   - explain the product or safety consequence;
   - recommend the smallest coherent correction;
   - state exactly what is kept, changed, consolidated, or deleted;
   - end with exactly one decision or agreement question;
   - wait for explicit agreement;
   - only after agreement, use the PM workflow to create or update the smallest necessary item;
   - synchronize the PM backlog and item file and commit the PM change before continuing.
5. Do not modify application code, schemas, architecture documents, branches, or PRs unless the
   user separately authorizes implementation.

The next conversational step is:

> Ask whether to begin reviewing the audit findings one at a time.

No audit findings have yet been filed in PM.

## Session interaction rules

- Ask exactly one question per response.
- Ask only questions whose answers materially clarify the product or change the architecture.
- Restate each resulting decision in one or two sentences so the user can correct it.
- Do not batch decisions or findings.
- At each phase transition, summarize what is settled and wait for explicit approval.
- During findings review, present exactly one finding at a time.
- Favor deletion and consolidation over preserving speculative or already-documented machinery.
- Treat code comments, test names, package names, green checks, abstractions, docs, and PM state as
  claims rather than proof.

## Settled product contract

### 1. Purpose

Farm Friend exists to keep VIGA's farm-stand information current with little or no routine VIGA
data management. It helps people discover what they can buy locally now, while giving farmers an
easy way to own and update their published information.

Six months after launch:

- VIGA board members and volunteers are largely relieved of manual map maintenance.
- A much higher percentage of farm-stand inventory is current.
- Farmers respond to proactive SMS prompts.
- Hundreds of unique customers use Farm Friend monthly.
- People have learned to text Farm Friend with natural requests such as foods, meal ideas, distance,
  or preferred stands.
- The public web experience is substantially more useful than the existing embedded Google My Map.

### 2. Primary actors and outcomes

#### Customers

Customers can use the public web map or SMS to get the same underlying information. They can ask
natural-language questions, receive useful matches and directions, understand recency, and get
lightweight recipe assistance.

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

Answers must communicate uncertainty and recency honestly. Stale information remains visible with a
prominent warning rather than disappearing.

#### Farmers

Farmers receive proactive SMS prompts and can update inventory and communication frequency by SMS.
They can use a web form instead when they prefer it. The web product also supports profile,
preference, and broader listing changes.

The process must be at least as easy as the current ad-hoc Google Form.

#### VIGA administrators

VIGA initially verifies and approves participating farms. A minimal dashboard supports exceptions,
flags, approval, and requests the system cannot safely handle. There is one administrator level at
launch.

Routine inventory maintenance is not a VIGA responsibility.

### 3. Canonical launch journeys

#### Public discovery

1. A customer opens the ungated VIGA-branded Farm Friend web app, including when embedded on VIGA's
   website.
2. The default view centers on actionable purchase locations.
3. Other farm layers remain prominent and easy to view so farms without stands do not feel omitted.
4. The customer can inspect the same listing and inventory facts available through SMS.
5. Directions or a Google Maps routing link may be offered where useful.

#### SMS inquiry

1. A customer texts a free-form need or question.
2. The model interprets the meaning of the request.
3. Deterministic retrieval supplies permitted farm, location, inventory, recency, and routing facts.
4. The model composes a relevant response.
5. Code validates factual claims against retrieved evidence and controls delivery.

The system may disclose a narrow, short-lived passive follow-up:

```text
I'll let you know if any other stands report potatoes in stock today. MUTE to skip.
```

It must not spam people, repeatedly send low-value messages, or retain a rich personal profile.

#### Farmer onboarding and activation

1. A farmer completes simple web onboarding.
2. The farmer verifies control of the SMS number.
3. The farmer provides listing details and communication preferences.
4. VIGA approves the farm for publication.
5. The farmer becomes the authority for subsequent inventory publication.

#### Farmer inventory update

1. Farm Friend requests an update at the farmer's preferred cadence, or the farmer initiates one.
2. The farmer describes stock naturally by SMS or web.
3. The model interprets the message and proposes a structured update.
4. The farmer explicitly confirms it.
5. Deterministic code publishes the confirmed revision.

No inventory update is published without farmer confirmation.

#### Customer stock-out report

1. A customer privately reports that a stand appears to be out of an item.
2. The report does not affect the map, answers, or ranking.
3. Farm Friend may ask the authorized farmer to confirm an update.
4. Only the farmer's explicit confirmation can change published inventory.

#### Recipe assistance

Farm Friend can suggest what someone might make from currently available ingredients and may link to
retrieved online recipes. It does not create an authoritative full recipe, transact, reserve food,
or make commitments on a farmer's behalf.

### 4. Operating model and ownership

The guiding metaphor is a helpful VIGA coordinator at a well-organized desk with indexed cabinets of
current, historical, and operational information.

- The language model is the coordinator's interpretive and compositional brain.
- The application is the harness, records, communication channels, and authority system.
- Farmers own their published listings and inventory.
- VIGA controls initial participation approval and exceptional oversight.
- Customers supply questions and private reports, never authoritative inventory.
- The public web app and SMS read from the same published truth.

The coordinator may connect recent events when useful, such as noticing that customers recently asked
for potatoes after a farmer confirms potatoes are available. Deterministic code still decides who may
receive a message, whether consent permits it, whether it exceeds frequency limits, and whether the
follow-up interest has expired.

### 5. Trust and authority boundaries

The model may:

- interpret language;
- infer search intent;
- propose inventory changes;
- rank relevant retrieved options;
- draft replies;
- compose recipe ideas;
- suggest escalation.

Deterministic code owns:

- identity and authority;
- consent;
- universal STOP and scoped MUTE;
- recipient selection;
- commitments;
- transactions;
- durable writes;
- publication;
- idempotency;
- retention;
- provider operations;
- verification that factual claims are supported by retrieved evidence.

The system must remain safe when the model is weak, mistaken, manipulated, or hostile.

No business code should hard-code things the model can understand. In particular:

- no farm names in behavioral branches;
- no food vocabulary in behavioral branches;
- no produce taxonomy encoded as application policy;
- no logic such as `if vegetable, then ...`;
- no fixed semantic strategy catalog that prevents the model from understanding an ordinary request.

Actual farms, foods, and listing details are data. The model handles meaning; code controls
consequences. Fixed compliance and authority controls such as STOP, START, HELP, authentication, and
confirmation remain deterministic.

### 6. Privacy

Farm Friend may retain selected lightweight facts such as foods requested or preferred stands. It
must not feel as though it knows the customer's identity in depth.

- Raw message context is short-lived.
- Precise durable home addresses are not part of the customer profile.
- Raw phone numbers and private information are tightly contained.
- Only selected preference and safety records survive raw-context expiration.
- Public farm listings expose stand addresses and farmer-selected web or social links.
- Direct farmer phone numbers and email addresses are not public.
- A farmer may optionally publish a photo or short biography.
- A farm without a public stand chooses an exact, approximate, or hidden map location.

### 7. Launch scope

The full Phase 1 launch is publicly available to all participating farmers and customers for VIGA's
Eat Vashon Week beginning August 8, 2026.

Launch includes:

- public embedded web map and listing experience;
- natural-language customer inquiry by SMS;
- farmer onboarding and VIGA approval;
- farmer inventory updates by SMS and web;
- proactive farmer prompts and preference management;
- explicit farmer confirmation before publication;
- private customer stock-out reporting;
- concise recipe suggestions and optional external recipe links;
- directions;
- universal STOP, scoped MUTE, JOIN, START, HELP, and safety escalation;
- minimal single-level VIGA administration;
- read-only payment methods and VIGA Farm Bucks acceptance or eligibility facts.

Explicit non-goals:

- native mobile applications;
- gleaning or volunteer coordination;
- VIGA Farm Bucks claim, redemption, or accounting transactions;
- reservations, ordering, or payment;
- direct customer-to-farmer contact;
- speculative support for multiple organizations.

Gleaning, volunteer coordination, and VIGA Farm Bucks transactions are plausible future Farm Friend
programs. Each future program requires separate enrollment. Universal STOP applies across all Farm
Friend messaging. The architecture should leave clean room for these programs without building their
tables, states, packages, or UI now.

Farm Friend is built for VIGA. Similar organizations may benefit later, but launch is a single VIGA
operation. Do not add speculative tenancy machinery.

### 8. Existing map relationship

The current VIGA page is:

<https://www.vigavashon.org/farm-stand-map>

It embeds a Google My Map containing free-form, largely unfilterable text. This is a greenfield build
with no production-data compatibility or non-destructive migration requirement. Existing content is
reference input, not a schema contract.

Legacy legend reference:

- Blue icon: farm stands open seasonally.
- Green icon: farms with farm stands open year-round.
- Red flower icon: flower-only farm stands that cannot accept VIGA Bucks.
- Red icon: farm with no farm stand.
- Purple icon: VIGA Farmers Market.

The underlying facts remain useful. The new product does not need to preserve the legacy icon system.
The VIGA Farmers Market is a distinct destination type rather than merely another farm-stand color.

### 9. Observable success

- A substantially higher percentage of published inventory is current.
- Farmers regularly respond to prompts and can update without VIGA intervention.
- VIGA performs zero or minimal routine oversight.
- Hundreds of unique customers use Farm Friend each month.
- Web and SMS answers agree because they use the same published data.
- Recency warnings are visible and honest.
- Customer reports never alter inventory without farmer confirmation.
- Consent, privacy, authority, and delivery invariants survive hostile model behavior.

## Approved clean-room architecture baseline

### Architectural verdict

Use one web-based system with four focused packages:

```text
apps/
  web/       UI, HTTP handlers, scheduled jobs, and the single composition root

packages/
  core/      Authoritative workflows, product rules, and narrow ports
  db/        Schema, migrations, repositories, and transaction handling
  sms/       Telnyx adapter, webhook verification, and outbound safeguards
  ai/        Model adapters, safe context assembly, and grounded-output validation

evals/       Model and adversarial evaluations
```

Dependency direction:

```text
web -> core
web -> db, sms, ai
db, sms, ai -> core
core -> no other package
```

One composition root in `apps/web` constructs the database, model, SMS, mapping, and other adapters
and injects them into authoritative workflows.

Runtime surfaces:

- public and embeddable web app;
- farmer account and forms;
- minimal admin dashboard;
- Telnyx webhook;
- scheduled prompting, delivery, retry, and retention jobs.

There is no launch justification for separate `config` or `contracts` packages, an Expo application,
a permanent map package, gleaning artifacts, or tenancy machinery.

### Semantic architecture

The model produces flexible interpretations and proposals from natural language. It is not limited to
hard-coded foods, farm names, semantic categories, or a brittle catalog of request strategies.

Code provides:

- an allowed task-specific context;
- general retrieval and geographic operations;
- authoritative records;
- constrained action options;
- evidence identifiers for factual claims;
- validation before any consequence.

The model may propose a search or ranking interpretation and compose the answer. Code executes only
permitted operations and rejects claims that cannot be traced to retrieved records.

### Minimum durable data

- farms and sales locations;
- farmer contacts and authorization;
- VIGA approval;
- structured public listing facts;
- inventory revisions and inventory entries;
- customer stock-out reports;
- message records with limited retention;
- consent events and universal STOP;
- pending farmer confirmations;
- narrow expiring follow-up interests and scoped MUTE;
- flags and admin dispositions;
- transactional outbox;
- minimal audit and model-run evidence.

Do not create tenant, gleaning, volunteer, mobile, or legacy-migration state at launch.

## Phase 3 repository audit

### Overall verdict

The repository is an over-specified foundation with several documented safety claims that executable
code does not enforce. The correct path is destructive consolidation into the approved baseline, not
completion of every existing abstraction.

At the audited baseline:

- unit tests pass 46 of 46;
- typecheck and lint pass;
- critical evals pass 3 of 3;
- advisory evals pass 2 of 2;
- adversarial evals pass 4 of 4;
- three Postgres integration tests are skipped without `DATABASE_URL`.

These checks primarily prove isolated helpers and structural claims, not launch workflows.

### Concrete evidence

- `packages/core/package.json` depends on `ai`, `config`, `contracts`, `db`, and `sms`, reversing the
  claimed dependency direction.
- `apps/web/app/api/sms/webhook/route.ts` parses JSON and echoes a command without webhook signature
  verification, persistence, idempotency, consent application, or dispatch.
- `apps/web/lib/auth.ts` validates an email token but returns an empty role list and a synthetic
  `viga` tenant, with no durable session or database authorization.
- Live AI and Telnyx adapter methods throw "not implemented."
- There is no single composition root.
- There are no committed database migrations.
- The schema contains tenancy, gleaning, migration provenance, roles, and future states but lacks
  several constraints needed to enforce the claimed invariants.
- The stock-out test proves only that a returned object lacks an `inventory` property. It does not
  prove that the end-to-end report workflow cannot change published inventory.
- The generic commitment machine permits affirmative tokens such as `OUT` across unrelated pending
  commitment kinds and has no transactional caller.
- The deterministic command parser and registered 10DLC copy disagree about supported command forms.
- The map stub invents coordinates for arbitrary addresses.
- AI context assembly rejects some detected phone-shaped text but does not implement the broader
  minimization and stripping guarantees claimed by the architecture docs.
- Output validation checks structure but does not prove factual grounding.
- The grounding eval uses a cooperative canned model rather than attempting unsupported invention.
- Adversarial tests exercise helpers rather than an end-to-end hostile-model boundary.

The current documentation describes these intended guarantees as settled and operational:

- `docs/ARCHITECTURE.md`
- `docs/DATA_ARCHITECTURE.md`
- `docs/AI_ARCHITECTURE.md`
- `docs/RUNBOOK.md`
- `docs/ADMIN_OPERATIONS.md`
- `CLAUDE.md`

They are audit evidence, not current design authority.

### Provider requirements that must be enforced

Telnyx's receiving guidance requires verification of webhook signatures and describes prompt
acknowledgement, retries, duplicate events, and possible out-of-order delivery:

- <https://developers.telnyx.com/docs/messaging/messages/receiving-webhooks>
- <https://developers.telnyx.com/docs/messaging/messages/receive-message>

Telnyx's campaign and keyword requirements center on opt-in, opt-out, help, and their confirmation
behavior:

- <https://support.telnyx.com/en/articles/10645338-10dlc-keywords-and-confirmation-messages>
- <https://support.telnyx.com/en/articles/9940291-10dlc-campaign-compliance-requirements>

FLAG is a Farm Friend product safety feature. It should not be represented as a carrier-mandated
keyword.

## Pointed refactor proposal

### Current-to-target map

| Current area | Target treatment |
|---|---|
| `apps/web` | Replace placeholders with the public product, farmer account, admin dashboard, operational endpoints, jobs, and composition root |
| `apps/mobile` | Delete |
| `packages/config` | Fold runtime configuration into the web composition root |
| `packages/contracts` | Move workflow types into `core`; keep HTTP validation beside handlers |
| `packages/core` | Remove infrastructure dependencies and future-program machinery; make it the owner of authoritative use cases |
| `packages/db` | Replace speculative schema with launch schema, constraints, migrations, repositories, and transactions |
| `packages/sms` | Keep useful segmentation and redaction concepts; implement secure Telnyx ingress, delivery, and consent enforcement |
| `packages/ai` | Replace generic context passing with task-specific safe inputs and evidence-backed output validation |
| map abstractions | Remove the permanent provider seam; retain a one-time seed/import utility and this legacy reference |
| documentation | Rewrite intended safety as requirements until executable proof exists |
| tests and evals | Replace shape checks and cooperative stubs with workflow, transaction, provider, and hostile-model tests |

### Exact deletion and consolidation direction

Delete or remove:

- `apps/mobile`;
- `packages/config`;
- `packages/contracts`;
- launch tenancy;
- gleaning tables and `gleaning_signup` commitment machinery;
- legacy-map migration provenance and claim states;
- the coordinate-inventing map stub;
- multi-level administrator and staff roles;
- generic abstractions with only one real consumer;
- throwing provider implementations presented as operational;
- documentation that describes unimplemented guarantees as facts.

Keep and refine:

- SMS segment calculation;
- phone normalization and hashing;
- time abstraction where time controls product behavior;
- schema-based model-output validation;
- the distinction between model proposals and deterministic commitments;
- legacy map facts as reference input.

### Initial database migration

Create a clean launch migration containing only the minimum durable records described above.

Database constraints must enforce:

- unique provider-message processing;
- one currently published inventory revision per sales location;
- farmer authority over inventory publication;
- universal STOP before outbound delivery;
- outbox idempotency;
- bounded valid states and transitions;
- separation between private customer reports and published inventory.

### Workflow and transaction ownership

Every workflow has one authoritative core use case and one durable path.

| Workflow | Authoritative behavior |
|---|---|
| Initial map data | Validate and seed farms, locations, listing facts, and approval state; public and SMS views read the same records |
| Farmer onboarding | Verify the phone, associate the farm, capture preferences, and record VIGA approval separately |
| Inventory publishing | Store a proposed revision, obtain explicit confirmation, then atomically publish it and supersede the prior revision |
| Customer stock-out | Store a private report and optionally queue a farmer request; never alter public inventory |
| Farmer report response | Resolve the pending action and publish only with explicit farmer confirmation |
| Customer inquiry | Retrieve permitted current records, obtain model interpretation and composition, validate claims, and queue the reply |
| Passive follow-up | Store a disclosed, narrow, expiring interest and enforce MUTE, STOP, frequency, and recipient selection in code |
| STOP, START, JOIN, HELP, MUTE | Apply consent changes before other interpretation or outbound selection |
| FLAG | Store the concern and expose it to the single-level admin queue |
| Authentication | Issue and consume short-lived credentials once, with replay prevention and rate limiting |
| Provider delivery | Commit business state and an outbox entry together; send afterward with retry and deduplication |
| Retention | Delete expired raw context while preserving only required consent, safety, and audit records |

External SMS and model calls do not occur inside business database transactions. The transaction
commits the decision and outbox work; workers perform external operations and record their outcome.

### Required test and eval corrections

- Run migrations from an empty Postgres database in CI.
- Exercise complete use cases with real database constraints and transactions.
- Prove concurrent and duplicate farmer confirmations publish only once.
- Prove customer reports cannot change public availability or ranking.
- Prove STOP suppresses queued and future non-required messages.
- Test webhook signature, retry, duplicate, and out-of-order behavior.
- Test rollback and outbox recovery.
- Test farmer authorization and VIGA approval.
- Test authentication expiry, replay prevention, and rate limiting.
- Test retention and deletion of raw context.
- Prove raw phones and private context are absent from logs and model inputs.
- Use hostile models that invent farms, inventory, recency, directions, or commitments.
- Reject unsupported factual claims even when model output is structurally valid.
- Add real provider contract tests.
- Delete tenancy and gleaning tests.
- Replace returned-object shape tests with tests of published product state.

### Safe refactor order

1. Align the product configuration, documentation, and PM baseline with the approved product
   contract.
2. Delete deferred packages and correct dependency direction.
3. Establish the launch schema, initial migration, repositories, transactions, and outbox.
4. Build secure SMS ingress, deterministic command handling, consent, and reliable delivery.
5. Build farmer verification, onboarding, VIGA approval, and minimal admin.
6. Build the shared inventory proposal and confirmation workflow for web and SMS.
7. Build the public map and listing experience from the same source of truth.
8. Add grounded customer inquiry and recipe suggestions.
9. Add private stock-out reports, disclosed passive follow-ups, FLAG, and retention.
10. Complete provider, adversarial, operational, and launch-readiness testing.

## PM state

The previous PM backlog was inspected as audit evidence and then cleared with explicit user
authorization. The synchronized reset was committed in `/Users/max/pm`:

```text
da7e223 farm-friend: clear legacy backlog
```

No replacement findings have been filed. Historical item identifiers `F-001` through `F-010` should
not be reused; new approved findings should begin at `F-011`.

The Farm Friend PM product configuration remains stale and should be corrected as part of the first
agreed finding.

## Unresolved launch decisions

These do not change the target architecture and can be resolved when the associated finding reaches
them:

- exact farmer and admin sign-in experience;
- raw-message retention period;
- freshness warning thresholds;
- prompt and passive-follow-up timing and rate caps;
- initial listing-data entry process;
- final model, mapping, geocoding, image, and recipe-link providers;
- verification that the registered 10DLC campaign and public compliance pages match universal STOP,
  scoped MUTE, and separate future-program enrollment.

## Proposed finding-review sequence

This ordering is a guide, not prior approval of any finding:

1. Replace the stale declared product and architecture baseline.
2. Correct package boundaries, dependency direction, and composition ownership.
3. Replace the speculative schema with launch entities, migrations, and enforced constraints.
4. Establish one authoritative transaction and outbox path per workflow.
5. Rebuild SMS ingress, consent, provider delivery, idempotency, and recovery.
6. Establish farmer verification, authorization, onboarding, and VIGA approval.
7. Make inventory publication and the public map one farmer-controlled source of truth.
8. Establish the model-semantic and grounded-answer boundary.
9. Add private reports, passive follow-up, FLAG, administration, and retention.
10. Replace overstated tests and evals with launch-invariant proof.

Do not combine findings merely because they affect the same package. Combine only work that forms one
inseparable correction with one owner and one acceptance boundary.
