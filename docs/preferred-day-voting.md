# Design record: candidate-day voting (scheduling specificity spectrum)

**Status: IMPLEMENTED 2026-06-02 (branch `feature/coordinator-day-voting`).** Levels 2–3 built behind `DAY_VOTING_ENABLED` (default ON). Phases 0–4 landed; see "Implementation plan" below for the phase map and `docs/status.md` for the build log. Companion to `docs/agent-architecture-rethink.md` (window posts) and `docs/activity-model-redesign.md`.

> Originally scoped as a narrow "preferred-day" feature; reframed 2026-06-01 around a **specificity spectrum** the coordinator handles uniformly. The preferred-day case is now just level 2.

## The problem

A farmer's scheduling intent ranges from fully pinned to fully open:

1. **Specific day + time** — "Sat 9am." Fully determined.
2. **Set of days, with a soft preference** (day and/or time) — "Sun/Mon/Wed, Mon's best" or "those days, mornings ideally."
3. **Set of days, no preference** — "Sun, Mon, or Wed — any of them."
4. **No day constraint** — "whenever people are most available."

Today the agent only handles level 1 well. For 2–4 it takes the primary/first day and **silently drops the flexibility** — if that day doesn't fill, nothing widens, and the farmer's stated openness is lost.

The naive fixes are wrong:
- **Auto-widen matcher** (system pings the next day if the first stalls) — too much autonomous scheduling judgment.
- **Coordinator note** (record flexibility for a human) — punts to the admin.

## The intended model (product discussion 2026-06-01)

**The flexibility lives in the fan-out, and the volunteers' replies reveal the best day. The system coaches the *farmer* to the decision, keeping them in control. The whole spectrum reduces to one mechanism: vote among a finite set of candidate days, lock before a deadline.**

| Level | Farmer gives | Candidate days | Deadline ("by-date") |
|---|---|---|---|
| 1 | specific day + time | 1 → auto-locked (today's behavior) | n/a |
| 2 | set of days + soft preference | farmer's list | implicit = last listed day |
| 3 | set of days | farmer's list | implicit = last listed day |
| 4 | "whenever" + **required by-date** (≤ ~1 week out) | system enumerates: every day now → by-date | the explicit by-date |

The by-date is what makes level 4 tractable: "whenever" stops being open-ended and becomes "any day up to the deadline," so level 4 collapses into the same candidate-day vote as 2–3. The by-date is also the universal convergence backstop.

**By-date is only *required* of the farmer in level 4.** Levels 2–3 already name specific days, so the latest listed day is the implicit deadline — no extra clarify turn.

### Walkthrough (level 2/3)

1. Farmer: "need 2 to harvest tomatoes — Sun, Mon, or Wed work."
2. Fan-out: *"Three Cedars needs help with tomato harvest. Possible days: Sun 6/3, Mon 6/4, Wed 6/6. Reply with a day (e.g. SUN) to offer."* (Dates always shown; if a preference exists it's a soft hint, e.g. "Mon 6/4 (farmer's pick)".)
3. Volunteers reply SUN / MON / WED → **soft day-votes**, not confirmed seats.
4. The system reports the tally to the farmer and lets them decide or wait:
   *"So far 1 offered Sun. Reply YES to lock Sun, or ignore to wait for more."*
5. As votes accumulate (3 now want Mon), the nudge updates:
   *"3 now want Mon (your pick). Lock it in? Reply YES."*
6. Farmer replies YES → that day becomes the real shift; its voters become confirmed claims; off-day-only voters are notified and offered the locked day (see Lock-in).

### Deadline behavior (farmer never locks)

At the by-date, send **one final "last chance — lock it?" nudge**. If the farmer still doesn't reply, the **post expires and volunteers are released** (*"this one didn't get scheduled"*). **No autonomous lock** — the farmer always pulls the trigger. (Consistent with the project's "humans decide scheduling, system facilitates" philosophy.)

### Key properties

- **Votes are soft until the farmer locks a day.**
- **Nudge cadence is contextual to urgency**, not fixed — tightens as the by-date approaches (a weekend ask sent Friday is high-tempo; a week-out ask collects quietly). Farmer can pull the tally anytime with **STATUS** (already a hotkey).
- **"Ignore = keep waiting"** is first-class on every nudge.

## Governing architecture: dispatch writes state, the tick drives coordination

**(Added 2026-06-01 — this reframes the whole feature, and likely the system.)**

The event-driven reading — volunteer texts → dispatch reacts → fire a message — is only half of what a human coordinator does. A human also runs a **standing review**: periodically sweep every open request and ask *what changed, what's stalled, what converged, what needs a poke, what's run out of time* — absorbing mid-flight changes ("Three Cedars said actually Mon, not Sun") and working each opportunity forward across days. The intelligence is in the recurring board review, not only in per-text reactions.

So the responsibilities split:

- **Inbound dispatch = transcriber + acknowledger.** Its core job is to *finalize Firestore documents*: create / revise / delete opportunities and offers, record votes / claims / drops. It interprets what the user said and writes it down.
- **Tick coordinator = decision-maker.** It looks at the whole board of documents and decides *what to communicate and to whom* — fan-out, farmer nudges, day-vote convergence, lock-in cascades, chasing stalled requests, expiry.

### Don't let the tick artificially slow scheduling (event-triggered coordinator runs)

A pure "all proactive outreach waits for the next 30-min tick" design would add real latency: a farmer posts, enough people vote within an hour or two to fill a day, and the farmer shouldn't wait until the next scheduled sweep to hear it. A human coordinator watching the board would react the moment a day became fillable.

The resolution distinguishes **convergence events** from **paced nudges**:

- **Convergence events** — "this vote just pushed a day to fillable headcount," "the farmer changed the request," "the by-date just passed. These are detectable the instant the triggering write happens (in dispatch). On such an event, **dispatch triggers the coordinator to run *now* for that opp** instead of waiting for the scheduled tick.
- **Paced nudges** — "still collecting, here's the running tally," deadline-tightening reminders. These are genuinely time-paced and ride the scheduled tick; nobody is blocked on them.

**This is NOT a violation of "dispatch only acks, tick decides."** The *decision logic* (is it fillable? who to nudge? what copy? budgets?) still lives in the coordinator. Dispatch does not compose or send the outreach — it just **wakes the coordinator on a state change** ("run the review pass for opp X now"). The difference: *dispatch deciding to message* (no) vs. *dispatch signaling that something became actionable* (yes, and required for responsiveness).

So the architecture is **event-triggered standing process**, not a fixed-interval poll:
- **Threshold-crossing writes** (a fillable vote, a requirement change) → dispatch invokes the coordinator immediately for that opp.
- **The scheduled tick** is the **pacer + safety net** — it catches slow trickles, deadline tightening, stalled threads, and anything no single event surfaced. It can stay coarse (e.g. 15–30 min) because the latency-sensitive path is event-driven.

Implementation note: "fillable" is cheap to check in the same transaction that records the vote (compare the day's DAY_VOTE count to `headcount_needed`). The immediate coordinator run can be a direct call or a lightweight enqueue; either way it runs the *same* coordinator decision code the tick runs, just triggered sooner.

**The dividing line (product call 2026-06-01): dispatch acknowledges what the user just did; the tick decides to reach out.** Deferring an acknowledgment of something the user just did is the bad kind of silence; deciding *who to proactively contact* is coordination judgment that belongs in the standing process. Concretely:

| Stays SYNCHRONOUS in dispatch (reaction to the user's own action) | Moves to the TICK (proactive coordination) |
|---|---|
| Compliance hotkeys: STOP / HELP / JOIN / FLAG (TCPA — must answer now) | Initial fan-out / tiered outreach |
| Safety escalations (injury/payment/etc. — can't wait) | Farmer day-vote nudges + tallies |
| Direct ack of the user's action: "got your YES — confirmed", drop ack | Convergence detection + lock-in |
| Direct factual answer: "what time is Saturday's shift?" | Re-fan-out of a stalled day; chasing quiet threads |
| Recording a vote/claim/drop/edit to Firestore | Deadline final-nudge + expiry/release |

This is **not a new invariant** — it makes an existing CLAUDE.md principle load-bearing: *"Direct one-to-one replies and notifications to explicit user actions send anytime; all scheduled/broadcast outbound is deferred/quiet-hours-gated"* (i.e. tick-owned). The reframe is to treat that boundary as the system's spine, not just a quiet-hours rule.

**Scope note:** this principle is bigger than day-voting — it's a statement about the whole system's shape. Day-voting is the first feature designed natively around it. If adopted broadly, some outreach currently initiated from dispatch-adjacent flows (e.g. edit/cancel fan-outs) should be audited against the table above. Track that as a separate architecture item, not part of this feature's first cut.

### Prioritization: which opps does the coordinator work first?

The review tick has a per-pass budget (today `agent_review_per_tick_max = 3`), so with more open opps than the budget the coordinator must choose. A human triages by urgency × actionability, not creation order. **Decision (2026-06-01): a deterministic priority score in code selects the top-N opps for the pass; the agent only chooses the *action* for those** (matches "deterministic before LLM"; a 24B is unreliable at multi-factor ranking, and a code score is tunable + testable).

Score factors (chosen):
- **Time-to-deadline (urgency)** — primary sort. Hours until the by-date/event; perishable pickups rank up naturally via their tighter pacing.
- **Actionability** — strong boost when a decision is *waiting*: a day just hit fillable headcount, a requirement changed, or the final by-date nudge is due. An opp with nothing actionable yet is deprioritized (acting on it is wasted).
- **Anti-starvation / fairness** — a floor/tiebreaker: an opp untouched for several passes gets bumped so one busy opp can't monopolize the budget.

(Deliberately *not* a separate factor: "at-risk of failing." It's largely captured by urgency, and "rescue a doomed opp vs. let it go" is a judgment better left to the agent's *action* choice than to the triage sort.)

**Assignment vs. prioritization — and is Hungarian/bipartite matching relevant?** Prioritization is a *ranking of one set* by score (a sort), not an assignment problem — Hungarian doesn't apply there. Bipartite matching *is* the right abstraction for **assignment** (which volunteers → which day's seats), but for the pilot we use a **greedy tally** (count DAY_VOTEs per candidate day; pick the best-supported, preference breaks ties), because: (a) at pilot scale day-vote overlaps are tiny and greedy is optimal in practice; (b) the **farmer locks the day** — the system reports tallies, it does not impose an optimizer's assignment; (c) we collapse to a single locked day, removing the multi-slot structure where matching pays off. **If scale ever makes assignment dense** (level-4, many volunteers each free on different overlapping subsets of a week, system *proposing* the max-fill day), revisit with max-bipartite-matching or min-cost-flow weighted by preference. Out of scope now.

### The standing process today: `run_board_review_tick`

The codebase already has the seed of the standing coordinator: `run_board_review_tick` (`board_review.py`). It already (a) sweeps the whole board (`_build_board_state`: all open opps, open offers, stalled clarify threads, upcoming confirmations), (b) runs `run_review_agent` over that state to propose next actions, and (c) routes proposals through per-tick / per-user / per-opp budgets. It's currently gated to **admin-only** for the pilot (`AGENT_REVIEW_ADMIN_ONLY`) because we don't yet trust a 24B to autonomously message users. Maturing this tick — and selectively letting low-risk proposal types go direct — IS the work; day-voting is its first concrete consumer.

**So candidate-day voting is best understood as one behavior of a matured board-review tick, not a separate event-driven subsystem.** The recurring pass is where the day-vote coordination naturally lives:

- **Sweep:** include each COLLECTING_DAY_VOTES opp and its current day-tally in `BoardState`.
- **Detect:** a day reached fillable headcount; the by-date is near; a requirement changed; the request is stalling.
- **Propose:** nudge the farmer with the tally + YES/ignore; re-fan-out a stalled day; send the final "last chance" nudge; expire + release at the deadline.
- **Act or surface:** per `AGENT_REVIEW_ADMIN_ONLY`, either send the nudge or write it to the admin worklist. Day-vote nudges are a strong candidate to be among the *first* proposal types allowed to go direct (they're low-risk, farmer-facing, and the farmer explicitly opted into a multi-day post) even while broader autonomous nudges stay admin-gated.

This splits the work cleanly:
- **Inbound dispatch (reflex):** record a volunteer's day-vote, ack it, update the tally. Cheap, immediate, deterministic.
- **Board-review tick (standing process):** decide *when* to nudge the farmer, detect convergence/deadlines, drive lock-in and expiry. This is where "contextual nudge cadence" (point 4) actually lives — the tick sees the whole timeline, so it can pace by lead time instead of reacting to every single vote.

**Implication for cadence (supersedes the event-driven reading of point 4):** the farmer nudge is a *review-tick proposal*, not a per-vote reflex. The tick runs on a schedule, sees the by-date and the tally, and decides whether this opp is worth a farmer nudge this pass — naturally throttled by the existing per-opp/per-user budgets. A last-minute weekend ask gets nudged on consecutive ticks; a week-out ask gets nudged rarely. STATUS remains the farmer's pull in between.

**Mid-flight requirement changes** ("actually Mon is best now") are a farmer inbound the reflex handles (update the opp / preference), but the *consequences* (re-tally, re-nudge, tell affected voters) are review-tick work — another reason the tick is the spine.

## What already exists (reuse)

The window/proposal subsystem (`docs/agent-architecture-rethink.md`) gives most primitives — windows are **re-enabled** for this (`AGENT_WINDOW_POSTS_ENABLED=1`):

- **`OpportunityDoc.window_end_at`** — the candidate-day span.
- **`YES SAT,SUN` / `YES MON,WED` parsing** — `_YES_DAY_LIST_RE` / `_DAY_TOKEN_RE` in `hotkeys.py`. (Single-day votes like `SUN` and an `ANY`/`BOTH` token are small additions.)
- **`_resolve_day_label`** (`claim.py`) — maps "SUN" → the concrete date in the window.
- **`ClaimDoc.scheduled_for_at`** — per-day claims; confirmations and post-event pings are day-aware.
- **`STATUS`** (`farmer_ops.handle_status` + `render_status_line`) — already renders a per-opp tally; day-votes add a dimension.
- **Tier/escalation pacing** (`next_escalation_at`, `outreach.py`) + the `kind`-driven lead-time logic — supporting cadence inputs.
- **`run_board_review_tick` + `run_review_agent` (`board_review.py`)** — THE primary seam (see "standing process" above). Already sweeps the board, runs an agent, and budget-routes proposals. Day-vote coordination extends `BoardState` + the review agent's proposal vocabulary rather than building a parallel tick.
- **Expiry** — `OpportunityStatus.EXPIRED` + the stale-draft tick already exist; the deadline-expire path reuses them.

## What's new (the delta)

A genuine new sub-system, closer in weight to the proposal machinery than a one-field add:

1. **Candidate-day set + by-date on the opp.** The window gives start/end; new pieces are the *enumerated candidate days* (for level 4, derived from now→by-date) and an explicit `by_date` / decision-deadline. Plus optional `preferred_day` (level 2) as a soft hint that biases copy + the farmer nudge, not the volunteer's options.

2. **Soft day-vote status.** A SAT/SUN/etc. reply is not `CONFIRMED` or `PROPOSED` — it's a soft signal resolving to a claim only at lock-in. **Decided:** a dedicated `ClaimStatus.DAY_VOTE` (per-day via `scheduled_for_at`, holds no seat, distinct from MAYBE/INTERESTED).

3. **A "collecting day-votes" opp state.** Neither plain `OPEN` nor a normal filling window — "gathering preferences pending a farmer decision." Likely a sub-state flag, not a new top-level `OpportunityStatus` (keep the enum stable).

4. **Contextual farmer-nudge cadence + by-date deadline tick.** Nudge when a day reaches fillable headcount OR on a cadence that tightens with lead time; one final nudge at the by-date, then expire. Rides the existing pacing seam; needs a per-opp nudge budget (carrier/cost throttle).

5. **Lock-in resolution (farmer YES).**
   - Chosen day's votes (and ANY/BOTH voters) → `CONFIRMED` up to headcount; overflow → waitlist.
   - **Off-day-only voters → notify + offer to keep them:** *"This one's set for Mon now — can you still make it? Reply YES."* Yes confirms onto the locked day (subject to headcount); silence releases.
   - Opp collapses from the candidate window to the locked single day (`window_end_at` cleared, `starts_at` = locked day) → normal shift (confirmations, post-event).

6. **Agent + prompt.** Recognize levels 2–4 and emit a candidate-day opp; for level 4, require a by-date (clarify if missing, cap ~1 week). New parsed fields. (Re-opens some deferred window prompt surface — see Risks.)

7. **Fan-out copy.** New template listing candidate days *with dates*, optional preference hint, and the reply instruction.

## State machine (sketch)

```
DRAFT ──(farmer confirms candidate days [+ by-date for L4])──> COLLECTING_DAY_VOTES
   COLLECTING_DAY_VOTES:
     vol replies <day(s)> / ANY ──> record soft day-vote
     [trigger: day reaches headcount OR urgency-cadence] ──> nudge farmer (tally + YES/ignore)
     farmer ignores ──> stay COLLECTING_DAY_VOTES
     farmer STATUS ──> render current day-tally (pull)
     farmer YES ──> LOCK chosen day
     by-date reached, not locked ──> final "last chance" nudge
        farmer YES ──> LOCK
        no reply ──> EXPIRE (release voters: "didn't get scheduled")
   LOCK:
     chosen-day + ANY votes ──> CONFIRMED (up to headcount), overflow ──> waitlist
     off-day-only votes ──> notify + "still come on <locked day>? YES"
     opp ──> normal single-day shift (OPEN/FILLING/FULL as usual)
```

## Risks / tensions to weigh before building

- **Re-opens window prompt surface.** Depends on `AGENT_WINDOW_POSTS_ENABLED=1`, set OFF for the pilot precisely because windows are the flakiest part of the eval on a 24B model. Re-enabling trades that simplicity back. Mitigation: keep the agent's job narrow, lean on deterministic backstops, and gate the whole voting feature behind its own flag so it ships independently of full window posts.
- **Farmer SMS volume.** Per-vote nudges could exceed the "0–6 messages/week" disclosure band and the cost target. The contextual cadence + "lock when fillable" trigger + a per-opp nudge budget are the throttle.
- **Carrier/compliance.** Day keywords (SUN/MON/…/ANY) are operational claim variants (like `YES N`) — check `docs/sms-compliance-requirements.md`; must not collide with reserved hotkeys.
- **Complexity vs. pilot scale.** Real net-new state + ticks + tests at 2–5 farms. Confirm it earns its keep, or ship a thinner v1 (levels 2–3 only; level 4 = agent asks the farmer to name days) first.

## Open decisions (carry into implementation)

All resolved 2026-06-01 — see "Settled" below. (Remaining tuning, not blocking: exact deadline-tightening intervals and the per-opp nudge-budget number, to be set with sensible defaults during the build.)

## Settled (product calls 2026-06-01)

- **Governing split: dispatch writes state + acknowledges the user's own action; the tick decides all proactive outreach (who/what/when).** Synchronous-in-dispatch = compliance hotkeys, safety escalations, direct acks, direct factual answers, and the Firestore mutation itself. Tick-owned = fan-out, farmer nudges, convergence, lock-in, chasing stalled requests, deadline/expiry. Makes an existing CLAUDE.md principle load-bearing; generalizes beyond day-voting (audit other dispatch-initiated outreach separately).
- The coordinator is a standing process: candidate-day coordination lives in a matured `run_board_review_tick`, not a parallel event-driven subsystem.
- Spectrum is one mechanism: vote among candidate days, lock before a deadline.
- By-date required only for level 4; implicit (last listed day) for 2–3; cap ~1 week out.
- Deadline with no farmer lock → one final nudge, then expire + release (no autonomous lock).
- Off-day-only voters at lock-in → notify + offer the locked day.
- Nudge cadence is urgency-contextual; STATUS is the farmer's pull.
- **Soft-vote storage:** new `ClaimStatus.DAY_VOTE` (per-day, holds no seat, distinct from MAYBE/INTERESTED; resolves → CONFIRMED at lock-in).
- **v1 scope: levels 2–3 only.** Level 4 ("whenever") → the agent asks the farmer to name some days (becoming a level-2/3 post). Level 1 unchanged.
- **Approval flow: voting replaces per-day PROPOSED→approval.** A candidate-day opp uses vote-then-lock; no PROPOSED claims / `tick_proposals` on it. The farmer's single lock-in is the approval. (`tick_proposals` stays only for any non-voting window opps, or retires with windows.)
- **Cadence rule:** nudge when a day first reaches fillable headcount, OR on a cadence that tightens as the by-date nears; throttled by a per-opp nudge budget; STATUS is the pull in between. Exact intervals/budget = build-time defaults.
- **Responsiveness:** convergence ("a day just became fillable") should nudge promptly via an event-triggered coordinator run, BUT **a ~30-min worst-case delay is acceptable** (farmer call) — so a frequent-enough scheduled tick alone is a fine v1; the event-trigger is an optional responsiveness optimization, not a hard requirement.
- **Level-2 preference display:** soft hint in the volunteer fan-out day list ("Mon 6/4 (farmer's pick)"); also breaks ties in the farmer nudge.
- **Sequencing:** carve-out — keep the review tick admin-only for general nudges, but allow **day-vote farmer nudges to send direct** (low-risk: the farmer opted into their own multi-day post). Ships day-voting without fully graduating the tick.
- **Prioritization:** deterministic priority score in code (urgency primary; actionability boost; anti-starvation floor) selects top-N opps per pass; the agent only chooses the action. Greedy day-tally for assignment at pilot scale; Hungarian/bipartite matching only relevant if assignment ever gets dense (noted, out of scope).

## Implementation plan

Everything ships behind a new feature flag **`DAY_VOTING_ENABLED`** (default OFF), independent of `AGENT_WINDOW_POSTS_ENABLED`. Build in phases that each leave the tree green; nothing is wired into the live agent path until the final phase. Test-first where practical (the deterministic pieces are unit-testable without the LLM).

### Phase 0 — data model + flag (no behavior change)
- Add `ClaimStatus.DAY_VOTE` (`repos/models.py`); ensure it holds no seat and is excluded from `seats_filled` / MAYBE counts everywhere those are computed (audit `_maybe_count`, `try_claim_in_transaction`, STATUS rendering).
- Add opp fields: `candidate_days: list[date]` (or derive from `window_end_at` + an explicit set), `by_date: datetime | None`, `preferred_day: int | None` (weekday), and a `vote_state` sub-flag (`collecting | locked | expired`) — NOT a new top-level `OpportunityStatus`.
- Add `DAY_VOTING_ENABLED` to `config.py` (default OFF) + the eval `_eval_settings`.
- Repo helpers: `add_day_vote`, `list_day_votes(opp)`, `day_vote_tally(opp)`. Pure Firestore + unit tests, no dispatch wiring yet.
- **Green checkpoint:** new model + repo unit tests pass; nothing else changed.

### Phase 1 — volunteer vote intake (dispatch reflex, deterministic)
- Extend hotkey parsing: single-day tokens (`SUN`), `ANY`/`BOTH`, reuse `_YES_DAY_LIST_RE` / `_DAY_TOKEN_RE`. Guard against reserved-hotkey collisions; check `docs/sms-compliance-requirements.md`.
- Dispatch: on a day-vote inbound for a `collecting` opp → record `DAY_VOTE` claim(s) via `_resolve_day_label`, send a deterministic ack ("Got it — you're down for Sat 6/3 if it's picked."). This is pure reflex: write + ack, no farmer outreach.
- In the same transaction, compute whether a day just crossed fillable headcount; stash a cheap signal for the coordinator (Phase 4 consumes it).
- **Green checkpoint:** vote intake unit + dispatch tests; a vote records and acks; tally updates. No farmer messaging yet.

### Phase 2 — agent + fan-out (post creation)
- Prompt: recognize levels 2–3 (set of days, optional preference); emit a candidate-day opp with `candidate_days` + optional `preferred_day`. Level 4 → clarify "which days?" (no enumeration in v1). Keep the agent's job narrow; lean on a backstop that rejects a candidate-day confirm missing the day set.
- New parsed fields on `ParsedOpportunity`; executor writes the `collecting` opp.
- Fan-out copy template: list candidate days *with dates*, preference hint ("Mon 6/4 (farmer's pick)"), reply instruction.
- **Green checkpoint:** agent emits candidate-day opps in eval (stub + live cases); fan-out copy unit test.

### Phase 3 — lock-in + deadline + expiry (the resolution flow)
- `lock_day(opp, day)`: DAY_VOTE → CONFIRMED for that day (+ ANY voters) up to headcount, overflow → waitlist; off-day-only voters → "moved to <day>, still come? YES"; collapse opp to single locked day (`window_end_at` cleared, `starts_at` set) → normal shift.
- Farmer-facing: farmer `YES` to a lock nudge → `lock_day`. (Reuse the deterministic pending-confirmation path so it executes the stored action, not re-inference.)
- Deadline: at `by_date`, final "last chance" nudge; no reply → EXPIRE + release voters. Reuse `OpportunityStatus.EXPIRED`.
- **Green checkpoint:** lock-in / off-day / overflow / expiry unit tests (deterministic, no LLM).

### Phase 4 — coordinator integration (the standing process)
- Extend `BoardState` (`board_review.py`) to include `collecting` opps + day-tallies + by-date.
- Deterministic priority score (urgency / actionability / anti-starvation) selects top-N for the pass — code, not agent.
- Review-agent proposal vocabulary gains: farmer day-vote nudge, final-nudge, lock (farmer-confirmed), expire. Cadence: fillable OR deadline-tightening, per-opp nudge budget.
- **Sequencing carve-out:** day-vote farmer nudges may send direct even while `AGENT_REVIEW_ADMIN_ONLY` keeps other proposals on the worklist.
- Event-trigger (optional, since 30-min worst case is acceptable): dispatch's fillable signal invokes the coordinator for that opp immediately; otherwise the scheduled tick catches it.
- **Green checkpoint:** board-review unit tests for priority ordering + proposal generation; eval cases for the nudge.

### Phase 5 — end-to-end eval + docs
- Live eval cases for the full arc: post → vote → nudge → lock → off-day handling; and post → no lock → expire.
- Run full suite both flag states; confirm no regression with `DAY_VOTING_ENABLED=0` (the default).
- Update `architecture.md` (promote the "direction" note to documented behavior for the flag-on path), `status.md`, `next-steps.md`.

### Cross-cutting
- **Compliance:** new keywords are claim-shaped (like `YES N`); verify against the compliance doc before Phase 1 ships; they must not become opt-in/opt-out.
- **Budget/cost:** per-opp nudge budget + the existing per-user 48h budget keep farmer SMS within the disclosed band.
- **Flag discipline:** with `DAY_VOTING_ENABLED=0`, the agent never emits candidate-day opps and dispatch treats day tokens as today — so the pilot default is fully unaffected until you flip it.
