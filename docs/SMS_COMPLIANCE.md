# Farm Friend — SMS Compliance

Keywords, consent, required behavior, and the FLAG safety rail. SMS is the **critical path** daily
driver; **A2P 10DLC is assumed approved by launch** (Eat Vashon week). All copy here is
**provisional** until the campaign is registered. Routing mechanics are in
[ARCHITECTURE.md](ARCHITECTURE.md); consent data in [DATA_ARCHITECTURE.md](DATA_ARCHITECTURE.md).

## Deterministic keyword handling (code, before any model call)

Every inbound message is parsed by **code first**, in the fixed order in ARCHITECTURE §routing.

### Token matching (one rule for every keyword and token)

Normalize the message — trim whitespace, uppercase, strip trailing punctuation — then a keyword or
token matches only if it (or one of its **fixed, code-listed variants**) is the **entire
normalized message**. The affirmative accepts `YES` / `Y` / `YEP` / `YEA` / `SURE`; the decline
accepts `NO` / `N` / `NOPE` / `NAH` / `NO THANKS` / `NO THANK YOU`. So `"yes."`, `" YES "`,
`"Yep"`, `"y"`, `"n."`, and `"no thanks"` match, while `"yes, still right"` and
`"no thanks, but change it"` do **not** — they route onward as free text (in an active flow that
means the revision path, whose echoed draft + confirm protects against a garbled read). Matching
is deterministic code — a fixed list, never fuzzy — and near-misses are never "interpreted" into a
commit or decline.

### Compliance keywords (always handled by code)

| Keyword | Behavior |
|---|---|
| `STOP` / `UNSUBSCRIBE` / `END` / `QUIT` | **Global** opt-out of all SMS. Clears `global_sms` immediately. **Can never be reinterpreted by conversation state.** Send the single confirming opt-out reply, then nothing further. |
| `START` | Re-subscribe (re-set `global_sms`). |
| `JOIN` | Opt into a program (per-program consent): `JOIN <program>` enrolls; a bare `JOIN` replies with the available program keywords. |
| `HELP` / `INFO` | Return help text; never suppressed by state. |

### Commitment tokens (context-bound, never global)

| Token | Behavior |
|---|---|
| `YES` / `NO` | Commit / decline the **live pending confirmation** (inventory publication, or a farmer's response to a stock-out report). `YES` accepts the fixed variants `Y` / `YEP` / `YEA` / `SURE`; `NO` accepts `N` / `NOPE` / `NAH` / `NO THANKS` / `NO THANK YOU`. **Context-bound** — a YES/NO reply with no pending context does **not** commit or decline. Commits **exactly once**; the pending confirmation **expires** (GC'd). |
| `OUT` / `IGNORE` | Farmer action on a stock-out alert (`OUT` = mark the item out; `IGNORE` = dismiss). Context-bound to the alert. |

A confirmation token is bound to **its specific pending action and kind**. An affirmative or
negative token must never commit an unrelated pending action.

Expiry windows are a **per-consumer parameter**; exact windows are an unresolved launch decision.
An expired token gets an honest "that request expired — here's how to redo it" reply, never a
silent no-op.

`YES`/`NO`/`OUT`/`IGNORE` are **never global** and never override `STOP`/`HELP`/`FLAG`.

### `MUTE` (scoped, never global)

`MUTE` scopes off a specific disclosed passive follow-up without touching global consent. It is
**not** a substitute for `STOP` and never suppresses required compliance replies.

### The FLAG safety rail

`FLAG` **pauses the thread** and **creates a review item** for the VIGA administrator (the
human-handoff). Once public SMS is live (untrusted inbound), the flag-review UI + thread viewer is
a **hard pre-launch gate**. `FLAG` is handled by code, upstream of any model call.

`FLAG` is a **Farm Friend product safety feature**. It must **not** be represented as a
carrier-mandated keyword in campaign registration or public compliance copy.

## Consent model

- **`global_sms`** — the top-level SMS consent. `STOP` clears it; `START` re-sets it. No
  **proactive** SMS is sent to a person without it. Two standard implied-consent exceptions:
  replying to a message someone just sent us (e.g. a first-time customer inquiry), and the single
  opt-out confirmation after `STOP`.
- **How consent is first captured** — farmers: during web onboarding, including **verification that
  they control the SMS number**, stored with **provenance** (how it was captured, by whom, when) so
  every proactive send traces to a documented opt-in. Customers: by texting in (implied consent to
  the reply) or `JOIN`/`START`.
- **Per-program opt-in** — each program (inventory publication, stock-out alerts) requires its own
  opt-in via `JOIN` / program enrollment. Any **future** Farm Friend program requires **separate
  enrollment**; opting into one is never opting into another. Universal `STOP` applies across all
  Farm Friend messaging regardless of program.
- Consent is a **durable record** (DATA_ARCHITECTURE §minimum durable data); consent decisions are
  **pure code, never a model call**.

## Required behavior

- Honor opt-out **immediately** and durably.
- Every program message is attributable to a consented recipient (code checks consent before send).
- Outbound passes the **redaction guard** — no raw phone numbers / private fields, regardless of
  model output (see [AI_ARCHITECTURE.md](AI_ARCHITECTURE.md) §safety boundary).
- Raw inbound bodies are **short-lived** (exact retention is an unresolved launch decision; flagged
  threads exempt while the flag is open and for a bounded period after resolution); the phone is
  stored **hashed** for lookup/logging (the raw E.164 lives in **exactly one column**, read only by
  the outbound send path — see DATA_ARCHITECTURE §privacy).

## Provisional copy

Message templates (opt-out confirmation, help text, publish confirm, stock-out
alert) are drafted provisionally and finalized at A2P registration. Keep them in one place so the
registered copy is a single swap; none of the copy is a compliance *enforcement* point — the
enforcement is the deterministic code above.
