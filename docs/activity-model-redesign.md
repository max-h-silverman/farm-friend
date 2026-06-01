# Design note: activity model redesign (purpose + free-text detail)

**Status:** IMPLEMENTED (2026-05-31). Shipped per the trimmed scope below: kept
`kind` untouched, added `purpose` (default `farm_help`) + free-text
`activity_detail`, replaced activity-slug muting with `purpose` muting, deleted
`CANONICAL_ACTIVITIES` / the `tbd`/`flexible` machinery, and rewrote the prompt's
activity section. 272 unit tests + 63 stub-eval cases green. The original plan is
preserved below for the record.

**Two product decisions (2026-05-31), each enforced as a deterministic guard
because the 24B model follows prose unreliably (`tests/test_activity_guards.py`):**
- *A bare crop name is still not an activity.* The over-confirm backstop
  (`_agent_overconfirm_reason`, the re-purposed Signal 2b) downgrades a
  `create_opportunity` confirm to clarify when the inbound names a crop and no
  work word. `_CROP_WORDS` is intentionally non-comprehensive — a best-effort
  backstop, not a crop registry (the prompt clarify + confirm readback + UNDO are
  the real defenses).
- *Vague-openness offers are open-to-anything.* `_normalize_offer_activity_detail`
  collapses "physical work" / "anything" / "help out" to an empty
  `activity_detail` so the matcher treats the volunteer as flexible.

**Live eval (`mistral-deepinfra`):** the redesign fixed its target failures —
`adv.unknown_activity_slug` (was a hard 3/3 failure; now passes by construction),
`reg.farmer.post.crop_name_no_activity`, and `new.vol.offer.flexible_phys_work`
all pass deterministically. The remaining ~6 live failures are pre-existing and
unrelated: the over-confirm-on-ambiguous-*reply* cases (`adv.clarify_cap.*`,
`adv.window.bucket_only`, `adv.affirmative_after_clarify`) and one flaky
well-formed-post case — all model non-determinism, not activity-vocabulary
issues. Those remain the open question for the model decision (Mistral + more
backstops vs. another provider).

## Why

The current model forces every shift's work-type into a closed list of 8
canonical slugs (`CANONICAL_ACTIVITIES`) plus the asymmetric `tbd`/`flexible`.
Two problems:

1. **It causes the over-confirm failures.** A 24B open-weight model can't
   reliably decide "is this activity canonical, or do I clarify/flag?" — so it
   over-confirms on `mushroom foraging`, `inoc shitake logs`, etc. The closed
   list is the *source* of that judgment call. Free text removes the judgment.
2. **`gleaning` is mis-modeled.** It sits in `activity_tags` as if it were a
   work-type, but gleaning is a *purpose* (food-access / waste reduction), not a
   kind of work — a gleaning job can be hands-on harvest OR a pickup. The list
   flattens a "why" into the "what."

This redesign: keep the load-bearing `kind` axis untouched, add an orthogonal
`purpose`, and replace the closed activity list with free text.

## What is NOT changing (deliberately)

- **`kind: "shift" | "pickup"` stays exactly as-is.** It is the real
  behavioral axis (39 branch sites across 12 files: outreach pacing, lead
  times, single-claim race, vehicle, post-event flow). The earlier proposal's
  `action_mode` (`hands_on_help` | `pickup_transport`) is a 1:1 duplicate of
  `kind` — renaming it pre-pilot is pure risk for zero behavioral gain.
  **Not doing it.**
- **No dual-axis muting.** `action_mode`-based muting ("stop pickups") is
  speculative at 2–5 farms. Deferred.

## The change (three pieces)

### 1. Data model (`app/repos/models.py`)

Add to `OpportunityDoc`:
```python
purpose: Literal["gleaning", "farm_help"] = "farm_help"   # why the opp exists
activity_detail: str = ""   # free-text specifics, display-cased
```
- `purpose` defaults to `farm_help` so legacy/unspecified opps are valid.
- `activity_detail` replaces the *role* `activity_tags` played for shifts. Keep
  the verbatim text the user wrote; the agent returns a display-cased form
  ("Inoculate Shiitake Logs").

`OfferDoc`: same treatment — add `purpose` (optional), and `activity_detail`
free text. Its existing `note` already captures verbatim; `activity_detail`
becomes the cleaned label.

**`activity_tags` field:** keep the column for now (don't drop a field mid-flight
to avoid a hard migration), but it is no longer the source of truth and no longer
constrained to a canonical list. Mark it deprecated in a comment; remove
post-pilot once nothing reads it.

**`CANONICAL_ACTIVITIES`:** delete the constant and all imports. The only
behavioral reader is the `STOP {activity}` hotkey (see §3) and the over-confirm
backstop (see §4) — both change.

### 2. Mute / routing (`app/repos/models.py`, `mutes_repo.py`, `outreach.py`, `hotkeys.py`)

- Add `PURPOSE = "purpose"` to `MuteDimension`.
- `mutes_repo.is_muted(...)`: add a `purpose` param; match
  `MuteDimension.PURPOSE` against the opp's `purpose`.
- `outreach.py:211`: today `activity = opp.activity_tags[0]`. Change the mute
  check to pass `purpose=opp.purpose` (and keep farm muting unchanged). Activity
  is no longer a routing key — `purpose` is.
- `hotkeys.py` `STOP {x}`: today it matches `x` against `CANONICAL_ACTIVITIES`.
  Change to match against the two purposes + their plain-language synonyms:
  - `STOP gleaning` / `STOP food access` → mute `purpose=gleaning`
  - `STOP farm help` / `STOP farm work` → mute `purpose=farm_help`
  - `STOP {farm name}` → unchanged (farm mute).
  Drop activity-slug matching. (User-facing language stays simple, per the
  coordinator: "mute gleaning / food-access", "mute general farm help", "mute a
  specific farm".)

### 3. Agent prompt (`app/prompts/agent.md`)

Net **deletion**. Remove:
- The "Activity vocabulary" / canonical-slugs section.
- The `tbd` / `flexible` asymmetry rules.
- The round-1/round-2 activity-clarify decision trees.
- The Rule-0 worked examples about mapping/flagging unknown activities.

Replace with a short rule: a shift has a `purpose` (gleaning vs farm_help — infer
from context, default farm_help, ask only if genuinely unclear) and a free-text
`activity_detail` (capture what the farmer said, display-cased; never invent
one). No "unknown activity" concept exists anymore — there is nothing to flag.

`ParsedOpportunity` (`parser.py`): `REQUIRED_SHIFT_FIELDS` changes `activity` →
the activity axis is satisfied by **non-empty `activity_detail`** (any text),
not by a canonical slug. `compute_missing_fields` updated accordingly. `purpose`
is not required (defaults).

### 4. Over-confirm backstop (`message_dispatch.py`)

Delete **Signal 2b** (`activity_tags populated with a canonical slug but inbound
has no activity word`). It exists only to police the canonical list; with free
text there's no such error. Signals 1 (parse_notes self-report), 2a (clock-time
from nothing), and 3 (missing required axis) stay — they're still valid. This
also removes one of the cases the model kept failing, because the failure is no
longer defined.

## Migration of existing data

Pilot Firestore has only test/seed data (per `next-steps.md`: Test Farm/Farmer/
Volunteer + two opps). No production users yet. So:
- **No backfill script needed for real data.** New fields default safely
  (`purpose="farm_help"`, `activity_detail=""`).
- The seed/smoke scripts (`scripts/seed_smoke_test.py`, `seed_test_data.py`)
  set `activity_tags`; update them to set `purpose` + `activity_detail` instead
  (or in addition). Low effort.
- Legacy opps without the new fields read fine via the Pydantic defaults.

If real data existed, the backfill would be: `activity_tags=["gleaning"]` →
`purpose="gleaning"`; everything else → `purpose="farm_help"`,
`activity_detail = title_case(join(activity_tags))`. Trivial, but unnecessary now.

## Eval impact

- Cases keyed on canonical-slug behavior change meaning. Affected:
  `adv.unknown_activity_slug` (no longer a failure — "mushroom foraging" is now
  valid free text → expect `confirm` with `activity_detail="Mushroom Foraging"`),
  and any case asserting `activity_tags=["tbd"]` / `["flexible"]`.
- Rewrite those cases to assert the new shape (`purpose` + `activity_detail`).
- Net expectation: the over-confirm-on-activity failures **resolve by
  construction**, which should lift ADVERSARIAL toward the bar without a model
  change. Re-run `--live` after.

## Title-casing (`activity_detail` presentation)

Pilot: simple deterministic `str.title()` with a tiny guard for common all-caps
words is enough ("inoc shitake logs" → "Inoc Shitake Logs"). The agent can also
return a cleaned form directly (it already reads the message). **Spelling
expansion** ("inoc"→"inoculate", "shitake"→"shiitake") is **deferred** — a
post-pilot polish via a small synonym map or a trusted stronger model; not worth
the risk now.

## Out of scope / deferred (post-pilot)

- `action_mode` as a distinct axis (it's `kind`).
- `action_mode` / pickup-vs-handson muting.
- Spelling normalization of `activity_detail`.
- Volunteer-facing `purpose`-preference UI beyond STOP keywords.
- Dropping the deprecated `activity_tags` field (after nothing reads it).

## Risk assessment

- **Low blast radius on behavior.** `kind` (the load-bearing axis) is untouched.
  The change concentrates in: model fields, one mute path, the hotkey activity
  match, the parser required-field check, the backstop signal, and the prompt.
- **Net code/prompt reduction**, not addition — we delete the canonical-list
  machinery that caused the failures.
- **Main risk:** the `STOP {activity}` hotkey semantics change — a volunteer who
  texted `STOP weeding` before would now get "I can mute gleaning, farm help, or
  a farm — which?". Acceptable: no real users yet, and the new vocabulary is
  simpler.
- Gate the whole change behind the existing unit suite + a live eval re-run.

## Implementation order (when approved)

1. Models: add `purpose` + `activity_detail`; deprecate `activity_tags`; delete
   `CANONICAL_ACTIVITIES`.
2. Parser: required-field check on `activity_detail`.
3. Mutes + outreach + hotkeys: `PURPOSE` dimension; route/mute by purpose.
4. Backstop: delete Signal 2b.
5. Prompt: delete canonical machinery; add purpose + free-text rule.
6. Copy/display: `activity_detail` (cased) wherever `activity_tags` was rendered.
7. Seed scripts + eval cases.
8. Unit suite green → live eval re-run → record pass rate.
