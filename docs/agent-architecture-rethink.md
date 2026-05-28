# Agent architecture rethink + multi-day window posts (Bug A)

> **Status (2026-05-28):** Design doc, not yet implemented. Written after the "need help next week → prep work → monday to friday → yes → Missing some details: starts_at, headcount_needed" exchange exposed both a localized bug (overconfirm backstop missed `headcount_needed`) and a deeper architectural assumption (the system expects precise farmer input). The localized fix landed in the same session (see commit). This doc plans the deeper change.

## The trigger

Real exchange:

```
[F] need help next week
[A] Need help next week — which day and what kind of work?
[F] any day, prep work
[A] You need help with prep work next week, but didn't specify a day. Which day works best for you?
[F] monday to friday
[A] Post as prep work at Three Cedars, Monday to Friday? Reply YES to confirm.
[F] yes
[A] Missing some details before I can post that: starts_at, headcount_needed
```

Four things went wrong, each pointing at a different layer:

1. **Round-2 prompt-following.** "any day, prep work" should have resolved the activity axis to `tbd`+"prep work" per the existing decision tree, and only re-asked about day. The agent asked about day *only*, which was correct on its face — but then on round 3 it accepted "monday to friday" and confirmed against a single `starts_at`, which is bug 3.
2. **Date-range collapse.** "monday to friday" cannot satisfy a single-`datetime` `starts_at`. The agent silently picked one (or worse, left it half-resolved) and confirmed.
3. **Overconfirm backstop too narrow.** The backstop only checked `starts_at` and `activity_tags`. It didn't check `headcount_needed`, so the agent's confirm passed pre-confirm validation, the farmer said YES, and the executor's `compute_missing_fields` fired with raw schema names.
4. **Recoverability bottoming out as garbage.** "Missing some details before I can post that: starts_at, headcount_needed" isn't a sentence a farmer can act on.

Fixes 3 and 4 landed immediately (this session). Fix 1 got a prompt nudge. Fix 2 got a stopgap backstop (`_inbound_has_date_range_signal`) that forces a clarify-down-to-single-day rather than letting the silent collapse through. **All four together still point at a bigger principle the system isn't honoring**, which is what the rest of this doc is about.

## The principle the system isn't honoring

Farm Friend's job is to absorb the messiness of human communication so that farmers and volunteers get *more* help with *less* coordination overhead. Today the system is built around the implicit premise that the farmer will eventually answer every required field. When the farmer is fuzzy ("a few people one day next week, prob morning"), the system pushes back with clarifies until either the farmer caves and provides precision, the clarify cap fires and Max gets pinged, or the draft goes stale and gets flagged.

That's backwards. **The farmer's fuzziness is the system's problem to solve, not the farmer's.** Most VIGA farmers are a one-person operation who texted from a tractor seat. The system should:

1. **Accept fuzzy posts as first-class** — above a defined floor. A multi-day window, a vague time-of-day bucket, an unfamiliar activity word — these are valid inputs the system records and broadcasts in their own shape, not bugs to clarify away. There is a floor (see [Minimum Viable Details](#minimum-viable-details-mvd)) below which a posting genuinely isn't matchable, and Madison does keep the dialog open until the floor is met. Above the floor, structural fuzz is fine.
2. **Gently herd toward specificity at the right moments, calibrated to the farmer.** Some fuzz reduces match quality enough to be worth one follow-up question (above MVD); some fuzz is harmless or better (TBD activity, "morning-ish" timing). And the right amount of pushing varies by farmer — see [Calibrating the herd](#calibrating-the-herd-how-much-specificity-to-push-for). Madison never asks twice on the same axis.
3. **The farmer is the decider.** Madison absorbs operational chaos but doesn't make commitments on the farmer's behalf when the farmer left a degree of freedom open. When a volunteer claims a specific day inside a window the farmer posted, the farmer gets to accept or decline the proposal — see the [farmer approval gate](#farmer-approval-gate-on-window-claims).
4. **Make the right thing easy and the wrong thing hard.** A farmer who texts "any day next week, prep work, 2 ppl, morning" hits a single confirm prompt. A farmer who texts "tomatoes" gets one focused question about the missing activity word, not a wall of options.

### The persona — Madison

The agent's internal frame is a person, not an assistant. Concretely:

> You are Madison, 40, a part-time paid employee of the Vashon Island Growers Association. Before this job you worked on farms for about a decade — a season at a CSA in the Skagit, a couple years at a goat dairy, summers helping out at u-picks. These days you also manage a small but high-yield home garden, so the rhythm of the work is still in your hands: when peas need trellising, why a tomato bed gets weeded weekly until it doesn't, what a wet spring does to a planting schedule.
>
> You understand farm work as it actually is: shaped by the seasons (prep, plant, tend, harvest, distribute), by weather, by the realities of working with living things on a deadline. You also know the people: farmers running on too little sleep who fire off a text from a tractor seat, volunteers who mean well but flake, the slightly chaotic nature of all of it. You don't begrudge any of that — it's the work. Your job is to absorb that chaos so it doesn't compound into missed harvests or no-shows.
>
> You handle inbound and outbound communications between farmers and volunteers, with two simultaneous goals: maximize how much help actually lands, and minimize miscommunications and scheduling mishaps. You report to Max (the coordinator). You bring Max in for the things only Max can handle — injury, money, legal, interpersonal stuff. Everything else, you handle yourself, the way a competent neighbor with farm experience would.
>
> You send SMS messages on behalf of Farm Friend Vashon, the SMS service. Recipients see messages from "Farm Friend Vashon" — not from Madison. You are not the brand; you are the person doing the work behind the brand.

This is a strict upgrade over the current "neutral coordinator agent" framing in a few ways:

- **Anchors the voice.** "Warm, brief, practical" reads as a style guide. "You are a 40-year-old who's spent a decade on farms" reads as an identity — and identity carries voice without needing 50 lines of prose rules. The agent stops sounding like a form when it knows it's a person sending the text. The backstory also makes domain-specific phrasings *natural* ("the weeding's not going to wait", "Friday's the only dry-looking day this week"), not bolted-on jargon.
- **Anchors the boundaries.** Madison has a boss (Max). Madison has resources (the system). Madison handles the operational complexity; Max handles the human-judgment-required stuff. This maps 1:1 onto the existing escalation triggers (injury/payment/legal/etc.) but in a way the model can reason about ("would Madison handle this herself, or escalate?") rather than a checklist to match against.
- **Anchors the role.** Madison is not the Farm Friend brand — Farm Friend is the SMS service Madison sends from. So the agent CAN say things like "I'll let nearby farms know" or "I'll check with the coordinator" without violating the no-fabrication rule, because Madison being the one doing the legwork is just true. (Compare: today's agent has to either say "we" plurally or attribute action to a vague third party.)
- **Anchors the agency.** Madison *acts* on behalf of farmers and volunteers. Today's agent prompt says "you have wide latitude" but also "default to asking, not acting" — two principles in tension. A persona resolves the tension because Madison acts the way a smart neighbor-employee would: confidently on the easy stuff, cautiously on the ambiguous stuff, and never on the dangerous stuff.
- **Anchors domain judgment.** Madison knows weeding can wait a day but harvest at peak ripeness can't. Madison knows weekend availability differs from weekday availability for volunteers but not for the crops. Madison knows that "morning" on a 95° forecast day means "before 10am, really." The current prompt has to teach all of this case by case; the persona lets the model lean on what it already knows about farm work without us having to itemize it.

**Important constraint:** Madison is the agent's internal frame, NOT a name Farm Friend uses with users. Outbound copy still comes from "Farm Friend Vashon" (compliance-required program name). The persona is for prompt-engineering leverage, not for user-facing branding. We do not want to anthropomorphize "Farm Friend" itself. Users never learn Madison's name; we don't sign messages "— Madison" or refer to her in the third person.

### Calibrating the herd: how much specificity to push for

Principle 2 in the section above said "gently herd toward specificity." That's right, but the calibration matters — pushing the same farmer for the same level of detail twice is interrogation; not pushing enough leaves the matcher with nothing to work with. Two dials:

**Dial 1 — the floor.** Some details are *required* for the opp to be useful at all. These are the [Minimum Viable Details](#minimum-viable-details-mvd) (defined below) — without them, broadcast copy can't be written and volunteers can't choose. Madison does not give up on MVD; she keeps the dialog open across as many turns as needed, with rephrasing if a question fails ("what time?" → "morning or afternoon?"). The clarify cap doesn't fire when she's still chasing MVD — it's not the same kind of stall as the current "thread dead, give up" case.

**Dial 2 — above the floor, read the room.** Once MVD is satisfied, Madison gets one (sometimes two) chances to push for more specificity if it would meaningfully improve the match — but only if the farmer's tone suggests they're open to it. Signals:
- **Tone-receptive farmers** (texting in complete sentences, providing voluntary context, asking questions back) — fine to follow up: "Want me to suggest 9am? That's your usual." or "Two people, any preference on who from your insiders?"
- **Tone-impatient farmers** (one-word replies, all-lowercase no-punctuation, taking minutes/hours to reply) — accept what they gave you and post. Don't push.
- **Past-behavior signal** — if a farmer's prior posts converged in one round, push lightly. If they've taken three rounds before, accept their first answer and move on.

Concretely: above-MVD specificity asks are framed as suggestions with a clear no-friction default ("I'll post for 9am unless you tell me otherwise"), never as gates the farmer has to clear. Below-MVD asks are real questions ("what kind of work?").

This is a Madison-judgment call, not a hard rule. We don't try to encode it as a flow chart. The prompt describes the principle with worked examples; we trust the model to read the room.

## Minimum Viable Details (MVD)

The line below which a posting is unmatchable. Madison doesn't accept a `create_opportunity` confirm until MVD is satisfied — even if it means a longer dialog. Above MVD, she may post with structural fuzz (`tbd` activity, day windows, time-of-day buckets) and let the matcher work with what's there.

### MVD for `kind=shift`

A shift must have **all** of:

1. **Some time-of-day signal.** Either a clock time ("9am", "3pm", "noon"), or a bucket from the canonical list below. "Anytime" is NOT acceptable — different volunteers have radically different availability windows, and the time-of-day is the load-bearing field for matching.
2. **Some date signal.** Either a specific day ("Friday", "Jun 5", "tomorrow") or a date window with a defined start and end ("Mon–Fri", "this weekend", "next week"). "Soon" or "sometime" is NOT acceptable.
3. **Headcount.** A number. "A few" is treated as 3 if the farmer confirms; "some" → ask for a number. The farmer is allowed to say "as many as I can get" but that maps to an explicit `headcount_open: bool` flag and broadcast copy reflects it ("any number of helpers welcome").
4. **Activity OR explicit `tbd`.** A canonical work-type slug, OR an explicit acceptance of `tbd` (the farmer said "not sure yet" / "whatever needs doing" / accepted a previous round's offer of `tbd`). A non-canonical word like "prep work" maps to `["tbd"]` with the verbatim word in `requirements_text` — that satisfies MVD.

### MVD for `kind=pickup`

A pickup must have **all** of:

1. **Deadline** (specific or bucketed; same vocabulary as shift time-of-day).
2. **Produce description** (free-text, e.g. "20 lbs zucchini" or "extra greens").
3. **Destination** OR explicit "wherever volunteer can take it" (maps to `destination=None, destination_open=True`).

### Canonical time-of-day buckets

When the farmer doesn't give a clock time, accept any of these as a valid bucket (stored as a `time_of_day_bucket` field on the opp):

- `early_morning` — before 8am, dawn farm work
- `morning` — 8am–11am, the default farm-work window
- `late_morning` — 10am–noon
- `midday` — 11am–2pm
- `afternoon` — 1pm–5pm
- `late_afternoon` — 3pm–6pm
- `early_evening` — 5pm–7pm
- `evening` — 6pm–8pm

These overlap intentionally — "morning" and "late_morning" share an hour because farmer phrasing isn't precise and we don't want to force a choice between them. Broadcast copy renders the bucket directly ("late morning"), not a clock range, when no clock time was given. If the farmer later replies with a clock time, the bucket is replaced by the explicit time.

When `starts_at` AND a bucket are both present, the clock time wins (the bucket was a temporary stand-in). `starts_at` is optional iff a bucket is set; the parser's REQUIRED_SHIFT_FIELDS check becomes "either `starts_at` or `time_of_day_bucket`."

### What Madison does when farmer keeps refusing MVD

If the farmer responds to a real MVD question with another non-answer ("anytime", "whenever", "you tell me"), Madison:

1. **First round:** rephrase as a bucket-list multiple choice ("morning, afternoon, or evening?"). Most "anytime"s resolve here.
2. **Second round:** offer a specific recommendation tied to past behavior ("Last time you posted, you went with 9am — same again?"). If no past, recommend `morning` as the default for farm work.
3. **Third round, still no answer:** post with `time_of_day_bucket=morning` flagged as `defaulted=True` in admin view, and tell the farmer in the receipt: "Posted for morning — text back with a different time if that's wrong." Madison did the work; the farmer can correct or ignore.

This is the same shape as the round-2 activity fallback that already works — accept the burden, post the opp, give the farmer a no-friction correction path.

## Concrete proposal: multi-day window posts (Bug A)

This is the smallest data-model change that unblocks the principle above for the most common fuzz axis (date range).

### Data model

`OpportunityDoc` gains one optional field:

```python
window_end_at: datetime | None = None
```

- When `window_end_at is None` (or `==starts_at`), the opp is single-day — current semantics, no changes downstream.
- When `window_end_at > starts_at`, the opp is a **window posting**: the farmer is offering work to any volunteer who can come on any day in `[starts_at.date(), window_end_at.date()]`.
- The `starts_at` time-of-day is the canonical start time; the window only spans days, not within-day hours. ("Mon–Fri 9am" is one window opp; "Mon morning vs Fri afternoon" is two opps.)
- `duration_min` still applies and is per-day.

Rationale for putting the window on the opp (rather than fanning out into N opps on post):

- Outreach copy can say "any day Mon–Fri" instead of blasting 5 messages.
- The farmer sees one post in STATUS, not 5.
- The seat economy stays simple: `headcount_needed` is total seats across the window. (A farmer asking "2 people any day" usually means "2 person-days of help, distributed however."  A farmer who wants 2 people *every* day for 5 days would post "2 people Mon AND 2 people Tue AND..." — that's an explicit ask we don't conflate with the window case.)

### Claim shape

`ClaimDoc` gains one optional field:

```python
scheduled_for_at: datetime | None = None
```

- For single-day opps: `scheduled_for_at == opp.starts_at` (or stays `None`; we can derive from the opp).
- For window opps: `scheduled_for_at` is required at claim time and is the specific day the volunteer is signing up for, with the time-of-day inherited from `opp.starts_at`.

### Volunteer claim grammar

Today: `YES` claims one seat. `YES 2` claims two.

With windows:

- On a single-day opp: `YES` / `YES N` unchanged.
- On a window opp: outreach copy lists candidate days; volunteer replies `YES <day>` (e.g. `YES WED`, `YES MON`, `YES TUE`, or `YES TOMORROW`, `YES JUN 4`). The hotkey parser extends to recognize day tokens. If the volunteer just says `YES`, dispatch falls back to the agent for a one-turn clarify ("Which day works — Mon, Wed, or Fri?").
- **Multi-day claim on one window.** A volunteer who can come multiple days replies `YES MON, WED` or `YES MON AND WED`. Each day creates a separate ClaimDoc (same `volunteer_user_id`, distinct `scheduled_for_at`). The window's `seats_filled` increments by the number of days claimed.
- `MAYBE` similarly takes a day (or days), or falls back to clarify.

### Farmer approval gate on window claims

A core product principle: **the farmer is the decider**. On single-day opps today, a volunteer's `YES` autoconfirms and the farmer is notified after the fact (the existing "First YES on X" / "now N/M filled" milestone messages). That works because a single-day opp has fully-defined parameters when the volunteer claims.

Window opps are different — a volunteer claiming a specific day inside a window is making a *concrete proposal* the farmer hasn't seen yet. ("I can do Wed" is news the farmer might want to weigh in on — maybe Wed is the day they actually need help least.) So:

- **Volunteer `YES <day>` on a window opp goes to PROPOSED state, not CONFIRMED.** A new `ClaimStatus.PROPOSED` sits between `interested` and `confirmed`. PROPOSED claims hold a seat (count against `seats_filled`) but don't yet trigger the volunteer's confirmation reminder.
- **Farmer receives an SMS** describing the proposal with `ACCEPT <token>` / `DECLINE <token>` actions. Token grammar matches existing patterns (4-letter uppercase, action-specific). Farmer's ACCEPT flips the claim to CONFIRMED and sends the volunteer a confirmation receipt. DECLINE flips the claim to DROPPED, decrements `seats_filled`, and sends the volunteer a "the farmer can't host you that day — want to try a different day?" SMS.
- **Auto-confirm fallback.** If the farmer doesn't respond within a configurable window (default: 4 hours for shifts > 24h out; 1 hour for shifts < 24h out), the proposal auto-confirms and the farmer gets a "auto-accepted Wed proposal from Alex — reply DROP to undo" notification. We don't strand volunteers waiting on a farmer who's busy in a field.
- **Single-day opps are unchanged.** Volunteer `YES` still auto-confirms — the farmer already specified the day.

Why the asymmetry: on single-day opps the farmer has already committed to that day, so volunteer claims are filling pre-approved slots. On window opps the farmer committed to a *range*, and each volunteer's day choice is information the farmer can use ("oh, three people want Wed but nobody wants Mon — I'll adjust"). Giving farmers the explicit approval step makes the system feel like a tool that serves them rather than one that books their schedule for them.

This also generalizes: when we later add other window dimensions (time-of-day, etc.), the same PROPOSED-then-farmer-approves pattern applies wherever the volunteer's claim resolves a degree of freedom the farmer left open.

### Outreach copy

`render_shift_outreach` gains a window variant:

```
Farm Friend Vashon: Plum Forest needs 2 people for weeding, any day Mon Jun 2 – Fri Jun 6, 9am–noon. Reply YES <day> (e.g. YES WED), MAYBE if maybe available, MUTE to skip, or STOP to opt out.
```

For a window opp, the copy mentions the window explicitly so the volunteer knows to specify.

### Confirmation reminders

`tick_confirmations` already keys per-claim. For window opps, the 24h-before timer is computed from `claim.scheduled_for_at`, not `opp.starts_at`. Otherwise unchanged.

### Post-event check-in

`tick_post_event` fires per-opp today. For window opps, it needs to fire per-day-with-at-least-one-confirmed-claim — the farmer gets one check-in per day that actually happened, not one for the whole window. Either:

- (a) `post_event_checkin_at` becomes a list of times (one per day with claims), or
- (b) we derive at tick time by grouping confirmed claims by `scheduled_for_at.date()` and tracking which (opp_id, date) pairs we've already pinged in a sidecar collection.

(b) is cleaner — no schema change on the opp, and the existing once-per-opp flags (`post_event_checkin_sent`) get replaced by per-(opp, date) tracking. Sidecar collection: `opportunities/{oppId}/post_event_pings`, doc id = ISO date, fields `pinged_at`, `farmer_response`. The tick reads claims grouped by date, compares against the sidecar, fires for any day older than the threshold without a ping doc.

### Stale-draft tick

Unchanged — `last_updated_at` is the staleness clock and works the same for window drafts.

### Agent action schema

`create_opportunity` payload gains:
- `window_end_at: str | None` (ISO 8601) — for window posts
- `time_of_day_bucket: Literal[...] | None` — one of the canonical buckets from MVD section; mutually substitutable with `starts_at` clock time
- `headcount_open: bool = False` — set when farmer says "any number" / "as many as I can get"

`REQUIRED_SHIFT_FIELDS` changes from `("starts_at", "headcount_needed", "activity_tags")` to a smarter shape:
- Date: `starts_at` (date component) present
- Time: `starts_at` (time component) OR `time_of_day_bucket` present
- Headcount: `headcount_needed > 0` OR `headcount_open=True`
- Activity: `activity_tags` non-empty (including `["tbd"]`)

`compute_missing_fields` updates accordingly and now returns human-readable axis names ("time", "activity") rather than schema field names, which the `_FIELD_QUESTIONS` map in dispatch already expects.

`update_draft_opportunity` gets the same field additions.

New action: `farmer_decide_on_proposal` for the PROPOSED-claim flow. Payload: `claim_id`, `decision: Literal["accept", "decline"]`. Drafted by the agent when the farmer free-form replies about a proposal ("Wed works"/"Wed doesn't work for me"); the deterministic ACCEPT/DECLINE tokens in the proposal-notification SMS are the fast path.

### Prompt rules

The agent prompt grows:

- A new sub-section under "Activity vocabulary" → call it "Time vocabulary" — that explains:
  - The difference between a single-day post (`starts_at` only) and a window post (`starts_at` + `window_end_at`).
  - The time-of-day buckets (see MVD section above) and when to use a bucket vs a clock time.
  - **Weekday vs weekend is a known distinction, not a constraint.** Madison knows volunteers often think in weekday/weekend terms ("weekend mornings", "free Sat or Sun"), and knows farm work happens on both. Treat "weekend" as a window spanning Sat–Sun, "weekdays" as Mon–Fri, but **do not** infer farmer intent past what they wrote (a farmer who posts "Mon–Fri" did NOT exclude the weekend; they specified Mon–Fri because that's what they want — don't ask "do you also want weekend?"). Same in reverse: a farmer who posts "this weekend" means Sat–Sun, period. Plenty of farm work happens on weekends — markets, harvests for Monday delivery, weeding the volunteers couldn't get to during the workweek. Don't treat weekend posts as unusual or weekday posts as the default.
  - Worked examples:
    - "next Tuesday 9am" → single-day, `starts_at` only
    - "next Tuesday morning" → single-day with `time_of_day_bucket=morning`, no clock time
    - "any day next week, morning" → window (Mon next week → Fri next week) with `time_of_day_bucket=morning`
    - "Mon–Wed 9am" → window (Mon → Wed), `starts_at=Mon 9am`, `window_end_at=Wed`
    - "weekend mornings" → window (Sat → Sun), `time_of_day_bucket=morning`
    - "Saturday harvest, dawn" → single-day with `time_of_day_bucket=early_morning`
    - "Mon morning OR Fri afternoon" → **two opps; clarify which one** (or both; explicit fan-out is a future feature)
- The date-range backstop signal (`_inbound_has_date_range_signal`) gets retired — it's no longer an over-confirm; it's the trigger to set `window_end_at`.
- Rule 0 (default to asking) gets new worked examples:
  - "any day next week, prep work, 2 ppl, morning" → `mode="confirm"` with `window_end_at=Fri`, `time_of_day_bucket=morning`, `activity_tags=["tbd"]`, `requirements_text="prep work"`, `headcount_needed=2`. ALL MVD satisfied; do NOT clarify.
  - "need help" (nothing else) → `mode="clarify"` asking for at least a day window and what kind of work. Below MVD on multiple axes; one focused question rather than a list.
  - "tomato harvest next week" → `mode="clarify"` asking which day(s) and what time. MVD missing on date specificity and time; rolling these into one question is fine.
  - "anytime" as a reply to "what time?" → `mode="clarify"` with bucket multiple choice ("morning, afternoon, or evening?"). MVD not yet satisfied; rephrase, don't accept "anytime" as a value.

### Admin UI

Roster + Opportunities views show the window when present ("Mon Jun 2 – Fri Jun 6") and per-day fill counts derived from claims. Minimal new component; reuse the existing date formatter.

### Eval cases

New REGRESSION cases:
- "any day next week, 2 ppl weeding, 9am" → `create_opportunity` with `window_end_at = next Friday`
- "Mon to Wed 9am 2 ppl harvest" → `create_opportunity` with `window_end_at = Wednesday`
- "weekend mornings, 2 ppl, gleaning" → `create_opportunity` with window Sat–Sun, `time_of_day_bucket=morning`
- "this Sat 8am 3 ppl harvest" → `create_opportunity` single-day, no over-helpful "did you mean Sun too?" clarify
- "any day next week prep work 2 ppl morning" → `create_opportunity` with `window_end_at = Fri`, `time_of_day_bucket=morning`, `activity_tags=["tbd"]`, `requirements_text="prep work"`. The exact case that motivated this rethink.
- Volunteer "yes" on a window opp → `mode="clarify"` asking which day
- Volunteer "YES WED" on a window opp → `mode="confirm"` for `claim_opportunity` with `scheduled_for_at` resolved, status=PROPOSED
- Volunteer "YES MON, WED" on a window opp → two PROPOSED claims, one per day

New ADVERSARIAL cases:
- Window opp that's "Mon–Fri" with `headcount_needed=2`; volunteer A claims Wed, volunteer B claims Wed too. Both become PROPOSED. Farmer accepts both. `seats_filled` increments to 2 across any combination of days.
- "anytime" reply to a time clarify → re-clarify as bucket multiple choice, NOT accept as a value
- "I need help soon" — MVD-vacant inbound — produces a focused clarify, not a stab at a confirm
- "tomato harvest next week" + reply "anytime" + reply "anytime" — three-round MVD push, lands at default `morning` + admin-flagged on round 3
- Farmer declines a proposal → volunteer gets a non-blaming "the farmer can't host you that day" SMS with the offer to try a different day
- Window opp with farmer-approval gate: farmer doesn't respond within 4h → auto-confirm fires; farmer gets the after-the-fact notification with DROP path

### Migration

`window_end_at` and `scheduled_for_at` are both `None`-default optional fields, so existing docs stay readable without backfill. Window-aware code paths gate on `window_end_at is not None`; single-day paths remain the default.

### Estimated scope

| Layer | Effort |
|---|---|
| Model: `window_end_at`, `time_of_day_bucket`, `headcount_open` on opp; `scheduled_for_at` on claim; `ClaimStatus.PROPOSED` | 2h |
| Parser + new MVD-aware `compute_missing_fields` (returns axis names, not field names) | 2h |
| Agent prompt: persona rewrite + Time vocabulary + MVD examples + window examples | 4h |
| Action schema (`window_end_at`, `time_of_day_bucket`, `headcount_open`, new `farmer_decide_on_proposal`) | 2h |
| Outreach copy: window variant + bucket rendering + open-headcount phrasing | 2h |
| Hotkey parser: `YES <day>`, `YES MON,WED`, `ACCEPT <token>` / `DECLINE <token>` for farmer-approval gate | 3h |
| Claim flow: PROPOSED state, farmer-approval send, auto-confirm timer, per-claim `scheduled_for_at` | 4h |
| Confirmation tick: read per-claim `scheduled_for_at`; skip PROPOSED claims | 1h |
| Post-event tick: sidecar collection per (opp, date) | 3h |
| New tick: `tick_proposals` (every 15 min) for the auto-confirm fallback | 1h |
| Admin SPA: window display, per-day fill, PROPOSED-pending count | 3h |
| Tests: unit + ~12 new eval cases | 5h |
| **Total** | **~32h** (~4 dev days) |

That's a bigger chunk than the original estimate — the MVD work and the farmer-approval gate roughly doubled scope. Bug A is *the* canonical fuzz axis for farmer posts; doing it well unblocks the rest of the architecture rethink because the patterns generalize (window over time → window over activities, window over destinations, etc.).

## What to revisit in the prompt's hard rules

Independent of multi-day windows, the prompt has accumulated tension that the persona change would let us reduce:

### Tension 1: "Default to asking" vs "you have wide latitude"

Rule 0 says default to asking. The scope section says you have wide latitude to handle complex things. In practice, "default to asking" wins almost all close calls today, which produces over-clarifying behavior (the round-2 prep-work loop is an instance — the prompt already had the right rule for round-2 acceptance, but the agent reached for "ask again" by default).

**Madison framing resolves this:** Madison wouldn't ask twice on the same axis. Madison would absorb fuzziness and act on it. We can keep Rule 0 for genuinely ambiguous cases (`yes` after a clarify about time = still ambiguous = still clarify) but rewrite it as "Default to *resolving*, not to *asking*. When you can resolve fuzziness with a structural concept the system supports (`tbd`, `flexible`, a window post, a verbatim `requirements_text` capture), prefer that over a clarify. When you genuinely can't resolve, ask once."

### Tension 2: Hard list of escalation triggers vs "trust the flows"

The escalation triggers are specific and narrow (injury, payment, etc.). The "what is not an escalation" list is broader and looser ("scheduling complexity, ambiguity, plan changes"). Today the agent sometimes flags ambiguity as escalation anyway, especially after the clarify cap hits.

**Madison framing resolves this:** Madison knows when to bring Max in. The list of triggers is still the hard floor, but the framing changes from "escalate ONLY when one of these triggers" to "escalate when Max is the only person who can help — these triggers are the canonical examples, plus any case where the system's flows genuinely don't have a path forward." That broadens the latitude slightly while keeping the safety net.

### Tension 3: "Never fabricate" vs "you have to fill optional fields"

Today's prompt says never fabricate, but also tells the agent to apply farm defaults to optional fields. The line between "applying a hint the system gave you" and "fabricating" is exactly where smaller models drift.

**Persona framing helps but doesn't fully resolve:** Madison knows the farm's `typical_start_hour`, sure, but Madison also knows she shouldn't put words in the farmer's mouth. The cleaner fix is a code change: stop pushing defaults through the parser at all and instead show the agent the defaults as *suggestions for the readback prose* — "Start at 9am? (their usual)". The defaults inform the question, not the answer. (This is bigger than this doc; flagging it as a follow-up.)

### Tension 4: The hard-coded forbidden-edge list (headcount-down hard block, etc.)

Today the prompt lists specific hard blocks inline ("if new headcount < seats_filled, you are FORBIDDEN from emitting confirm"). These are real invariants that should be in code, not prose. The model occasionally pattern-matches the rule and still emits the forbidden action; the dispatch layer doesn't always have a backstop for every prose-rule.

**Action:** audit the prose-only invariants in agent.md, add code-level backstops for any that don't have one, and remove the redundant prose where the code now enforces. Keeps the prompt shorter and the safety stricter.

## Implementation plan

Two stages, in order:

### Stage 1 — multi-day window posts (Bug A)

End-to-end implementation per the section above. Self-contained. ~2.5 dev days. Eval cases added; live eval re-run before merge.

### Stage 2 — agent persona + prompt rationalization

After Stage 1, rewrite `agent.md`:

1. New opening: "You are Madison, a part-time paid employee of the Vashon Island Growers Association..." (drop "the coordinator agent for Farm Friend Vashon" framing).
2. Rule 0 rewrite: "Default to resolving, not to asking" (per Tension 1).
3. Escalation triggers rewrite: keep the hard list, change the surrounding language (per Tension 2).
4. Remove prose-only invariants that now have code backstops (per Tension 4).
5. Re-run the live eval; expect some movement in ADVERSARIAL cases that depended on the old default-to-clarify bias. Tune until pass-rate matches the pre-rewrite baseline.

Stage 2 is mostly a prompt change with no code; ~1 dev day plus eval-tuning time. The risk is regression in the test cases that were tuned to the current voice — budget a second pass on cases that need updating to the new framing.

## Non-goals (for this rethink)

- No move away from one LLM call per inbound. The unified-agent invariant stands.
- No new agent actions beyond what's listed in the schema section. Volunteer-side date offers (`record_offer.latest_at` etc.) already cover the symmetric volunteer case.
- No model-provider change (Llama 3.3 70B on DeepInfra is the default; Sonnet 4.6 fallback preserved).
- No new admin tabs or surfaces.
- No public signup or web portal changes.

## Open questions

1. **Window opps and the broader-pool tier.** Today outreach starts with insiders, escalates to the broader pool after a timeout. Should a window opp pace differently? (Probably yes — a 5-day window has more headroom than a 24h-out single-day, so the insider tier could hold longer.) Punt to implementation; default to existing pacing and revisit if needed.
2. **Days-of-week vs date-range as the canonical window shape.** "Any weekday" and "Mon–Fri" feel like the same intent but compute differently across week boundaries. Start with date-range (`window_end_at` is a datetime); add days-of-week (`window_days: list[int]`) only if real usage shows the gap.
3. **Headcount semantics on windows.** Total-seats-across-the-window is the proposed default. If a farmer says "2 people every day Mon–Fri" we'd want them to be able to express that distinctly. Punt: in Stage 1, the farmer phrases it that way and the agent posts 5 separate opps (or one with a `headcount_per_day` extension). Pick when we see real usage.
4. **Tone signals for the dial-2 calibration.** "Calibrating the herd" relies on Madison reading the farmer's tone (terse vs receptive, fast vs slow replies). What signals from CONTEXT actually flow into the prompt for that? `recent_message_excerpts` already give the agent the farmer's writing style; we may want to add a per-user `interaction_history_summary` (free text, ~200 chars, written by Madison herself after each completed dialog) so subsequent turns inherit the read. Defer to Stage 2 — the persona rewrite is the natural place for it.
5. **Auto-confirm window for proposals — right defaults?** 4h / 1h is a guess. Farmers texting from a tractor at 7am might miss a proposal until lunch. Track in admin metrics; tune from real data.
