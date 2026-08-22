# Farm Friend — Session Log

Newest-first, on-demand build history: what was built each session, the decisions and rationale
that aren't obvious from the diff, and what was verified/owed. The **live snapshot** of what's
true/unfinished now lives in [CURRENT_STATE.md](CURRENT_STATE.md); this file is the *why behind
past changes*.

This file keeps the newest ~15 entries; older entries rotate into
[SESSION_LOG_ARCHIVE.md](SESSION_LOG_ARCHIVE.md), which now holds 114. A log too large to open
mid-session defeats its own purpose.

---

## 2026-08-22 (latest) — The embedded admin can write, and Edit details now means the onboarding listing

B-096 and the admin stand pass, merged in PR #139 as `b700944` and deployed to
`web-00093-4rk` / `worker-00088-8pn`, digest `sha256:42f35c74…`. No migration. Unit **2,504 across
177 files**, integration **1,508 across 111 files**, typecheck, lint, and production web build green.
Max approved release without rendered browser inspection after browser automation could not connect.

The admin origin guard remains a CSRF boundary: it admits the app origin and exactly
`https://vigavashon.org`; the administrator `frame-ancestors` policy names the same VIGA host.
Absent, `www`, lookalike, and attacker origins remain refused. Sabotage accepting every origin made
the security test fail, so the check cannot go green by vocabulary alone.

Single-seller stands no longer render their native seller as an arrangement: there is nothing to
pause, close, or remove. Shared stands still show each real seller arrangement and its controls.

Max expanded **Edit details** from the original narrow metadata editor to every onboarding listing
answer: location/privacy, visitability, offering type, season/hours/restocking, usual offerings and
prices, payment methods, Farm Bucks, and description. It edits those facts inline in the existing
profile groups with one Save/Cancel flow. Published live inventory remains read-only; the database
integration test writes a current inventory revision, saves the complete listing, and proves that
revision survives unchanged.

The production build caught the admin client importing its controls through the database package,
which pulled server-only database and crypto code into the browser bundle. The payment-method option
list now has a browser-safe core subpath and the admin wire types are client-owned. The rebuilt bundle
passes. Local setup also verifies the current `sellers` schema instead of the retired `farms` table.

## 2026-08-20 — Payment becomes a fact about the seller, and an eligibility grant gets deleted rather than moved

F-125 plus B-095, merged to `main` and **DEPLOYED** — `web-00092-xxn` / `worker-00087-ccz`, digest
`sha256:245e6a1b…`, migration `0058` applied (Neon at 59). Unit **2,503 across 176 files**,
integration **1,507 across 111 files**, typecheck and lint clean, scripted evals 34/34 and
`evals:live` 43/43 against the real model.

### The shape of the fix

Payment lived on the stand in two places — `sales_location_payment_methods` and the
`farm_bucks_*` column pair — so a seller at three stands stated it three times and could leave
the three disagreeing. It is hers now: `seller_payment_methods` keyed on the seller, plus
`sales_location_payment_method_exclusions` for the case that motivated the override, a hosted
seller whose host cannot take cash.

**The override narrows by SHAPE, not by a guard.** The table names removals, so "this stand adds a
method she does not take" has no representation. That is the difference between a rule code checks
and one the data model makes impossible, and it is why the test asserts the resolved answer is
always a subset rather than asserting that adding is refused.

### The decision that made it smaller

max, asked whether `farm_bucks_eligible` should move too: *"there is no 'eligible'. they either
take it or they don't."* So the grant was **deleted rather than moved**. It had made the old model
three-state — accepts / refuses / never reviewed — which is exactly how five production stands came
to claim acceptance with no grant behind them.

That collapsed a follow-up question: what should the eleven farms with no answer publish? max chose
**accepting**, on the ground that Farm Bucks is near-universal among VIGA farms, so silence is
nobody ticking a box. **The risk was named and accepted**: a wrong `true` sends a customer to an
unattended honor-system stand holding vouchers the farmer will not take. If a farmer reports that,
it is this default and not a defect.

### What inspecting production first was worth

The item warned that a shared stand whose two sellers disagree is a decision rather than a lift.
Measured before writing the migration, it was not: all four shared stands carried only the HOST's
payment statement, the two multi-stand sellers had no statement of their own, and every stand had
an owning seller. The migration was a lift after all — but the same inspection found the thing the
item had *not* anticipated, the five accepted-without-grant rows, which is what turned the
eligibility question from theoretical into concrete.

### Three defects the tests would not have caught, and how each surfaced

- **The generator dropped the data.** `drizzle-kit` emitted create-then-drop with no backfill —
  86 production payment rows destroyed — and stamped a journal `when` sorting *before* its
  predecessor, the documented trap that skips a migration while printing "migrations applied".
  Both repaired by hand.
- **`updateStand` still wrote a dropped column.** Typecheck said zero errors, because these are raw
  SQL strings; only running the integration suite found it. Eleven tests failed on one stale line.
- **A lossy round trip I introduced myself.** The reader initially returned her *narrowed* list
  while the writer replaced her *seller-wide* rows from the same field — so a farmer editing at a
  stand with an exclusion would silently drop that method everywhere else. Caught by reading the
  round trip, not by a failing test. The reader now returns what she states, with the override
  carried separately and read-only.

### Sabotage found a real hole

Removing the seller match from the exclusion join left **every test green**, because no second
seller sold at the host's stand. A host's restriction on one seller would have leaked onto every
co-seller at that stand — telling customers a farm refuses cash it actually takes, invisibly to the
host, whose own card still read correctly. A co-seller case now pins it, and re-sabotage fails.

### B-095 closed as a consequence

The map's seller list had no VIGA Bucks indicator because the fact was not on the seller to show.
Once payment moved it became a render rather than a derivation — one answer per seller, so a seller
at several stands cannot show three different ones. Fernhorn Bakery, hosted-only, has no pin and no
card, so the seller list is the only place that fact can reach a customer at all.

### Verified

Migration dry-run against a copy of the real production rows before it was written, then verified
by effect after applying: 86 rows in, 86 out, none stranded, 3 sellers on a reviewed refusal and 40
on the accepted default — matching the dry run exactly. On the wire afterwards: 33 stands, 25 with
payment methods, 3 refusing; the served map page carries 69 `farmBucksAccepted` values, the B-095
badge, and **zero** occurrences of `farmBucksEligible`. No error-level logs on either revision.

**Not verified:** nothing seen in a browser — the standing pre-go-live gap, and this tranche adds
the seller badge and the reworded payment question to it.

### Filed on the way out: B-096

max reported the embedded console at `vigavashon.org/admin` refusing every save with the
wrong-address message. Located before filing: `isTrustedAdminMutationSource` admits exactly one
origin, so a framed console sends `Origin: https://vigavashon.org` and 403s before any handler
runs. **The guard and the copy are both working as designed** — this is not a regression of the
2026-08-19 labelling fix — which makes it a product decision (may the console be embedded?) rather
than a plumbing bug, and the item records the three options with their consequences.

---

## 2026-08-19 — Two model inventions fixed in code, the Trash gets a screen, and the deploy gate refuses the plan

One session, two backlog items plus a deploy that found a defect nobody had noticed. Unit **2,494
across 175 files** (7 corpus skips), integration **1,494 across 110 files**, typecheck and lint
clean, `evals:live` **7/7 containment** with every group green. Everything merged to `main` and
**DEPLOYED** — `web-00091-dvz` / `worker-00086-n95`, digest `sha256:3057ac40…`, migration `0057`
applied (Neon at 58).

### B-092 — the model invents, so code decides

A farmer whose stand listed Kale texted "We have kale" and the confirmation came back listing Kale
twice, the second as `- Kale (1)`.

**Reproduced live before fixing, and it was worse than reported.** Eight runs through the real seam:
**8 of 8** returned Kale as an *addition* despite `currentEntries` naming it, and **6 of 8** invented
a quantity — `12` three times, `1` three times. The report anticipated only the `1`. The `12` is the
dangerous one: it publishes a specific false claim about how much a farmer has, where `1` is merely
unreadable. Not variance to be tuned away — the seam note already forbids both behaviours
("additions are items not currently listed", "never invented ones") and the model ignores both.
That is the Golden Rule #6 argument for settling it deterministically.

- `applyInventoryEdits` merges an addition onto a surviving entry sharing its `standItemKey`, which
  **moved from `db` to `core`** so the draft path and `stand_items_one_per_location_name` cannot
  disagree about what "same item" means. The surviving entry keeps its id and published position;
  the addition's stated details merge over it, because "plenty of bok choy at $3" about a listed
  item is a real update. A removed entry is not a merge target.
- `validateInterpretation` drops a quantity from a message that states none, sitting beside the
  existing unauthorized-removal guard and justified the same way.

**The quantity guard was wrong on its first shape, and the live mirror fixture caught it.** It
checked whether the message stated *that number*; the real model read "6 dozen eggs today" as
`quantity: 72` — correct arithmetic over the farmer's own words — and the guard threw it away. The
rule is **PRESENCE, never the value**: reading "6 dozen" as 72 or as 6 is interpretation, which the
model owns; manufacturing a number from a message with none is invention, which it does not. Code
re-deriving the reading would be a second interpreter. A price's digits are excluded, so
"kale, $3" still states no quantity — that case was caught by a unit test after the rewrite.

Three new **containment** fixtures (not quality) drive real model output through both guards to the
rendered draft, because these must hold whatever the brain returns.

### The public contact address

Every user-facing mention became `farmfriend@vigavashon.org` (max): the HELP guide for both
audiences, the farmer onboarding start page, VIGA's three Squarespace copy blocks. Measured that the
longer address costs no SMS segment — 175 chars customer / 167 farmer against a 306-septet budget.

**The carrier-registered HELP body is the one exception and stays `board@`** — it is transcribed
character-for-character from live Telnyx console state, so the console changes first. Filed as
**B-093**; a sender texting HELP today reads both addresses in one exchange.

### F-124 — the Trash gets a screen, and the console loses two controls

Four decisions from max: the Trash is a **shut section below the roster** (mirroring Invites above
it, not a fourth tab); **Farm Bucks stays**; **pause/resume stays**; and the chips collapse to
**one summary carrying two facts** — `Open now · 2 sellers`, `Live · 2 stands`. That last one
replaced a chip row *plus* a separate amber attention line: two parallel mechanisms describing one
record became one. A stand nobody sells at reads `0 sellers`, so the problem states itself.
`Unclaimed` replaces `Live` rather than joining it.

**A defect this work introduced was caught by its own test and never shipped:**
`retirementStatusFor` had no `trashed` case, so the writer succeeded while the route answered
**409** — a stand genuinely trashed while the screen reported a conflict.

Approval and test-farm marking are gone from the console **and the routes**; the integration suite
asserts the *server* refuses all four actions, because a button that merely disappeared while the
endpoint kept working is not a removal. `test-farms.tsx` was dead surface kept alive only by its own
test — both deleted.

**Rendering the screen and reading its markup found what tests did not**: a copy error
("Everything these kept"). Tests assert what you thought to assert; looking at the output does not.

### The deploy plan was REFUSED, and the gate was right

`plan-assertions.py` failed **7 checks** on the first plan. F-123 had needed the worker to send the
flag alert and gave it credentials by mounting the whole of `local.web_secret_env` — which also
handed a mail-sending process `ADMIN_PASSWORD_HASH`, the **billed** `GEOCODING_API_KEY`, and
F-079's three salts.

The two `worker never mounts GMAIL_OAUTH_*` assertions were the other half of the same mistake:
F-123 inverted the *sender address* check and left these standing, so the plan was **internally
contradictory** — the worker told where to send from and forbidden the credential to send with. It
sat on `main` undeployed until the first plan refused it.

`local.email_secret_env` now holds exactly the email credentials and both services mount it;
everything web-only stays in `web_secret_env`. The two assertions became "only when the web service
does too", which catches asymmetry the old check could not distinguish from the real violation.
`SMTP_PASSWORD` stays unconditionally forbidden — it is the alternative provider, and one service
holding a credential for a provider it is not using means the two disagree about which is
configured. Sabotage-proved both directions.

**What the old assertions protected was not abandoned** — it moved up a level into
`email_secret_env`, and the five unconditional checks still enforce it.

### F-123 verified by effect in production

Not by the deploy's report. Both pre-existing flags were claimed and alerted **within seconds** of
the new revision starting (`alerted_at` 05:52:05 and 05:52:06), and **a second recovery pass left
both timestamps byte-identical** — the once-only claim holds under a real re-run, not just under
test contention. Two emails reached `farmfriend@vigavashon.org`; both flags were already
dismissed/resolved, expected for a first pass over a backlog.

The migration was verified by effect too, not by "migrations applied": 57 → 58, `flags.alerted_at`
present as nullable `timestamptz`, row counts untouched. The target was fingerprinted first
(`neondb`, 43 sellers / 39 stands) so a mistyped string would have failed loudly.

### B-078, characterised further

Integration flapped repeatedly on unchanged trees: `4 failed | 106 passed` files, then
`8 failed | 102 passed` naming an **entirely different set**, while **all 1,494 tests passed both
times**. A single named failure (`latency.integration.test.ts`) passed in isolation and across two
reruns. The signature is now well established: **file-level failures with no failing test, moving
between runs.** The standing rule holds — a *named* failing test is real until shown otherwise; a
failure that moves on an unchanged tree is the harness.

### Filed rather than left silent

- **B-093** — the carrier HELP body still names `board@`; Telnyx console changes first.
- **B-094** — removing the approval toggle left `revokeFarmApproval` with **no production caller**,
  so an approval can no longer be reversed. The accepted consequence of max's decision, not a
  regression. The writer is kept deliberately: deleting it would leave the `not_approved` branch
  permanently unreachable.
- **B-095** — the "does not take VIGA Bucks" indicator is missing from the map's seller list
  (max, found by use). `seller-list.ts` has no reference to it at all. The real question is what
  the indicator *means* for a seller who sells at several stands with different answers.

**Owed:** a browser pass at phone width on F-124's summary line and Trash section. The markup was
rendered and read in jsdom; no pixel has been looked at.

### At wrap: payment turns out to be modelled on the wrong thing

max reported the "does not take VIGA Bucks" indicator missing from the map's seller list
(**B-095**). Locating it raised the design question — what should it say for a seller selling at
several stands that disagree? — and his answer moved the ground: **payment is a fact about the
SELLER**, and more than VIGA Bucks. All of it. With a **stand-level override that only NARROWS**,
for a hosted seller whose host cannot support cash.

Filed as **F-125**. Today both halves live on `sales_locations` — the methods in
`sales_location_payment_methods`, VIGA Bucks as `farm_bucks_accepted` / `farm_bucks_eligible` —
which asks a farmer the same question once per stand and lets her answers disagree. It touches ~20
non-test files plus the two doors where a farmer actually states it: onboarding's listing step and
the farmer settings screen. A seller onboarding her second stand is asked again today; a seller at
three stands has to change it three times.

B-095 is now a **symptom** of it, kept as its own item only because it is the customer-facing edge
that proves F-125 got all the way out rather than stopping at the schema. **Do not derive a
seller's answer from her stands** — that is the second mechanism F-125 exists to remove.

Left open deliberately: whether `farm_bucks_eligible` moves too. It is VIGA's grant rather than the
farmer's claim, so it is a different authority and gets reasoned about separately, not swept along.

## 2026-08-19 — The console loses three screens, production gains an alert, and a fix ships broken

Four tranches across one long session. Unit **2,468 across 176 files** (7 corpus skips), integration
**1,489 across 110 files**, typecheck and lint clean. **Two production deploys** (`web-00089-vz7`,
then `web-00090-qwk`) plus three migrations applied to Neon. F-122 and its follow-up are merged and
live; **F-123 is merged and NOT deployed**, migration `0057` unapplied — max chose merge-only.

**Delete became trash, because max changed the requirement mid-build.** He had chosen "off the map,
plus a real delete" that morning; asked again after I measured what a hard DELETE actually hits — a
`RESTRICT` closure of eleven tables directly and nine more through `stand_providers` — he revised it
to trash. So a trashed stand or seller leaves the roster and comes back, and **nothing in the console
destroys anything**. "Empty the trash" is deliberately unbuilt: it is where that whole closure has to
be answered, and that is its own piece of work.

Trash is a THIRD state rather than a rename of retirement, and two constraints are what make it
safe to read. `trashed_implies_retired` lets public invisibility stay ONE rule over `retired_at`, so
no public read learns a second column; `retired_by_trash` records that trashing CAUSED the
retirement, so a restore undoes only what it created and a stand VIGA had separately taken off the
map stays off. Without that second column a restore has to guess, and it would guess wrong for
exactly the stand somebody deliberately hid. Sabotage-proved three ways: trash-without-retire fails
7 tests, restore-ignoring-the-flag fails precisely the 2 independence tests, roster-not-excluding
fails 1.

**"Questions about our records" was a seeding artifact, and measuring said so.** max did not know
what it was; `stand_data_flags` turns out to be written only by the seeder, for ambiguous
availability text in the original VIGA spreadsheet — four rows in production, all resolved, from the
initial load. Nothing in the running product creates one. Stock-outs left too, but on different
reasoning: a stock-out is a signal about a listing that the FARMER acts on, so customers still
report them and farmers are still texted, and only VIGA's screen went. **The gap that leaves is
recorded rather than glossed**: a report whose farmer cannot be reached was filed "for VIGA review"
and now reaches nobody — eight were open at removal. `listStockOutReports` is kept and carries the
reason, so restoring the screen is a render rather than a rewrite.

**Two production bugs came from reading the logs, and the code reading was wrong both times.**
max's stuck "Waiting for your decision" row: I reasoned from the settle-on-redeem path and was
wrong. Production said the authorization predated the request by a day, so the settle path had
already run and nothing would ever close that row. The queue was asking "is this ticket unsettled?"
when the operator's question is "does this person still need access?" — now answered from the
authorization, scoped to the same farm and to live access, which fixes the rows already stuck as
well as the ones to come.

His "session expired" on Prepare invite was not a session at all. He was on the `*.run.app` host,
`PUBLIC_BASE_URL` is the custom domain, so the origin check refused every write — and **both** 403s
answered a bare `forbidden`, so six screens each guessed the one cause they knew. He signed in three
times against a refusal that had nothing to do with his session. The refusals now name themselves.

**Then that fix shipped and never ran once — the sharpest lesson of the session.**
`refusalFromResponse` took a `Response` and read the body itself. Every caller had already parsed
that body for its own payload, so each reached for `clone()`, and **`clone()` throws on a consumed
body**. The throw landed in each caller's catch, which sets the generic message. max reported it
minutes after the deploy. The unit tests were green throughout, because they exercised the reader
alone and never the caller's real sequence. The fix is the SIGNATURE — status plus already-parsed
payload, so a drained stream cannot be passed — and the new test drives the actual screen's failure
path, reproducing the exact symptom when the old shape is restored. **A helper that takes a
single-use resource invites every caller to misuse it; changing the shape beats a rule about call
order.**

**F-123 would have shipped silently broken for an infrastructure reason no test could see.** The
worker sends the flag alert, and the worker had NO email configuration — the pass would have found
email unconfigured, sent nothing, claimed nothing, and reported success forever. The plan assertion
`the worker is given no email configuration` was asserting the OLD truth, so it is inverted rather
than deleted, and two new assertions fail an apply that leaves the recipient empty or the two
services disagreeing about it. Typecheck caught a second one: `EmailDispatchOutcome` distinguishes
an **ambiguous** send from a definitive rejection, and my first draft retried both — which would
have mailed VIGA the same alert every minute for as long as the relay stayed ambiguous.

**B-078 is now characterised.** A run reported `2 failed | 108 passed` FILES while all 1,489 of its
TESTS passed and the process exited 0; an immediate rerun on the identical tree was 110/110. Two
runs, same commit, different file counts — the harness under parallel load, not the code. Still
unnamed: the summary carried no file names either time, which is the same thing that defeated the
last attempt.

**Smaller decisions.** `Josie's Farm` is marked a test farm through the real writer and verified by
effect (absent from the public map, present with `?hidden=true`) — a live listing with one
authorized handset, deliberately hidden, confirmed at wrap. The farmer link SMS now says what the
link CAN DO ("Anyone with this link can update the listing.") rather than asking for a promise, with
the URL set apart by blank lines; measured at 213 characters against 216 before, so still 2 segments.
That change also folded two hand-written copies of one sentence into one renderer — they had already
drifted — and `farmer-reply-copy.test.ts`'s positive control caught its own anchor going stale,
which is exactly what a positive control is for.

**Owed:** F-123's deploy and migration `0057`; the Trash VIEW (the writers exist, the screen does
not); F-122's remaining removals — approval, test-farm, Farm Bucks, pause/resume, the state chips.

---

## 2026-08-19 — HELP learns to be useful, and a customer can tell VIGA something is wrong

One tranche, `b-091-help-pagination-admin-ux`. Unit **2,439 across 173 files** (7 corpus skips),
integration **1,473 across 108 files**, typecheck, lint, scripted evals 11/11 · 4/4 · 19/19, and
`evals:live` green with a NEW fixture for the new category (below). Six of max's seven asks landed;
the seventh — simplifying the admin console — is deliberately left for the next session as F-122.
Merged to `main` as #137. **Not deployed, and migrations `0054`/`0055` not applied** — max chose to
leave the release for next session, so `main` now runs ahead of production by B-090 and B-091.

**HELP could not be fixed where it lived, so it grew a second half.** The registered body answers a
request for help by naming the word the sender just texted. It is transcribed from live Telnyx
console state and pinned character-for-character, so a code-side rewrite would make live traffic
differ from what the carrier approved. The guidance therefore rides as an ordinary second reply
naming the keywords the reader can actually use, and the two audiences get different lists —
resolved from `farmer_authorizations`, the same source the free-text access fork reads, because a
farmer has no use for "ask what is available" and a customer has none for `LINK`. The customer and
farmer contact addresses are separate constants holding one value today, so giving farmers their own
inbox later is a value change rather than a hunt through copy.

**An em dash cost a whole SMS segment.** The help guide measured three segments while reading as two
lines: one character outside GSM-7 switches the entire body to UCS-2 and drops the budget from 153
septets to 67. The test asserts the property directly rather than importing the segment estimator —
that lives in the `sms` adapter and core must not depend on an adapter, which `architecture.test.ts`
caught immediately. Sabotage-proved by putting the dash back; the failure names the character.

**`Results 4-6 of 12`.** The header said the total twice ("12 matching stands (4-6 of 12)"), and max
cut both the word and the parenthetical. Both forms now share one vocabulary — a windowed page and a
whole answer must not read as two different lists — and it counts RESULTS rather than stands, so the
header stays a claim about the answer's size and never about the entries beneath it, which is the
shape B-049 and B-061 both got wrong.

**Replies name the map keyword instead of carrying its URL.** A link is the most expensive line in a
text thread: it survives no line break and it is what carriers score for spam. `MAP` is a real parsed
command answering with exactly that URL, so the pointer costs one short sentence. Applied to all five
sites — the two result pages max named and the three empty-result replies — from one constant,
because five places closing with the same line and a copy edit reaching four of them is how two ways
to do one thing appear. **Honest cost:** `MAP` is behind the consent gate, so an unconsented sender
now needs a round trip where a raw URL needed none. Flagged and accepted.

**Issue reports: the model proposes, code commits.** Max first asked for the classifier to handle
this automatically. Doing it as asked would have put a model judgement in charge of durable state, so
the shape landed differently: the classifier gained an `issue_report` category that FILES NOTHING —
the report is parked in `pending_issue_reports`, the sender is asked to confirm, and code writes the
flag on their `YES`, into the same queue `FLAG` already fills with a `reason_code` recording how it
arrived. A false positive costs one question rather than a false report in VIGA's queue, and the
property survives a hostile model because the seam still has no channel to a consequence.

**Three things now mean `YES`, and the consequential ones win.** A host's open question, an open
inventory publication, then an issue confirmation — a farmer with a live proposal who texts `YES`
still publishes, exactly as before. Its own table rather than a second meaning for
`pending_stock_out_reports`: that record carries a bound stand and an `awaiting` CHECK proving a
shape an issue report does not have, and one table serving both would need that CHECK relaxed to
admit a row it was written to refuse.

**`YES <email>` is the parser's only argument grammar**, admitted only when the remainder is a single
valid address. `YES` is also the publication token, so a loose remainder would let "YES i have eggs"
publish something unreviewed. This is safe where `JOIN <token>` was not (removed 2026-08-07): a
mistyped 64-hex token failed identically and silently, while a mistyped address is something code can
RECOGNISE as not-an-address, so it falls through to free text and is answered.

**The reply address lives on the FLAG, not on the contact** — scoped to the one issue it was given
for, gone when the flag is. A customer acquires no durable profile by reporting a problem. Raw value
in one column with its hash beside it, both present or both absent by CHECK, masked in the console
and reachable only through a `mailto:` so a screenshot of the review queue leaks nothing.

**A required config value would have crashed the worker.** `EMAIL_HASH_SALT` is mounted on the WEB
service only, behind `mount_email_verification` — and the WORKER runs the inbound pass. Making it
required in shared config typechecked, passed locally, and would have failed to boot the service that
routes SMS. It is optional, and a deployment without it REFUSES the address rather than storing a
value nobody could look up; the reply then promises only that someone will look, because a reply
nobody can send is not a promise worth making.

**Both migrations tripped documented generator traps, exactly as RUNBOOK warns.** `drizzle-kit` emits
no `check()` constraints (four appended by hand) and stamped both journal entries with a wall clock
that sorts BEFORE `0053` — which would have skipped them silently while the runner printed
"migrations applied". The FK was folded back into `0054` rather than shipped as its own migration,
since neither is applied anywhere yet.

**The live evals passed and were not yet evidence.** The existing fixtures cover the classifier's
older operations; none exercised the new category, so a green run said nothing about the change. A
new `live-operation` fixture pairs each issue report against a stock-out that must NOT move — a set
containing only issue reports would pass for a model that called everything an issue — and the real
model takes all 8. Sabotage-proved by asserting "Pinecone Gardens is out of eggs" is an issue report;
the model refuses and the fixture fails.

**Crossing to a seller now brings her card and the map.** Tapping a name under "Also selling here"
switched lists and left the reader's scroll where the stand list had it. The map's follow effect was
written for stands and keyed on the stand selection; both lists render the same card in the same
column, so the behaviour was never stand-specific — only its inputs were. One effect now serves both.
`goToSeller` takes a source, like `select` does: a crossing scrolls, a tap inside the seller list does
not, because that reader is already looking at the card they pressed.

Sabotage-proved this session (seven): the pagination header, the help guide's segment budget, filing
an issue on classification instead of confirmation, filing on a decline, swallowing a mistyped
address as a bare YES, printing the raw address in the console, and the seller-crossing scroll.

---

## 2026-08-19 (earlier) — the classifier's variance turns out to be the two cases we already knew about

One tranche, `b-090-classifier-variance`. Unit **2,418 across 171 files** (7 corpus skips),
typecheck, lint, scripted evals 11/11 · 4/4 · 19/19. Integration not run — this session touches no
database or web code, and `DATABASE_URL`/`PUBLIC_BASE_URL` are not set locally.

**B-090 — measure before tuning, and the measurement said "don't tune".** Twenty `evals:live` runs
against `mistralai/Mistral-Small-24B-Instruct-2501`, each captured to its own file:
**20/20 green, zero FAIL, zero SKIP**, every required group 100% every run. Only two fixtures move,
and both move *only* on the two already-catalogued baseline cases — `"what is viga"` missed 4/20
(corpus 52–53 of 53), `"when do you open?"` missed 11/20 (second-person 4–5 of 5). Roughly 800
classifications, 15 misses, both known phrases, **no third case**. So the previous session's
standing caution overstated the problem: `ADVISORY_CLASSIFIER_CASES` needs no new entry, and the
threshold that entry anticipated is not needed — the corpus holds at the existing gate. That was the
product decision the item reserved for max, and the measurement retired it rather than forcing it.

**The 51/53 did not reproduce, and the 3/5 `live-operation` failure was almost certainly an outage.**
Worst of twenty runs was 52/53. More conclusively, 3/5 is *arithmetically unreachable* from these
misses: the advisory list absorbs both, so neither can drop that group below 5/5 no matter how the
model flaps. That run predates B-089's `couldNotRun` labelling — an unlabelled transport failure is
exactly what it would have looked like, and it explains why four immediate reruns could not
reproduce it. Filed as explanation, not proof; the original transcript was lost, which is the whole
reason this session captures every run.

**A passing fixture can still be moving — the gap that made the extra tool necessary.** The corpus
fixture gates on "no *non-baseline* regression", so 51/53 and 53/53 are both PASS. A pass/fail tally
across runs would therefore have reported both moving fixtures as perfectly stable and concluded
"no variance", which is precisely the wrong answer. `live-eval-variance.ts` reads each fixture's
*internal score* out of its observed line and reports score movement separately from pass/fail. The
score regexes are anchored to the start of the observed line on purpose: ratios also appear inside
quoted customer messages (`"is 2/3 of a pound ok"`) and JSON payloads, and an unanchored search
reads one of those as the score — sabotage-proved.

**Capture-before-parse is the load-bearing design choice.** `evals/variance.ts` writes each run's
transcript to its own file *before* anything is parsed, so a crash, a Ctrl-C, or a parse bug still
leaves the evidence on disk; an unparseable file is reported loudly by name rather than silently
shrinking the sample. Re-summarise any capture directory for free with
`npx tsx evals/variance.ts --summarise-only --out <dir>`. The 20 transcripts are committed under
`evals/captures/2026-08-19-b090/` as the evidence for the conclusion above.

Sabotage-proved (three, all caught): counting an outage as a miss; reporting an always-failing
fixture as merely flaky; and the unanchored score regex above.

---

## 2026-08-19 (earlier session) — the eval gate learns to tell an outage from a regression, and SMS stops answering strangers

Four tranches, merged as `session-2026-08-18-wrap`. Unit **2,399 across 170 files** (7 corpus
skips), integration **1,463 across 107 files**, typecheck, lint, scripted evals 11/11 · 4/4 · 19/19,
and **live evals 39/39 clean** — which also clears the run owed from B-086/B-087.

**B-089 — a red live-eval run now means the model got worse.** Two independent lies, both fixed by
giving the runner facts it lacked rather than by weakening a fixture. *Transport:* every seam
collapses `provider_error` into its ordinary failure outcome **on purpose** — a sender who could not
be understood is owed the same honest reply either way — so a DeepInfra 502 surfaced as ten fixtures
returning `{"kind":"unclear"}`, indistinguishable on screen from a quality regression.
`createTransportObserver` counts throws out of `generateJson` at the provider, the last place the
difference survives; a fixture whose call never landed is `couldNotRun`, neither pass nor fail, and
the run exits 2 saying "N fixtures could not run". A genuine failure always outranks an outage, so
an outage can never launder a real regression into "inconclusive"; a fixture that *passed* through a
dead provider still passes, because a barrier holding against no answer is what containment asserts.
Proved by effect against a real 502 through the real adapter.

*The flapping fixture was a **contradiction**, not model variance.* `"when do you open"` was graded
by two fixtures in the same required group — the top-level corpus scored it advisory (max relabelled
it 2026-08-13: in an SMS thread with the service, "you" reads as the service) while the second-person
fixture failed the run on it. Identical code therefore scored 4/5 or 5/5. `classifier-baseline.ts`
makes that one shared, tested list; the case is kept and still printed. Confirmed on a live run that
*missed* it: the corpus reported 51/53 "known baseline miss only" and passed, where the old code
would have gone red.

**Standing caution — SUPERSEDED by B-090 later the same day.** This entry recorded that the corpus
scored both 51/53 and 53/53 across ~10 uncaptured runs and concluded the model "flaps beyond the two
catalogued cases". Twenty captured runs showed otherwise: only the two catalogued cases ever miss,
and the 51/53 never reproduced. The instruction it gave was still the right one — *measure before
tuning* — and the measurement is what retired the caution. See the B-090 entry above.

**F-119 — the stand card is seller-major.** `standCardSellerGroups` replaces `standCardSections`
(deleted, with its CSS): the seller is a sub-heading carrying its own recency, its items bordered
cards in a responsive grid. Presentation over data the card already received. **The tradeoff is
deliberate:** seller-major cannot keep F-114's "each item appears once" — two sellers carrying eggs
means eggs appears under each, and each copy carries that seller's own price under that seller's own
freshness, which is the comparison the mockup exists to offer. B-088 holds and is decided **per
section**, not per stand; F-118 holds — the sub-heading is still a link. max re-attached the mockup,
which settled two things the transcription could not: the heading is **`Usually carries`**, and
price is never a bare `$4` (the corpus holds `$6/dozen`, `$5 a bunch`, `$1.50/lb`, `$180 half` and
one phone number; the local stand renders `$8/dozen` and `$4/lb`). Measured in a browser at real
356px and 386px: no horizontal overflow, grid reflows 3→1, a 34-character unbroken name stays inside
its card. Computed styles confirm the cards are surfaces, not the old pills — `.items li` (0,1,1)
beat a bare class once before, and only a running-page read sees that.

**F-120 — answer more of the question before answering it fresher.** `matchCount` is now
`rankCandidates`' first key. Measured live: "any stands have kale and eggs?" led with a stand
carrying eggs, putting the stand carrying **both** second, because its evidence was a few hours
fresher inside the same day. **Broad is deliberately exempt** — it selects the whole catalog as its
"requested names", so counting there would rank by listing size, a leaderboard answering a question
that named no item. No new query: `groupSelectableStands` already deduplicates matched items by
name. Every ordering fixture puts the higher-match-count stand at the **older** timestamp, so a
dropped key fails rather than passing by coincidence.

**F-121 — Farm Friend answers nothing substantive until the sender has agreed (max).** Began as
"what does a pre-joined customer who texts without JOIN get?" Measured first: they were answered
normally, because `inquiry_reply` rides on the sender's own inbound message and needs no consent
basis. max's call reversed that — consent comes before service. A sender with **no consent record**
gets one invitation naming `JOIN` *instead of* their answer; a sender who **opted out** gets nothing,
because inviting someone back who texted `STOP` is what `STOP` exists to end.

**The exemption list is the routing ORDER**, not a second list: the gate sits directly below the
compliance branch, so the carrier-registered keywords pass by construction. Two would dead-end a
journey if gated — `VIGA` completes farmer onboarding from a handset with no consent row yet (gated,
the farmer is told to reply `JOIN`, which can never complete onboarding), and every `STOP` synonym
must reach the opt-out writer. Everything else gates, **`MAP` included** (max named it): the map is a
service, not a control for joining or leaving. So MAP moved below both the staleness guard and the
gate and **lost its delayed-event exemption** — a stale MAP now fails closed. No model runs for a
sender who has not agreed, which is stricter than the routing order alone gave.

*Why intent-matching was rejected:* measured against the live model, "sign up", "signup",
"subscribe", "sign me up", "add me to the list" and "i want to join" all classify `unclear`, while
"how do i sign up" and "how do i get updates" classify `system_inquiry`. Wording-matching would have
missed half; the consent row cannot. *Two defects found in my own work, both by a test:* the gate
first sat **above** the staleness guard, so a stale event replied instead of failing closed; and
nothing caught a stopped sender being invited — sabotage showed that assertion sat in the MAP test,
which returns before reaching the invite branch. Existing suites got real fixtures rather than
adjusted expectations.

**Also measured, then dropped:** a branch proving a cold sender's answer actually *dispatches*
(`inquiry_reply` and `required_reply` are the only categories that send with no consent row). F-121
deliberately removed that behaviour, so the branch was deleted unmerged rather than landing a test
we knowingly invalidate — F-121 carries the equivalent guarantee for the invitation itself.

**Farmer consequence, accepted:** an authorized farmer with no consent row is gated out of `LINK`,
`STAND`, `SETTINGS` and publishing `YES` until they text one of the five keywords. Normal onboarding
establishes consent via `VIGA`, so the ordinary path is unaffected.

**Deployed** 2026-08-19 as **`farm-friend-web-00088-8cw` / `farm-friend-worker-00083-28n`**, digest
`sha256:bfbc1bc0…e4e4`, from `d9d0f6c`. Plan was 0 add / 2 change / 0 destroy — only the digest moved
— with 61/61 plan assertions, deploy assertions and served-card assertions all passing. F-119
confirmed in the shipped bundles (`items-cards`, `item-card-price`, `seller-block-heading` present;
`items-nested` and `item-sellers` gone).

**Owed:** no message has been read on a real handset — the F-121 invitation copy included — and the
F-119 card has not been seen on a phone. F-121 could not be exercised against production without
sending real texts, so it ships verified by integration only.

## 2026-08-18 — the queue ships, then five defects max found by using it

Five deploys in one day, from a standing start of twelve unapplied migrations. Ends with
`ac90972` serving as **`farm-friend-web-00087-vt6` / `farm-friend-worker-00082-j8q`**, digest
`sha256:79be6918…af79` — the last carrying only the heading rename, verified in the shipped bundle
(`Also selling here` present, `Who sells here` absent). Unit **2,367 across 167 files** (7 corpus skips), integration
**1,445 across 107 files**, typecheck, lint, scripted evals 11/11 · 4/4 · 19/19.
**Live evals owed** — DeepInfra returned `502 Bad Gateway` to every call during the wrap; max's
call was to ship and file it (B-089).

### The release: migrations 0042–0053, then the four merged tranches

Preflight was treated as live evidence, and it matched the record exactly: 42 applied migrations,
serving digest `14347f34…`, no `sellers`/`stand_providers`/`own_seller_id`. The one thing worth
measuring beforehand was `0042`'s riskiest claim — that every row can find a provider. Against the
real corpus: **zero unbackfillable rows across all seven tables** (250 stand items, 34 revisions,
19 proposals, 17 links, 15 preferences, 9 prompts, 0 menu options), no farm owning two stands, no
NULL `owner_farm_id`.

Applied on the direct Neon URL and verified BY EFFECT: ledger 42 → 54, `stand_providers`
backfilled to 38, all seven `provider_id` columns NOT NULL and fully attributed, `0051`'s partial
index carrying the exact predicate `hosting.ts`'s `ON CONFLICT` names, and **`0052`'s enum value
proved WRITABLE in a statement after the migration** — a clean apply proves nothing there.

**One correction to the record.** `inventory_publication_proposals.provider_id` is nullable in
production and that is *correct*: `0042` sets it NOT NULL and **`0046` deliberately relaxes it**
so a venue's closure-only proposal can name no provider, replacing it with the
`inventory_proposals_provider_arm` CHECK — probed live, it refuses `has_inventory` with no
provider, by name. A preflight assertion reading the bare nullability reports a false failure.
Integration was also re-measured at **1,441/1,441 across all 107 files**, not the recorded
1,435/106: the six failures were the missing `PUBLIC_BASE_URL` and nothing else.

### Five defects, all found by max using the deployed product

Each was measured against production before it was touched.

**B-083 — seller cards claimed closures no farmer had made.** `sellerIsOpenNow` reduced a
**seven-member** `OpenState` union to a boolean by testing `=== "open"`, so `unknown` and
`by_appointment` printed "Closed". Measured on the live payload: **9 of 34 seller cards** were
asserting a closure nobody declared. The stand list beside it already held the right rule
(`map-view.ts` §the open-now filter). Three states now — max's rule: *Closed is reserved for out
of season or outside defined hours* — and the closed set moved to `isDefinitelyShut`, read by both
readers, written as the set of things that ARE closed rather than "not open". **That polarity is
the bug**: a state a later author adds now defaults to unknown.

**B-084 — the admin card contradicted itself.** Lavender Hill showed "Not open — out of season"
above "Stand is open". Both were true: her season ended 8/1, her *arrangement* is active. Two
different facts in one vocabulary. The control now names only the arrangement.

**B-085 — Morgan Hill's four "also selling here" names vanished.** F-118 made the typed list a
fallback suppressed by *any* modelled seller, and `0042` then gave **every** stand a self-pointer,
making that condition true everywhere. One native row hid four names and replaced none, because a
self-pointer is never an item credit. The fallback now counts **guests** — which is what the rule's
own comment always meant. This also reversed B-084's over-correction: dropping the seller's name
from a solo row left "Who sells here" answered by a bare "Selling here".

**B-087 (critical) — nine stands invisible to a direct question.** `who has eggs?` returned **one**
stand while ten were listing eggs. Every component checked out in isolation — the model returned
`["eggs","duck eggs","chicken eggs"]`, retrieval returned all ten rows. The defect was between
them: the **catalog** is built from `listPublicStands`, which drops the items of any confirmation
past 28 days, while the answer is **filtered** from `retrieveSmsListings`, which applies no such
filter. A stand 29 days stale contributed no catalog value, and **the model cannot select a value
it was never shown** — unreachable by name, not merely ranked last. Catalog now built from the
same rows the answer is filtered from.

**B-086 — category matches presented as equals.** `who has kale?` returned eleven stands, one with
kale: the matcher had expanded up a generality ladder (kale → leafy greens → produce) and back
down its other rungs. **The expansion is correct and F-045 requires it**, so the fix is
presentational (max's call): exact matches first, the rest under `Other stands with <category>:`.
`sortMatchesByExactness` is pure code — no model, no taxonomy, category named from the matched
catalog values themselves.

**B-088 — two display facts repeated or shrunk away.** Per-item recency printed the section
heading's own phrase on every line (**33 of 37 public stands have one seller**); it now appears
only where the sellers on that item disagree — keyed on *agreement*, not seller count, because
three of the remaining four publish on the same day. And the map tooltip is a `foreignObject`, so
its font sizes are viewBox units: **"Runs this stand" measured 6.6px on a 390px phone**, text that
shrank as the screen did. It counter-scales now; raising the CSS numbers would have inflated
desktop by the factor it rescued the phone.

### The data work: hosted sellers resolved, one listing moved

`0042` left eleven typed participant names as display-only history and refused to link them,
because the corpus held `Fernhorn Bakery` at Pacific Crest and `Fern Horn Bakery` at Tian Tian —
one bakery, two spellings, and matching would either merge two stands' relationships or split one
bakery. **max resolved three** (`scripts/resolve-hosted-sellers.ts`): Fernhorn is ONE bakery with
TWO arrangements; Handpicked Homestead was *linked not created*, because she already existed with
a live authorization and her own description places her at Plum Forest; Gracie's Greens is new.
Two sellers and four arrangements written, verified by effect.

**Morgan Hill keeps its self-pointer, permanently.** `0042` called that seller "a row invented to
satisfy NOT NULL". Measured, it is not: VIGA's own description, 17 pooled items, a current
revision, a name byte-identical to the stand's, and four participant rows naming it through a
composite FK with `ON DELETE RESTRICT`. Clearing it would re-root history and orphan real data to
change nothing visible. **max's read is the right one: those four names are decorative, not
operational** — no handset, no seller rows, and 17 items ("vegetables", "duck eggs") no rule could
attribute. Promoting them would have created four identities nobody owns or can update.

**Handpicked Homestead's listing moved to Plum Forest**, where she actually sells. Inventory is
keyed to a `provider_id` — a seller *at a stand* — so there is no seller-only state to move to;
the real answer was that her own stand should not exist. Re-pointing the revisions is **refused by
the database** (`guard_inventory_revision_history` covers `provider_id` since `0042`), and rightly:
those records say she published at *her own stand* on 8/11 and 8/17. So it supersedes and
republishes, as her own update would. **Two constraints corrected the design mid-write**, each
rolling back cleanly: `source_keys_coherent` refused a `viga` revision carrying her approval, and
`scheduled_prompt_subjects_inventory_base_fk` refused moving a prompt already *sent* — that row
stays with the stand it happened at; her cadence preference is a setting and moved.

### Verified in production, not by exit status

After the final deploy, the real inquiry path was exercised against production data:
`who has eggs?` → **12 matching stands** (was 1), Provo Farms third on its two-day-old listing.
`who has kale?` → 6, led by the stands that have kale, with `Other stands with salad greens:`
separating the rest. No regressions: flowers 13, tomatoes 6, `who has durian?` still returns the
honest no-listing reply. Both label fixes were confirmed **in the shipped JS bundles** — the new
strings present, every old string absent.

### Late in the session: one rename, and next session's design filed

`Who sells here` became **`Also selling here`** on both the public stand card and the admin console
(max). On the public card that gives two sections one heading — the modelled-seller roster and the
typed-names fallback — which is safe because they are mutually exclusive by construction, and a
test now pins that they never both render. Tian Tian is the case that prompted it: a modelled guest
(Fernhorn Bakery) alongside the retained typed spelling `Fern Horn Bakery`, where only the roster
shows.

**F-119** files max's mockup for the next session: In stock and Usually sells become per-seller
groups of bordered item cards, each seller sub-heading carrying its own recency. It is presentation
over data the card already receives — `groupProviderItems` returns providers per item today, so
regrouping to seller-major is the work. **The mockup image itself was not preserved** — it arrived
through the conversation rather than as a file, so F-119 carries a written transcription and a note
to have max re-attach the original before building.

### What this session cost, and the standing lesson

Two defects (B-085, B-088's recency) were **caused by the previous tranche's own fixes**, and one
(B-085's bare row) by a fix made earlier the same day. The pattern: a rule written against a
corpus where its distinguishing case cannot occur. `alsoSellingHere`'s fallback was written before
every stand had a self-pointer; the per-item recency before anyone counted that 33 of 37 stands
have one seller. **Measure the rule against the real corpus before believing it** — the arithmetic
is minutes and it caught every one of these.

## 2026-08-18 — the map's two lists become one two-way view of stands and sellers

Branch `f-118-map-seller-architecture`, squash-merged as **`beeb386`** (PR #134). **Not deployed** —
it joins the three tranches already waiting on max's 2026-08-18 leave-it-undeployed call, and adds
no deploy obligation of its own: client-side only, no migration, no writer, no seam.
Unit **2,341 across 166 files** with the 7 corpus skips; typecheck and lint clean. No evals owed —
`packages/ai` and `evals/` untouched, checked rather than assumed. Integration not re-run: nothing
here touches a writer or a query, and the whole change is client-side over payloads both lists
already receive.

A design session (`/ui-design`), driven turn by turn by max looking at the running app.

### The architecture: one relationship, stated once

Stands and sellers are many-to-many, and before this the relationship was rendered **three times
in three shapes** — a sentence on the seller card, a name list on the stand card, and a `Set` of
ids built inline for the pin highlight. That is three places for one fact to drift, and the fact
is not decorative: it is what a customer follows to get from "who bakes the sourdough" to "which
pin do I drive to".

`apps/web/lib/stand-seller-graph.ts` now states it once and both lists read it. **No read change
was needed** — `PublicStandPayload.sellers[]` already carries `sellerId` and
`SellerListEntry.sellingAt[]` already carries `salesLocationId`, so the join is client-side over
data both lists already receive. What the module owns is what could be *wrong*: a link pointing at
a stand the map is not showing, a pin number invented rather than looked up, a seller's own stand
described as somebody else's.

### The redundancy that only showed up once both directions rendered

Adding a "who sells here" roster to the stand card made a latent problem visible: every seller was
named **twice** — once as an item credit ("Sourdough — Fernhorn Bakery") and once in the roster
below. The fix was not to pick one section but to notice that **the item credit is already where
the reader's eye is**, so it becomes the link. The roster now names only sellers *no item
credited* — someone at the stand who has published nothing, whom no credit can reach.

`alsoSellingHere` fell out of this as a third naming: it is `sales_location_participants`, which
DATA_RECORDS retires as display-only history — typed strings with no identity, so nothing to cross
to. It is now the fallback for a stand with **no modelled sellers at all**, which is the only case
it still answers anything.

### Two defects the source could not show, found by measuring the running page

Both are the failure mode CLAUDE.md names: *when what renders contradicts source that reads
correctly, stop reading source and measure.*

1. **The marker tooltip was clipping off the shore.** It is drawn in a `foreignObject` inside the
   SVG, and `.island` is `overflow: hidden`. Centring a 400-unit box on its pin ran off the edge —
   measured in a browser, a west-shore tooltip lost its whole left half, seller names included.
   Vashon is long and narrow, so that was **most pins, not an unlucky few**. `markerTipBox` clamps
   horizontally and flips below a pin near the north shore; every tooltip re-measured fully inside
   the island on all four edges.
2. **Every seller card's expanded body was indented past its own name.** `.stand-details` carries
   a 2.1rem left margin that aligns a *stand's* body under its name, clearing the pin number in
   the gutter. A seller card has no pin number — `.stand-head-no-pin` already reclaimed that
   column — so the same rule pushed her whole detail 34px right. Measured at 500px: heading at 47,
   body at 81. Now both 47, with the stand card's own indent verified untouched.

### Three revisions from max, all the same shape

Each was the seller list having grown *its own way* of saying something the stand list already
says one way:

- **"1 of 1 stand open"** made the reader do arithmetic to reach a yes. The question is "can I buy
  from her right now", which has two answers. The count still decides it — one open stand out of
  three is Open — but the card states the answer, not the working. A stand that stated **no hours
  is never counted open**: answering Open on a silent schedule states a claim no farmer made.
- **A chosen seller's stands wore a thin olive stroke** while a chosen stand wore the selection
  halo, so the same map said "you picked this" two different ways depending on which list was
  open. One mark now, both lists.
- **The seller card responded only to its heading**, where a stand card has always taken a tap
  anywhere on it — which on a phone reads as broken to anyone who tapped the obvious thing.

Also: the seller list's separate search box is gone. The two lists genuinely search different
corpora, but that is a fact about the *corpus* and not about the *question* — the customer asks
"what am I looking for" once, and two fields in one header leave them working out which one the
list below is listening to. The map's term now feeds both, each list keeping its own haystack rule.

### The last revision: stop taking the reader somewhere else

Tapping one of a seller's stands originally switched the list to View stands and opened the card
there. It answered the question and **threw the reader's place away** — they were reading about a
seller, and the surface they were reading vanished. The stand's detail now expands *inside* her
card. That retired `goToStand` entirely, and the asymmetry that remains is real and worth naming:
a stand card's seller name crosses to the seller list, while a seller card's stand rows stay put,
because a seller has no pin and no sheet and the map is a map of stands either way.

### The category chip max deferred, and why it is a real decision

The mockup carried a Produce / Baked Goods / Flowers / Misc chip. No seller column holds it, and
guessing it from item names would be a **second food-vocabulary branch** — `map-view.ts` records
exactly one allowed exception (`FLOWER_VOCABULARY`, deliberately bounded to display) and states
that *a second is the signal it should have been data*. Asked rather than guessed; max chose to
leave the chip off until there is a field behind it. If it is wanted, the honest home is a
category the seller picks at onboarding.

### Verification

Sabotage-verified throughout — **nineteen** deliberate breaks across the four passes, each caught
by the test that claimed to cover it (the off-map link, provider-vs-seller dedupe, pooled items,
both tooltip clamps, the halo, the card tap, the open rule, second-tap-closes, reset-on-close,
one-at-a-time, and more). The first pass was driven in a real browser against the local database
at ~500px: all four crossings work end to end on real data.

**Not verified in a browser:** passes two through four. max took that check himself and confirmed
it. No width below 500px was reachable — Chrome would not resize smaller. The item-credit crossing
has no local seed data (no guest seller has published items), so it rests on unit tests alone.

### `/sellers` pruned

Flagged rather than taken during the passes — deleting a documented public URL is a product call —
and max took it at the wrap. Nothing linked to the page once the toggle existed, and it had
drifted into rendering a weaker seller card than the map's own. `sellerSellingSummary` and
`joinNames` went with it as its only consumers; `filterSellers` stays, because the map uses it.

**The model-free tripwire caught the deletion**, which is the good outcome: it lists public entry
points and treats a missing file as a hard failure rather than a silent skip, so removing a page
without telling it turns the suite red. Its seller-read coverage moved to a **second entry for the
map's own page**, which now reads `listPublicSellers` itself — and that edit was sabotage-verified
(a model import into `seller-list.ts` still turns it red), because a tripwire you have just edited
is exactly the kind that quietly stops biting.

Final: **2,335 unit tests across 166 files** (down 6 with the retired summary tests), typecheck and
lint clean.

---

## 2026-08-18 — a UI pass over the admin cards and the public map, and a feature that had never once rendered

Branch `admin-card-design`, squash-merged as **`b14155f`** (PR #133). Unit **2,285 across 165
files** with the 7 corpus skips — re-run green on the merged base; typecheck,
lint and scripted evals clean (critical 11/11, advisory 4/4, adversarial 19/19). Integration was
not re-run — nothing this session touched a writer or a query. No live eval owed: `packages/ai`
and `evals/` are untouched, checked rather than assumed.

A design session, driven turn by turn by max looking at the running app. Worth recording because
three of the defects were **invisible to a green suite**, each in a different way.

### F-117's question had never once rendered

max noticed the onboarding form showed nothing about hosted selling. Every part of F-117 had
shipped and was tested — the picker, the API's `hostStandId`, the writer's provider row, and
`listHostStandChoices` — but **the onboarding page never called the query and never passed
`hostStandChoices`.** The prop defaults to `[]`, the component asks only when the list is
non-empty, so no seller could ever answer. Nothing failed anywhere.

The component suite supplied the prop itself. **That is precisely why 2,250 green tests proved
nothing about it**: a behavioural test cannot assert the absence of a *call*. The guard is
therefore a source tripwire, `apps/web/lib/onboarding-host-wiring.test.ts`, which strips imports
and comments first (a bare name search is satisfied by the import line) and **proves the search
can match before trusting an empty result**.

Only the invitation door asks the question: `grandfathered` and `stand_link` post to endpoints
that do not parse `hostStandId`, so asking there would discard the answer silently.

### The CSS lesson, learned twice in one session

max reported the filter bar had no more breathing room after I had reported it done. I had edited
the base `.filters` rule and verified it was *served* — but **two later media-query blocks
override it**, and one of them is what a desktop reader actually gets. My verification was real
and useless: I confirmed the declaration shipped without checking what won the cascade.

The same class of bug then produced the broken seller cards: `.stand` reserves grid column 1 for
the poster dots and `.stand-head` reserves its own for the pin number, so a seller card reusing
that markup laid her name out in a 1.65rem gutter, wrapping one word per line. Reusing a card's
markup is not reusing its layout.

**The standing form:** when what renders contradicts source that reads correctly, grep *every*
rule that touches the property and compare by position in the served file — not the one rule you
edited. Both fixes were verified that way, by byte offset in the compiled stylesheet.

### What changed

- **The admin stand card reads as a profile.** A lead block carries what is on the shelf and when
  it was confirmed — never a bare timestamp, because an undated inventory is a claim about the
  present an unattended stand cannot make. The rest are titled fact groups, two across. Dropped
  `emphasis: "primary"`, which said the same thing `prominent` did from the other end, and deleted
  ~250 lines of dead CSS: four stacked overrides of `.admin-stand-detail-*` with no consumer.
- **"Other details" is gone.** A drawer named for what it is not collects whatever nobody filed —
  Farm Bucks, which this card carries a verb for, was sitting in it. Now `VIGA's record`.
  "Other sellers here" dropped entirely: the card's own "Who sells here" group answers it, *with*
  the controls, so a read-only copy would disagree the moment someone paused.
- **An open Actions menu now outranks the cards below it.** Each card's actions cell was its own
  stacking context, so the menu's `z-index` competed only *inside* that cell; against sibling cards
  the contest was between cells, all tied at 1, and ties go to DOM order. Fixed by marking the open
  menu and raising both rungs. The Actions trigger also renders only on an OPEN card now.
- **The stand editor can be left without saving.** Save had no class at all (a browser-default
  button); it is now the console's primary, with Cancel beside it. Extended to the other two
  panels, which had the same dead end — Farm Bucks gets **Done**, not Cancel, because its select
  writes on change and offering to cancel would promise to undo a write that already happened.
- **VIGA's pause asks before it acts.** The whole row is the toggle, which makes it easily
  mistapped, and pausing takes a real seller's goods off the island's only guide. **Resume is not
  gated** — it puts something back, and a confirmation on a harmless act is chrome an operator
  learns to click past, which is how the one that matters stops being read. Where the toggle reads
  as the stand being open/closed, the question says "close this stand" rather than naming a
  different act from the one pressed.
- **F-117's form asks one question, four answers** (max): just my own stand · only at someone
  else's · both · a farm with no stand people can visit. The two columns underneath stay two
  columns; they were also two *questions*, and a farmer does not hold them separately. 72 existing
  tests answered the old question and were retargeted to the new labels.
- **The map's "Browse by seller" link became a View stands / View sellers toggle** on the list
  itself, so answering "who sells bread?" no longer leaves the map and loses the filters. A chosen
  seller **highlights the stands she sells at** — for a hosted-only seller those are somebody
  else's pins, the case pins could never express. Seller cards render in the stand card's own
  shape, carrying the same kinds of fact in the same slots but dateless: what is out *right now*
  belongs to the stand card, the one surface that can date it honestly.
- **`GEOCODING_API_KEY` lives only in Secret Manager.** The local `.env.local` key was IP-restricted
  and this machine was not on its allowlist, so Google answered `REQUEST_DENIED` — which
  `address-lookup.ts` correctly maps to `not_configured`. Measured both keys against the real API
  rather than inferred: production's works. `dev-setup.sh` now fetches it per run and never writes
  it to disk, the same way it already handled `ADMIN_PASSWORD_HASH`.

### Owed

**Nothing in this session has been seen rendered.** The browser extension was unavailable
throughout, so every visual change was verified as served markup and compiled CSS — including the
two that were *wrong* until max looked. The admin console and the map's new toggle and seller
cards are owed a look at any width. Contrast was measured, not eyeballed: the toggle is 4.82:1
both ways, clearing AA.

---

## 2026-08-17 — F-101's seller half, all of F-117, and a 500 that only running the app could find

Twelve commits on `f-101-seller-half` (`b40827a`…`b6985d9`). Unit **2,210** with the 7 corpus
skips; integration **1,435 passing across 106 of 107 files**; typecheck and lint clean. The six
integration failures are the **pre-existing** `PUBLIC_BASE_URL` isolation weakness in
`apps/web/lib/farmer-stand.integration.test.ts` — proved rather than assumed by checking out `main`
and reproducing the identical six there (1,403 passing). This branch adds 32 passing integration
tests and no failures.

### The premise correction that shaped the session

max opened by flagging that a stand/seller settings screen probably already existed, and he was
right. F-101's own notes claimed *"it does not exist today: `/farmer` holds onboarding and start
only"* — but `/stand/[token]/settings` has existed since F-051, and `LINK`/`SETTINGS` have parsed
deterministically and texted a permanent link since F-040. **One acceptance criterion was already
met when the item claimed it as owed work.** The seller half was therefore a new section on an
existing screen, not a new screen — which also matches the rule already in `onboarding-copy.ts`:
a farmer has exactly ONE edit page.

The same correction happened twice more, and both are worth remembering:

- **"Editable stand metadata" was half-built.** F-073 shipped a full listing editor for the stand's
  OWNER at `/stand/[token]/listing`. Only VIGA's half was missing. max chose to build it rather
  than close the criterion as met.
- **F-117 needed no migration for its arrangement.** I claimed `hostStandId` had to be held on the
  invitation until `START`, like `pendingStock` and `pendingPromptCadence`. max asked whether a
  hard constraint could be relaxed; the answer was that **there was no constraint** — those two
  wait because they need an AUTHORIZATION (a dated confirmation needs somebody to stand behind it,
  a reminder needs a recipient), and `stand_providers` needs only a `seller_id`, which exists the
  moment the invitation names her farm. The row goes in beside her own stand's, in one transaction.

### F-101's seller half

- **`PROVIDER_SELLER_ARM`** names the seller test once; `PROVIDER_AUTHORITY_ARMS` composes from it
  and `participationArm` uses it. The screen and the seam cannot come to disagree about who is the
  seller — the disagreement's shape would be a button that returns `not_authorized`.
- **`mayPause`** rides each listing from that arm. **Not the same question as `describesOwnStand`**:
  a hosted seller's own listing is not her stand, and pause is still hers. That row is where the two
  diverge and is asserted.
- **`handleFarmerParticipationPost`** + `/api/farmer/participation` — the second production caller
  of `setProviderParticipation` and the first meeting the authority asymmetry. The token is the
  actor; no authority is re-stated outside the seam.
- **`ListingParticipation`** on the settings screen: pause/resume, Remove behind an inline
  confirmation, no restore anywhere. Deliberately NOT the admin's `SellerParticipation`
  parameterised — different audiences, different authority shapes, and one file holding both
  would hold both sets of copy.
- **`saveStandMetadata`** — VIGA edits a stand's own facts. Deliberately not `saveOnboardingListing`
  with an admin arm: that writer replaces payment methods, usual offerings, the farmer's own
  description and her items, and Golden Rule #1 keeps VIGA's hand off her published words.
  `incomplete_location` gives the coherent-visitability constraint words so an operator clearing an
  address gets a next move rather than a 500.
- All six F-100 copy findings, plus the test-phone row defect: the route now returns the real id and
  the last four of the NORMALIZED number, so a number that normalizes differently no longer shows
  the typo's suffix under an id the server does not have.

### F-117, folded in on max's call

- **`approval_source = 'seller'`** (`0052`) — a third source, settled with max. The two that existed
  could not tell the truth about the row: `viga` would make a self-selected seller indistinguishable
  from one VIGA approved, in a flow whose premise is that VIGA never saw her; `host` names a
  vouching authorization that does not exist until the host answers, which is after she is live.
- **`listHostStandChoices`** — a name and an id, carrying the map's own `visibleFarms` rather than a
  restatement. **LEFT join to `sellers`**, so a VENUE like Morgan Hill (no seller of its own, and
  the strongest case for this flow) is included; an inner join dropped it silently with every other
  test green.
- **The onboarding question is its own question**, never a third `visitability` value: that column
  says whether THIS stand can be visited, and selling elsewhere is a fact about an arrangement.
- **`pending_host_confirmations`** (`0053`) and the thread-bound answer. Answerable only while the
  question is the last message in the thread — anything the host texted us, or anything we sent
  them, closes it. Golden Rule #2 met by conversation state rather than a clock. **The system-sent
  half is the one a weaker implementation forgets** and is sabotage-proved separately.

### The defect only running the app could find

Every farmer web screen — `/stand/[token]`, its settings, its listing editor — returned **500** in
`next dev`: `UnhandledSchemeError: Reading from "node:crypto"`. Two client components imported
`creditSeller` from the `@farm-friend/core` **barrel**, which re-exports `privacy/phone.ts`.
`@farm-friend/core/seller-credit` is already an exported subpath and the module is pure — it exists
for exactly this. **Pre-existing on `main`**, confirmed by checking out `main` and reproducing.

No suite caught it because jsdom resolves the barrel fine. It is the §the local runtime is not the
deployed runtime gotcha in a new costume, and the only thing that surfaced it was launching the app.

### Verified by running it, not only by tests

Against local Postgres with `0052`/`0053` applied (verified by effect — table present, `seller` in
the enum) and the app on `next dev`:

- F-117 end to end: picker → self-selection → live arrangement (`approval_source = seller`) → the
  host's real GSM-7 text → `NO` ends it → a second answer finds nothing.
- F-101 authority: seller pauses and resumes; **host refused pause, permitted end**.
- The adapting label: a solo farmer reads *"Close my stand for now"*, a multi-listing farmer reads
  *"Pause this listing"*.
- The settings screen serves 200 with the section, pause and Remove; the confirmation correctly
  absent until Remove is pressed. The login shows static *"Signing in as board@vigavashon.org"* with
  the hidden input intact.

**23 sabotages this session, each caught by a distinct test.** The one worth repeating: removing the
`where exists` guard on the hosted-arrangement write raises a foreign-key violation that loses the
farmer's **entire onboarding form** — which is why that write is deliberately non-fatal.

### Judgment calls max may want to revisit

- **A stand whose owner Farm Friend cannot text still lists the seller**, and no question is opened.
  Farm Friend cannot text first, so refusing a real arrangement over a message we could never have
  sent would leave the public map wrong instead. The host keeps Remove on their own settings screen.
- **The confirmation uses `stock_out_alert`**, so it requires ACTIVE consent rather than riding the
  carrier's reply allowance — a host who texted STOP hears nothing, which is correct.
- **Routing tries the host question before the inventory proposal.** Safe precisely because the host
  question can only be open when nothing has passed in that thread.

### Owed

**Nothing deployed, and `0042`–`0053` remain unapplied to production** — this joins the existing
queue rather than shipping alone. **VIGA's stand editor has not been seen rendered**: the Stands
view switches client-side, so `curl` cannot reach it, and the browser extension was unavailable
again this session. It carries 8 component tests and 5 seam tests.

---

## 2026-08-17 — F-101: the admin console becomes Stands & Sellers, and the pause/end mechanism gets its first caller

Merged as **`dc0b831`** (PR #131), ten commits on `f-101-admin-ui-refactor`. Unit **2,189** with the
7 corpus skips; integration **1409/1409 across 102 files**; typecheck and lint clean — all four
**re-verified on the merged base**, not just on the branch. No live eval run owed: `packages/ai`
and `evals/` are untouched, checked rather than assumed. **Nothing deployed** (max, 2026-08-17) —
production is already behind by F-114/F-115 with `0042`–`0051` unapplied, so this joins that queue
rather than shipping alone.

**The gap this closes.** F-115 Tranche D built `setProviderParticipation`, its authority resolver
and every consequence, fully tested, with **zero production callers**. Pausing or ending a hosted
selling relationship was mechanism-complete and unreachable. This session built the surface.

**The design, settled with max by interview before any code.** The governing aim he named: *a VIGA
volunteer must never have to understand the data model to run the system.* Everything follows from
it.

- **Two views, one destination.** Stands and Sellers are two ways of looking at one set of
  arrangements, so they share a destination rather than splitting the nav. The nav is now
  **Stands & Sellers · SMS Users · Alerts**, and **"Farms" is gone rather than renamed** — max:
  VIGA's whole job is *view and edit stands and sellers, invite new stands or sellers*, so a farm
  is not a destination and approval/retirement/setup links become things done while looking at a
  seller.
- **The lists are entities, not states.** One row per stand, one per seller; a participation is a
  detail inside a row and never a row. A seller at three stands is one row.
- **The singular case is not a list**, on both views — a plain fact with its control, no list
  chrome.
- **The adapting label.** On a stand whose only arrangement is its own seller's, the toggle reads
  as the stand being open or closed, because there that is its true effect. Computed from the
  whole set, never the row, so it **can never say "closed" while a guest is still selling there**
  — the lie the rule exists to prevent. max chose this over introducing a stand-level closed
  state: a label that adapts, not a new mechanism.
- **Toggle = pause/resume; Remove = end**, behind an inline confirmation, with no restore — coming
  back is a fresh invitation, because `ended_at` has no inverse and the UI must not imply one.

**One pushback that changed the design.** max wanted the seller to self-select a host stand during
onboarding with only her own power to revoke. That inverts F-116's settled rule — a host who
cannot remove an uninvited seller is hosting someone they never agreed to. He replaced it with a
better answer than the one offered: an SMS to the stand owner, *"Please confirm that you host
[seller]. Reply YES to confirm, NO to deny."* Live immediately, `NO` ends it. Answerable **only
while it is the last message in the thread** — Golden Rule #2's context-binding satisfied by
conversation state rather than a clock. Filed as **F-117**; it depends on this item's seller
settings screen as the fallback once the confirmation closes.

**Two traps the data found, not the tests.**
- `sales_location_participants` and `stand_providers` both answer "who sells here", but the first
  are display strings a stand owner typed, with no row a control could act on. The new read
  returns only real arrangements, and asserts the distinction directly — a toggle beside a typed
  name would act on nothing.
- Replacing the Farms page **orphaned `listFarmerAuthorizations`**, which would have made
  `/api/admin/farmers` dead surface. The `dead-surfaces` suite caught it; the access roster now
  lives on the seller card, where "who can update this listing" belongs anyway.

**What the browser found that the suites could not.** Every test passed while the page rendered as
unstyled HTML: fourteen class names written, none of them in `globals.css`. Fixed mostly by
*reusing* the console's existing row/pill/button vocabulary rather than adding a second visual
language. Then max's trims on the rendered result — no row glyphs, no page heading, white cards,
the row count as plain text beside the view switch, and **"unclaimed" demoted from an alert to a
neutral chip**: every farm starts unclaimed, so alerting on it made the attention line permanent
furniture and taught the operator to skip the real alert beside it.

**A self-inflicted regression, filed as B-079.** The dead farm card was deleted with a
brace-counting script that removed whole `describe` blocks containing a `FarmList` render — and
one of them also held four tests for the Alerts page, which is still live. Lint at wrap time was
the only thing that surfaced it, via three newly-unused imports. max chose to file rather than
restore before merging. The lesson outlasts the fix: **a substring-matched script deleting test
blocks cannot tell which tests in a block are about the thing being deleted.**

**Owed.** The **seller half of F-101 has not started** — the farmer settings screen (reached by a
permanent unguessable link, re-sent on `LINK` or `SETTINGS`), editable stand metadata for VIGA *or*
the stand's owner, and the F-100 audit's remaining copy findings. Also unresolved: the whole
console was verified as served markup and CSS rather than as pixels, because the browser extension
was not connected.

## 2026-08-17 — F-115: retiring the derivations F-114 left behind, and the venue nobody could see

Merged as **`a32a4a7`** (PR #130), nine commits on `f-115-de-vibe-remediation`. Unit **2,165**
with the 7 corpus skips; integration **1400/1400 across 100 of 100 files**, up from 1347/1347
across 96. Typecheck and lint green, and **re-verified on the merged base** — all four suites
again, plus `drizzle-kit generate` still reporting *"No schema changes"*, so the `0051` snapshot
delta is healthy. No live eval run owed — `packages/ai` and `evals/` are untouched by the whole
branch, checked rather than assumed.

**The work order.** Two independent architecture audits, run cold against `main` at `3abe2fc`
after F-114 and before QA, found one root cause in seven places: *F-114 built the right owners and
left the old call sites in place.* Each phase introduced a correct seam and converted the callers
it was looking at; callers outside that set kept deriving through `sales_locations.own_seller_id`,
which is right for 31 of 38 stands and wrong for exactly the hosting relationships F-114 exists to
serve. Nothing failed in testing, in the corpus, or in review. Tranches A–G in
`docs/plans/de-vibe-remediation-plan.md`; the pause/end writer is filed separately as **F-116**
because it was feature work rather than cleanup.

**The rule throughout was DELETE the stale derivation, never widen it.** The composite FKs added
in `0042`–`0049` already guarantee the coherence those comparisons were re-deriving, so widening
one recreates the root cause. `standBelongsToSender` and `currentInventoryJoin` are gone rather
than fixed.

**Tranche E found that "one liveness predicate" was TWO.** Ten sites hand-wrote
`ended_at is null and lifecycle_state in ('active','paused')`, and collapsing them into one
fragment would have been wrong. They are two rules that agreed only because `paused` was
unreachable: **PUBLIC** (what a customer may be shown — active only) and **REACHABLE** (whose
listing a farmer may still act on — active or paused, because §facts and authority says a paused
provider is *offered re-opening, never refused*). `provider-liveness.ts` states both, so a new
site has to choose, and choosing wrongly is a visible name rather than a mistyped predicate.

**Pausing hid nothing, and nobody had chosen that.** All ten predicates admitted `paused`, so a
paused seller's goods stayed on the map — contradicting the architecture plan's *"ending or
pausing hides current public facts."* Two tests asserted the opposite in near-identical words and
their parity assertion passed, because both were written while `paused` was a state nothing could
enter. Invisible until Tranche D built the writer. max decided: **pause hides.** The ordering of
the work order is what surfaced it — a fragment written against an unreachable state records
whatever its author assumed.

**Re-invitation after ending was impossible** (the plan's one open question, D2), measured with a
probe rather than reasoned from the schema. `0051` makes the `stand_providers` uniqueness partial
(`where ended_at is null`); max decided a seller may be invited back. `ON CONFLICT` then had to
name that predicate or every invitation raised — caught by the writer's own suite, not by the
migration test.

**The differential closed the plan's Unverified item, and the duplication was the non-finding.**
Both audits confirmed `inquiry.ts` builds its own per-seller SQL rather than calling
`readStandProviderFacts`; neither checked whether the two agree on freshness. They do — exactly,
on every seller's date and on which items belong to whom — and they keep separate shapes for the
reason the audits' STRONG list gives. What measuring found instead was three defects in one line:

```
join sellers f on f.id = l.own_seller_id
```

INNER, in the map reader and in **both** SMS retrieval queries. A **venue** has no
`own_seller_id` — a place several farmers sell at and nobody's farm, which is what the
self-pointer exists to represent — so every venue was dropped from the map and from both halves of
SMS retrieval entirely. Now LEFT, with the stand-owner visibility rule the alias carries still
biting, proved by retiring the host and watching the stand leave both channels. The same line gave
every hosted seller's confirmed SMS row the **host's** name; that row is one seller's claim, so it
now carries the provider's own seller. Nothing renders `farmName` today, which is why no existing
test saw it — one renderer away from naming the wrong farm.

**One difference is deliberate and stated rather than asserted away.** A seller who confirmed an
EMPTY stand is a dated fact on the card ("confirmed empty") and absent from SMS, per that query's
own documented rule: an SMS answer lists places to go for a thing, and a seller with nothing is
not one. Asserting equality there would have forced one of the two surfaces to be wrong.

**Two source-text tripwires could not fail**, both measured rather than reasoned about.
`architecture.test.ts`'s `issueFarmerLink` regex matched 5,319 characters — running past its own
function into a later interface — and asserted the `salesLocationId` parameter F-114 C.3
deliberately replaced with `providerId`: green throughout C.3 while claiming the removed design.
`map-marker-styles.test.ts`'s CSS regex matched 42,426 characters spanning two unrelated blocks
42KB apart. Both replaced by anchored assertions or by pointers to behavioural coverage.

**A migration test's range filter had no upper bound** — `name >= "0048_"` with nothing above it,
the exclusion anti-pattern DEVELOPMENT.md warns about, running in the other direction. `0051` was
the first migration to trip it.

**Sabotage notes worth keeping.** A refusal case in Tranche A was *impossible to construct*: the
composite FKs refuse an incoherent subject row, which is precisely the plan's point that
re-deriving proves nothing. One sabotage produced malformed SQL and failed four tests for the
wrong reason — indistinguishable from a test that cannot fail until you read the error. And a
scheduler fixture went silently `ineligible` when forced earlier than the writer's computed slot,
because publication resets the cadence.

**Owed:** `0042`–`0051` remain unapplied and nothing is deployed, so every defect above is latent
rather than live. **F-116 now has a writer and no entry point** — `setProviderParticipation` has
zero production callers, so pause/end is mechanism-complete and unreachable. max decided
(2026-08-17) the surface is controls in the admin views and the seller's own settings screen, not
an SMS keyword, and **it ships with F-101, which widened from the F-100 audit's leftover copy
fixes into the admin UI refactor**: F-116 keeps the mechanism and its authority rule, F-101 owns
the surface, so the two are not tracked in two places. The handset passes C.3/C.4/C.5 owe are
unchanged.

---

## 2026-08-16 — Whose goods are these? (F-114 Phase C.5, the customer's half — the last phase)

Merged as **`9d9ff58`** (PR #129). Integration **1347/1347 across 96 of 96 files**, up from
1289/1289 across 92; unit **2,152** with the 7 corpus skips. Typecheck, lint and scripted evals
(11/11, 4/4, 19/19) green, and **re-verified on the merged base** — all four suites again, plus
`drizzle-kit generate` still reporting *"No schema changes"*, so the snapshot is healthy. **F-114 is complete** — every phase from B to C.5 is on `main`, and the
nine-migration queue (`0042`–`0050`) is unchanged, because C.5 added no migration at all: Phase B
had already given `stand_items` and `inventory_revisions` their provider column. Every criterion
in the PM item is checked except the physical-handset pass, which is max's.

**The phase was one defect, in three places.** The map, SMS retrieval and the admin roster had all
kept the Phase A shape — `is_current` keyed on `sales_location_id` alone. That was correct while
every stand had one seller and silently wrong the moment one had two: both sellers' entries come
back interleaved under whichever `published_at` the loop saw first, so one farmer's goods are
dated by another's update. Nothing errors. Every item is present. The card is wrong. Phase A
consolidated those sites precisely so this would be one change; C.5 is that change.

The new seam is `readStandProviderFacts`, and it is a NEW reader rather than a widened
`currentInventoryJoin` because the *shape* of the answer changed, not just the predicate — the
corpus-wide surfaces select one row per stand, this returns a nesting. That let the three surfaces
adopt it one at a time without dragging the admin roster along, which genuinely does want
stand-wide aggregates.

**`items` is now DERIVED from `sellers`, not read a second way.** The stand-wide union is what a
customer scanning a map needs ("is there kale here"); the per-seller nesting is what the detail
card needs ("whose, at what price, confirmed when"). Two shapes of one fact rather than two facts,
which is the only construction that makes web-and-SMS agreement structural instead of promised.

**Two rules moved into core, because they were about to be written a fourth and fifth time.**
`creditSeller` — the stand's own seller renders unlabelled, **by self-pointer, never a name match**
— already existed three times (the SMS target menu, the settings screen, the reminder list). Its
separator is a *parameter*: SMS is GSM-7-bound and one em-dash re-encodes a whole message to
UCS-2, so what must not differ between channels is *which* listings get a name, not the
punctuation. `sellerCredit` was factored out beside it when the card needed the credit without a
location name attached — one predicate, two renderings, rather than composing a string and
trimming it back off.

**A prior deliberate decision was reversed, deliberately.** `closure-public.integration.test.ts`
asserted that a closed stand KEEPS its items, with the notice, the Open-now filter and the
suppressed routing link doing the work. §customer behavior overrides it: a shutdown renders
nothing itemized, both registers, because a closed stand is a locked box and a standing claim is
as unbuyable as a dated one. Suppressed in `public-listing` rather than the card — suppressing
only in the detail card would leave a closed stand's stock answering a produce search and printing
on the compact card, with the card's own suite fully green.

**The seller list is why hosted sellers can be named at all.** It survived an over-engineering cut,
and the reason is narrow: a bakery selling only at other people's stands owns no `sales_locations`
row, so it has no pin and no card. Crediting it by name on someone else's card while leaving it
findable nowhere is worse than not naming it. Its search matches a seller's own name and goods and
deliberately NOT the stands they sell at — matching those answers "who is at Morgan Hill" with
every baker who has a table there, which the map already answers properly.

**`intersectAvailability` finally has a consumer.** Phase A built it and shipped it as an identity
function with `provider: undefined` everywhere; C.5 is the surface that asks it. Both directions
are proved and both were checked on the live wire, not only in the suite: a seller closed inside an
open stand, and a seller claiming `all_day` still closed inside a shut one.

**Three defects found in passing, none of them C.5's own scope, all measured against a real
database before being touched.** The SMS *offerings* half still joined `stand_items` on the stand,
so a hosted seller's usual items reached customers from ended relationships, unaccepted
invitations, and sellers VIGA had retired — the map had closed all three and SMS runs its own SQL.
The admin roster listed a two-seller stand **twice**, each row carrying half the inventory. And a
`Write` emitted a stray NUL byte into a template literal where a space belonged: JS parsed it,
every test passed, and only `od -c` showed it.

**Two verification lessons worth the standing entry.** First: *a mis-aimed sabotage is
indistinguishable from a test that cannot fail*, and C.5 produced three — a perl pattern that never
matched the source, a `limit 1` inside an aggregate that limited nothing, and an object spread that
did not remove the key it appeared to. Each read as an escape until the sabotage itself was
checked. Second: the four real escapes were all the same standing failure — `usually_carried` with
no unusual item beside a usual one, a hidden-price case whose item had no price to hide, a venue
case for the null self-pointer, an SMS offerings gate with no hosted seller to refuse. Also: the
empty-id-list guard proved *genuinely* redundant (ids travel as an array parameter, so `= any('{}')`
already matches nothing) and was deleted rather than left unfalsifiable.

**Two traps got tripwires.** A backtick in a SQL comment closes the template literal and typecheck
names a *column* far from the comment — five hunts this phase, now
`packages/core/src/sql-template-safety.test.ts`, which proves its own scanner in both directions
before trusting a clean sweep. The NUL-byte sweep is documented in DEVELOPMENT.md §gotchas.

**Read in a browser, not just asserted.** The item-first card and `/sellers` were both loaded
against the real dev database with a seeded hosted bakery; the served `/api/public/stands` payload
was read on the wire. Two things only the running page showed: `stand-card.ts` imported core's
*barrel*, which re-exports `privacy/phone` and pulled `node:crypto` into the browser bundle (the
page 500'd; vitest runs in Node, where it resolves fine, so no unit test could have caught it), and
the nested seller lines kept the chip's pill because `.items li` at (0,1,1) beat a bare
`.item-seller` class — the file read correctly and only a computed-style read of the live page
showed otherwise. Geometry measured at 360px and 390px: no horizontal overflow, credited lines
wrap; no C.5 rule sits in a `prefers-color-scheme` block, so the light-only palette holds.

**Owed:** the two new customer surfaces have not been seen on a real phone.

## 2026-08-16 — Whose schedule is this? (F-114 Phase C.4, cadence + scheduler + paused re-opening)

Merged as **`ac3fcd5`** (PR #128). Integration is **1289/1289 across 92 of 92 files**, up from
1248/1248 across 88; unit is 2,080 with the 7 corpus skips. Typecheck, lint and scripted evals
(11/11, 4/4, 19/19) green, and **re-verified on the merged base** — tests, typecheck, lint, and
`drizzle-kit generate` still reporting "No schema changes" — not only on the branch. `packages/ai` and `packages/core` are untouched across the whole phase —
`git diff --stat main` empty for both, with the search proved against a known-present term first —
so no live eval run was owed. **`0048`, `0049` and `0050` join `0042`–`0047` unapplied to
production, taking the queue to nine.** Five tranches.

**The phase opened with a design question, and the answer was to delete.** `stand_providers`
carried a `reminder_cadence` and a `reminder_authorization_id`; `inventory_prompt_preferences` was
ALREADY one-per-provider, with a unique index on `provider_id` and its own
`designated_authorization_id` — added by the *same* migration. One fact, two homes, and the pair had
never gained a reader or a writer across B, C.0, C.1, C.2 or C.3. The schema comment defending it
("`inventory_prompt_preferences` remains the stand-level record") was already false when written.

Reading the pair instead would have meant moving the scheduler's cursor — `version`, `next_due_at`,
`last_due_slot_at` — onto a relationship record, or splitting a listing's schedule from its place in
that schedule. So: deleted, and deleted from `0042` **in place** rather than by a later migration,
because no database anywhere has applied it — the same fact that let C.0 replace it wholesale. The
queue length is unchanged by the deletion; production never sees the columns.

**A live snapshot defect surfaced on the way, and it was not mine.** `0042`'s snapshot carried TWO
`public.sellers` blocks: the correct renamed table, and Phase B's *deleted* `sellers` table, still
referencing `farms`. JSON parsers keep the last duplicate, so drizzle had been reading the dead one.
Harmless today only because `0043`–`0047` were built as text deltas from the correct block and
`0047` — the head `generate` actually diffs — is right. Fixed in the same commit.

It also nearly cost the wrap: the first attempt at the snapshot edit went through a Python JSON
round-trip, which silently dropped the duplicate **and 209 unrelated lines**. Caught by reading the
diff rather than trusting the write. Snapshots get edited as TEXT now, and that is filed.

**The `*_location_own_seller_fk` family was enumerated up front rather than discovered one
migration at a time.** Eight keys total: `0045` moved `inventory_revisions`, `0047` moved five more,
`0048` moves `inventory_prompt_preferences`, `0049` moves `scheduled_prompt_subjects`. The last two
— `closure_revisions` and `sales_location_participants` — deliberately STAY, because both carry
facts about the PLACE and re-rooting them would make the record assert something false (max,
2026-08-15). All three moved this phase existed only in `0042` and were **never carried into
`schema.ts`**, so none was findable by reading the schema; each surfaced on a hosted write.

`0048` was load-bearing rather than tidy. At a venue `own_seller_id` is NULL and a foreign key
cannot match NULL, so the dropped key did not merely constrain a venue's cadence — it made one
**impossible**, at the database, where no writer could reach around it.

**The cadence seam refuses the HOST arm deliberately.** `resolveProviderWriteAuthority` answers *may
this phone write this provider's STOCK*, and `host_may_update_stock` grants exactly that: a physical
observation about goods on a shelf. A reminder schedule is not an observation, and §facts and
authority makes its recipient the seller by construction — *"other authorized users may still update
it manually"*, manually rather than by owning the schedule. Kelsey may mark Zoe's last loaf gone;
she may not own Zoe's schedule. A venue's stand-armed manager is refused for the same reason, and
the venue's nested seller sets her own — which is also the case that proves the refusal is about who
is asking rather than about a venue being unschedulable.

**The scheduler pass read the roof three times.** `own_seller_id` gated the designated
authorization, gated VIGA's approval, and was written into the durable subject as `owner_seller_id`.
For Zoe all three are Kelsey, so the first two refused her outright and her cadence would have sat
in the table forever with `next_due_at` in the past. It reads the PREFERENCE'S own seller now, safe
because `0048`'s key guarantees that seller IS the listing's. The pass also gained a
relationship-liveness check it never had: a seller whose listing ENDED still has a seller record, a
live authorization and an approval, so all three gates pass and she would be prompted to confirm
goods she no longer sells there.

**A paused listing is offered re-opening, and the gate is at the COMMIT.** Three ways in — a fresh
update, a reply to a prompt the scheduler sent before the pause, and `SAME`, which reaches
`confirmInventoryPublication` through no door at all. Guarding the doors would be three rules that
can disagree and would leave `SAME` publishing silently, so the gate sits on the one seam all three
funnel through. `resolveProviderWriteAuthority` has reported `paused: true` on an *authorized*
answer since C.2 precisely so this could be a flag rather than a refusal; nothing had read it.

**The consent is the farmer's, and it is durable.** A caller-supplied boolean would let any path
assert a consent no farmer gave — exactly the inference the rule forbids. It is
`reopening_stated_version` on the proposal, written by the proposal writer when it composed the
prompt that stated the consequence. The **version**, not a boolean, and that distinction is
load-bearing: a revision bumps `proposal_version` and clears the activation, so a boolean would
survive a farmer seeing the sentence, revising instead of confirming, and then answering an ordinary
prompt that never mentioned re-opening. Placed LAST among the refusals, so it consents to one
consequence and excuses nothing — a revoked authorization still returns `not_authorized`.

**The farmer replies `YES`** (max, 2026-08-16). No new SMS keyword: `YES`/`NO` are the two words a
farmer already knows, and a third would be one more thing to teach for a case that arises rarely.
That decision is what makes the recorded version necessary rather than merely tidy — the `YES` is
ambiguous on its own, and only the record says which sentence it answered.

**The settings screen moved both halves together.** C.3 left it stand-shaped for exactly one
sub-phase because the default picker and the reminder rows are one screen and one save button;
converting the picker alone would have left a listing picker above a stand-keyed reminder. C.3's
placeholder case is INVERTED here, and the case it could not have — a hosted-only seller like Zoe,
whose settings page previously refused her outright because her only listing was filtered away and
the empty result read as `not_authorized` — is added. Participants stay keyed by STAND, because they
are the stand's own record; both pages dedupe by stand before fetching them.

**Twenty-one deliberate breakages, each caught by the case aimed at it — after two escapes, both
the standing lesson again.** Deleting the cadence seam's authorization-agreement check changed no
test result, because every mismatch case also used a mismatched PHONE and the seam resolves by
phone, so the arms refused first; the isolating case is ONE phone holding TWO live authorizations —
Zoe selling her own goods and managing the venue — presenting the one that did not answer. And
dropping the re-opening sentence from the SMS reply broke nothing, because the constant's own test
asserts the CONSTANT and the seam's tests assert the STATUS; a reply that lost it still renders a
plausible confirmation. The end-to-end case through `handleFreeText` closes that, asserting the
absence of the ordinary prompt too.

**Two mirror-image traps cost a false green each.** A refusal case written without `next_due_at` is
refused by `inventory_prompt_preferences_due_state_coherent` — a CHECK, evaluated before any foreign
key — so it passed with or without `0048`; caught only because the case asserts the constraint NAME.
And a `beforeEach` truncate CASCADED from `inventory_publication_proposals` into
`inventory_revisions`, leaving every scheduler case running against an empty stand while still
queueing prompts, because `offers_same: false` with a null base is what an unpublished stand
legitimately produces. Every structural assertion passed; only the asserted BODY caught it.

**One real defect, caught by a test rather than by reading.** `participantNamesByLocation` is keyed
by stand, and the seller-name box initialised its text with what had just become a LISTING id. Both
are UUIDs, both lookups compile, and every load would have shown an empty seller list.

**Nothing deployed, deliberately** (max, 2026-08-16, asked at the wrap). Production is nine
migrations behind and the merged code needs `0042` before it can serve a single write, so applying
them and deploying is one act rather than two — and the nine are Max's call. Production keeps
serving `farm-friend-web-00082-2pl`, which predates every writer that needs them and is unaffected.

**Still not built: C.5** — the public seller list and item-first cards.

---

## 2026-08-16 — Zoe can be reached at all (F-114 Phase C.3, targeting + stock-out routing)

Merged as **`daa499f`** (PR #127). Integration is **1248/1248 across 88 of 88 files**, up from
1208/1208 across 84; unit is 2,075 with the 7 corpus skips. Re-verified on the merged base — tests,
typecheck, lint and scripted evals — not only on the branch. C.2 gave Zoe the ability to publish Gracie's
Greens' stock from the web; C.3 is what lets anything *reach* her.

**The gate was one join, and it read as a sentence nobody had re-read.** `lockLiveTargets` joined
`sales_locations.own_seller_id = auth.seller_id` — *the stands this phone owns*. True of every
stand in the corpus, and false of every hosting relationship C.1 and C.2 had just built. A seller
with no stand of her own was untargetable outright: no `LINK`, no `STAND`, no `SETTINGS`, no
scheduled prompt, nothing. A target is a PROVIDER now.

**One rule, two directions, and their agreement is a test rather than a shared line of SQL.**
`PROVIDER_AUTHORITY_ARMS` is the three ways to say yes as composed SQL text, shared by the
targeting query and `resolveFarmerLink`. `resolveProviderWriteAuthority` deliberately keeps its own
statement: it must additionally report WHICH arm answered, under which authorization, and
distinguish `not_authorized` from `provider_not_live` — folding it into a filter would lose exactly
the facts its callers need. So the round trip is asserted over every phone-and-listing pair with
the host opt-in swept both ways. A menu that offers a listing the writer then refuses is a farmer
told to choose and then told no; that is the failure the test exists to prevent, not tidiness.

**The menu names the seller only where it differs from the stand**, by SELF-POINTER and never a
name match — §suppression follows a pointer, applied to the farmer's side. It asks *"Which listing
do you mean?"* rather than *"Which stand"*, because a host choosing between two listings at one
stand has no answer to the latter. Still GSM-7.

**Stock-out routing is by CONTRADICTION, not recency**, and the discovery worth recording is that
there is no sold-out flag anywhere in the schema: *presence in a provider's current revision IS the
claim that the item is out there.* So absence from a published listing is that provider already
saying they are out, and the three outcomes fall out of one fact — listed → contradicted, told;
published without it → agrees, skipped; no current revision or usual-only → no dated claim to
argue with, never told, filed for VIGA. `readCurrentInventoryByProvider` is the new reader, and a
provider with no current revision is ABSENT from its result rather than present-and-empty, because
"published nothing" and "published a listing without this" are the non-claimant and the agreer.

**A live behavior change, decided at the wrap (max, 2026-08-16): ship it.** The 18 stands that
publish no confirmed inventory stop receiving stock-out alerts entirely — today they are texted
regardless. §customer behavior specifies exactly this and explicitly forbids designing around the
transitional condition; it resolves as those stands confirm inventory, and until then VIGA's queue
is where those reports land. It is the one C.3 change a farmer would notice without being told.

**`0047` removes SIX composite keys, and the last two were found by a probe rather than by
reading.** Two each on `farmer_target_contexts`, `farmer_target_menu_options`, and `farmer_links`,
all still asserting the one-seller-per-stand model. The migration was written for four; a
populated-schema probe was refused by `farmer_links_targeted_location_own_seller_fk` — a constraint
nobody had re-read — which surfaced the fifth and sixth, and that one would have refused a hosted
seller's own link outright. **Four of the six existed only in `0042` and were never carried into
`schema.ts`**: real drift, resolved here rather than left for the next generated migration.

Each `(location, own_seller)` pair is REPLACED by `(provider, seller)` — `0045`'s substitution —
rather than dropped. Dropping them was the first draft and was wrong: nothing would then tie
`owner_seller_id` to the provider beside it, so a menu row could name one seller's listing under
another seller's name with no constraint anywhere seeing it. Each `(authorization, seller)` pair
becomes a plain reference, **a real loosening named rather than buried**, for the reason `0045`
widened `authorization_farm_fk`: who may target whom is two LIVE facts a static key cannot see.

**A correction to the snapshot-repair procedure, measured rather than assumed.** `0047`'s snapshot
is a DELTA of `0046`'s, not an introspection. Measured three ways on this branch: `generate` on the
merged base says *"No schema changes"*; an introspected `0047` snapshot makes it emit **16KB** of
constraint churn; the delta-edited snapshot returns it to *"No schema changes"*. The C.1 guidance
to introspect was written when the snapshot was already drifted — it repairs a drifted snapshot and
**degrades a healthy one**. Also learned the hard way: `drizzle-kit generate` appends a journal
entry as a side effect, so a probe run silently drops your own migration's entry. Both filed in
DEVELOPMENT.md §gotchas.

**Six escapes, and every one was the same failure the last six were** — a guard is unfalsifiable
until a case exists where it is the ONLY thing that could refuse. The self-pointer label survived a
swap to name-matching, because no fixture had a seller whose name disagreed with its stand's *in
either direction*. The proposal's provider filter and the composition base both survived removal,
because no suite anywhere had two listings at one stand reachable by ONE phone — which needs the
host opt-in, the only legitimate way that happens. The SMS menu's seller label survived being
deleted outright, because nothing asserted the rendered menu. The link query survived losing its
live authority arms, because no link pointed at a listing that was not the holder's own. The
settings screen survived losing its self-pointer filter for the same reason. And
`resolveAdministratorLinkTarget` survived "pick the first" because it had no test at all. 19
deliberate breakages in total, each caught by the case aimed at it once those six were closed.

**Deliberately still stand-shaped, for one more sub-phase.** The farmer settings screen keeps the
stand's own listing by self-pointer and drops hosted ones: the per-listing screen belongs with
C.4's reminder cadence, which is the setting that actually differs per listing and shares the same
save button. Splitting it across two tranches would leave a listing picker above a stand-keyed
reminder. VIGA's `issue_link` resolves its `(authorization, stand)` pair to one listing and REFUSES
on ambiguity rather than picking — picking is what hands an operator a link to the wrong seller's
goods with nothing on screen saying so.

**C.4 opens with a design question, not a build one.** `inventory_prompt_preferences` is ALREADY
one-per-provider with its own designated authorization, so `stand_providers.reminder_cadence` and
`reminder_authorization_id` are a second home for one fact and remain unread. The likely answer is
to DELETE those two columns rather than read them — two ways to state one thing is what the zen
desk forbids — but it is a decision to make deliberately, with the scheduler pass in view.

**Environment note**: `npm run test:integration` needs `PUBLIC_BASE_URL` exported as well as
`DATABASE_URL`, or eight `farmer-stand` cases fail on a missing config. Identical on the untouched
merged base, so it is an environment fact rather than a regression.

No seam projection, schema, or output contract changed — `packages/ai` and `packages/core` are
untouched, `projectStockOutParse` still projects exactly `{entryId, itemName}`, and `providerId`
appears nowhere in the AI package, with the search proved against a known-present term first. No
live eval run owed.

---
