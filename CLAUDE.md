# Farm Friend

Farm Friend keeps Vashon Island Growers Association (VIGA) farm-stand information **current with
little or no routine VIGA data management**. VIGA's embedded Google My Map is the island's only
guide to what farm stands have, it carries free-form largely unfilterable text, and it runs stale
because a volunteer hand-enters farmer-submitted forms. Farm Friend lets farmers own and update
their own listings — mostly by **SMS** — so people can discover what they can buy locally now, and
lets customers privately flag a likely stock-out to the farmer. Nearly all stands are **unattended,
honor-system** stands with stable staples but variable stock, so the system shows *when* inventory
was last confirmed rather than pretending it is certain. Stale information stays visible with a
prominent warning rather than disappearing.

## Three pictures to hold while you work

**A coordinator at a desk.** One trustworthy customer-service agent serving VIGA and the community.
On the desk are **files** (source-of-truth data) and **ways to answer** (the map, SMS replies, its
own **inference**). It answers *from the files* and says when they're old; its inference *reads and
drafts* but never rewrites the official files on a hunch — the farmer or VIGA confirms; it has
professional boundaries (a customer's word doesn't change a farmer's listing — it passes the message
along); and when unsure it asks or hands off rather than guessing. When a design question is
unclear, ask *"what would a good coordinator at a desk do?"*

**A zen office, not a bureaucracy.** A clean walnut desk — a few folders stacked neatly, color-coded
labels, like things grouped — *not* a harried clerk buried in loose paper. **Simplicity and elegance
are architectural requirements**, not aesthetics: few concepts, each load-bearing; one general
mechanism where two bespoke ones would creep in; a system a newcomer can hold in their head. Binding
form: [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) §the zen desk.

**An LLM-brain in a harness.** The brain reads, drafts, and infers — and it is **swappable by
design**, so it is never *vouched for*, only *measured* (evals) and *contained* (the harness:
deterministic routing, confirmation gates, retrieval, the safety boundary — all code). The brain is
trusted for **quality**, never for **authority**. Test every decision against the harness: *"if the
brain were swapped for a weaker, or hostile, one tomorrow, which properties survive?"* Everything
that must survive lives in the harness. Full contract:
[docs/AI_ARCHITECTURE.md](docs/AI_ARCHITECTURE.md) §the trust contract.

## Golden rules

The architecture's fatal-failure defenses. Each is what a good coordinator would do; violating one
reintroduces a failure mode the architecture exists to prevent. The detail behind each lives in the
doc that owns it.

1. **The farmer owns published state.** Nothing a customer does mutates the map, answers, or ranking.
   A customer stock-out report is a *separate private signal* that only prompts the farmer.
2. **Deterministic parsing before any model call.** Compliance and confirmation tokens are handled by
   code first. `STOP` always unsubscribes **globally** and can never be reinterpreted by conversation
   state. Confirmation tokens are **context- and version-bound, never global**, commit **exactly
   once**, and **expire** — one open inventory confirmation per sender.
   → SMS_COMPLIANCE.md, ARCHITECTURE.md §routing
3. **The LLM proposes; code commits.** The model interprets, extracts, classifies, drafts where a
   seam permits, and selects public catalog names or typed options. It never writes durable
   state, chooses recipients, decides consent, supplies authoritative factual answer text, invents
   availability, or overrides a rule. → AI_ARCHITECTURE.md §the model-vs-code line
4. **Grounded answers only, classification before catalog matching.** After deterministic routing,
   one strict classifier sees the message alone and fixes the route and inquiry operation. Code then
   resolves any named stand; only inventory/payment builds a deduplicated public catalog for one
   bounded matcher call. Code validates every match, expands it to all supporting stands/evidence,
   orders, pages, and renders authoritative text with explicit recency. Neither call receives a stand
   association or identifier. → AI_ARCHITECTURE.md §retrieval
5. **Privacy at the data layer.** Phones normalized at ingress; raw E.164 in **exactly one column**,
   read only by the outbound send path; the **hash is the only lookup/log key**. Raw numbers are never
   logged, never enter model context, masked in admin. Raw message context is short-lived (flagged
   threads exempt while under review); flags/audit are retained. No rich personal profile.
   → DATA_ARCHITECTURE.md §privacy
6. **Safety is enforced by code, never by the system prompt.** A prompt can be jailbroken or
   prompt-injected, and we ingest untrusted public SMS — so anything that must not fail is a
   deterministic guarantee the model cannot reach around. Two barriers plus verification: a **static
   provenance barrier** (branded types, proving provenance not content), **runtime enforcement**
   (minimal projections, no repository capability in the adapter, code-rendered consequential output,
   the outbound guard), and a **verification suite** (evidence, *not* a third enforcement layer,
   requiring hostile models). Model prose may return only to the same actor; cross-actor messages are
   code-rendered from permitted typed facts. → AI_ARCHITECTURE.md §the safety boundary

**No business code hard-codes what the model can understand** — no farm names or food vocabulary in
behavioral branches, no produce taxonomy as policy. Farms, foods, and listings are **data**.

## Working a task

For agents starting cold. Work is chunked in the `/pm` backlog and built across sessions;
`/session-wrap` carries continuity.

1. **Orient.** This file + [docs/CURRENT_STATE.md](docs/CURRENT_STATE.md) (what's live vs. skeleton)
   + the area's architecture doc ([docs/README.md](docs/README.md) is the index). `/pm list`,
   `/pm show <ID>`. **Do not load the historical records** to orient.
2. **Claim.** `/pm status <ID> in progress`; branch off `main` (**never work on `main`**), named for
   the item (`f-011-…`).
3. **Read the discipline for what you're touching.** [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) —
   §before you ship has a checklist per area (routing, model seams, privacy, SMS, the public map).
4. **Test-first, then build.** The failing test before the behavior.
5. **Verify before done.** The suites for what you touched, + typecheck.
6. **Wrap.** Don't commit/push/deploy unless asked. Run **`/session-wrap`** before clearing context.

## The documents and what each one owns

**Each architecture doc is authoritative for its own domain.** No master document sits above them;
where two disagree, the one that *owns* the subject wins. **None carries build status** — that lives
only in [docs/CURRENT_STATE.md](docs/CURRENT_STATE.md).

**Read a contract doc as a requirement, not as evidence.** A doc sentence, a code comment, a test
name, and a green check are all *claims*. Check the code and the test, and sabotage the test to
confirm it can fail.

| Doc | Owns |
|---|---|
| [PRODUCT_BRIEF](docs/PRODUCT_BRIEF.md) | the *product* — north star, launch journeys, actors, honor-system reality, privacy posture, scope and non-goals |
| [ARCHITECTURE](docs/ARCHITECTURE.md) | the *system* — package layout + dependency direction, composition root, deterministic routing, workflow/transaction ownership, provider seams |
| [DATA_ARCHITECTURE](docs/DATA_ARCHITECTURE.md) | the *data* — scope discipline, the constraints the database enforces, privacy/retention, the model-run MAY-store list |
| [AI_ARCHITECTURE](docs/AI_ARCHITECTURE.md) | the *AI* — trust contract, semantic architecture, seam catalog, model-vs-code line, safety boundary + verification, evals |
| [SMS_COMPLIANCE](docs/SMS_COMPLIANCE.md) | keywords, consent, required behavior, the FLAG safety rail |
| [DEVELOPMENT](docs/DEVELOPMENT.md) | *how code gets written* — the zen desk, the suites, per-area pre-ship checklists, the do-not list |
| [CURRENT_STATE](docs/CURRENT_STATE.md) | **build status** — what's verified, deployed, and open. The only place it lives |
| [GO_LIVE_GUIDE](docs/GO_LIVE_GUIDE.md) | **work order to launch** — `GL-###` items, priority bands, the verification ladder. Controls order, not contract; its findings are leads to reconfirm, not a spec. Open unless it carries a `**Completed:**` line |
| [RUNBOOK](docs/RUNBOOK.md) | operate — local dev, env, migrations, seeding, evals, deploy, Telnyx webhook requirements, credential rotation |
| [ADMIN_OPERATIONS](docs/ADMIN_OPERATIONS.md) | the VIGA operator guide |

**Three reference catalogues** sit under the docs above. They are **look-up, never cold-start
reading**: [SURFACES](docs/SURFACES.md) (every runtime surface and its bounds, under ARCHITECTURE),
[DATA_RECORDS](docs/DATA_RECORDS.md) (every durable record, under DATA_ARCHITECTURE), and
[EXTENDING](docs/EXTENDING.md) (recipes for adding a program, surface, seam, or provider, under
RUNBOOK).

**Historical records — do NOT load these to orient.** Dated, frozen, not authority:
everything in [docs/archive/](docs/archive/) (the July 2026 clean-room reset and its adversarial
review, the completed GCP migration, the F-059 ingestion audit) and
[SESSION_LOG.md](docs/SESSION_LOG.md) + its [archive](docs/SESSION_LOG_ARCHIVE.md). Open one
deliberately, to answer "why was this decided" or dig into a past defect — never as startup context.

## Commands

- `npm test` · **`npm run test:integration:local`** · `npm run typecheck` · `npm run lint` · `npm run evals`
  (the plain `test:integration` needs `PUBLIC_BASE_URL` exported as well as `DATABASE_URL`; the
  `:local` form is the one to run)
- `npm run evals:live` — the REAL model through the real seams. Required for any change to a seam's
  projection, schema, or output contract.
- Migrations / seeding / offerings / deploy: docs/RUNBOOK.md (deploy only when asked).

Suite details and when each is required: [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) §the suites.

## Skills

- **`pm`** — backlog in `~/pm/farm-friend/`. Never hand-edit; use the skill. Historical IDs
  `F-001`–`F-010` are retired and must not be reused.
- **`session-wrap`** — end-of-session housekeeping (verify green, sync docs/CURRENT_STATE.md + PM).
- **`verify` / `run`** — exercise a change in the running app / SMS simulator.

## Status digest

Read **[docs/CURRENT_STATE.md](docs/CURRENT_STATE.md)** before touching the repository. It is the
only status record: deployed revision and migration count, locally verified work, known gaps, and
owed live checks all live there. Do not duplicate those facts in this file.
