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
| `YES` / `NO` | Commit / decline the sender's **one live inventory-publication confirmation**. `YES` accepts the fixed variants `Y` / `YEP` / `YEA` / `SURE`; `NO` accepts `N` / `NOPE` / `NAH` / `NO THANKS` / `NO THANK YOU`. **Context-bound** — a YES/NO reply with no live pending inventory proposal does **not** commit or decline. A valid confirmation consumes the current proposal **exactly once** and **expires** (GC'd). |

A database constraint permits at most one open inventory proposal per sender. It carries its allowed
tokens, proposal version, expiry, and current prompt activation. New inventory text revises that
proposal and suspends token acceptance until Telnyx accepts the replacement prompt. A token whose
provider occurrence time does not follow the current prompt cannot consume the proposal.

The exact expiry window is an unresolved launch decision.
An expired token gets an honest "that request expired — here's how to redo it" reply, never a
silent no-op.

`YES`/`NO` are **never global** and never override `STOP`/`HELP`/`FLAG`. `OUT` and `IGNORE` are not
commitment tokens and can never publish inventory. A stock-out alert may ask the farmer to send
current inventory; that reply uses the ordinary proposal and `YES`/`NO` flow.

### Concurrent and out-of-order messages

After raw-body signature verification, a minimized inbox event commits before acknowledgement.
Provider event ID uniqueness makes retries and duplicates no-ops. Postgres claims at most one
ordinary stateful event per sender; no model or SMS call occurs while its row lock transaction is
open.

Ordinary stateful events are ordered by provider `occurred_at` plus event ID. An older event cannot
mutate newer conversation, confirmation, or publication state and may receive a deterministic
resend request. `STOP` and `START` use a separate consent-transition watermark: the later
provider-time command wins, and `STOP` wins an exact timestamp tie. An older delayed `START`
therefore cannot restore consent after a newer `STOP`.

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
- The atomic outbox dispatch claim is the STOP boundary. STOP committed first suppresses every
  still-queued non-required message; a request dispatch-authorized first may already be in flight.
- Retry only definitive retryable rejection under a bounded policy. Record a possibly accepted
  result as ambiguous and do not automatically resend it without a verified Telnyx idempotency
  facility.
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

> *Current drift:* the registered/public 10DLC source copy still advertises `OUT` and `IGNORE` for
> stock-out alerts. F-012 must align that copy with this approved behavior before public SMS launch.
