# Farm Friend — SMS Compliance

Keywords, consent, required behavior, and the FLAG safety rail. SMS is the **critical path** daily
driver; **A2P 10DLC is assumed approved by launch** (Eat Vashon week). All copy here is
**provisional** until the campaign is registered. Routing mechanics are in
[ARCHITECTURE.md](ARCHITECTURE.md); consent data in [DATA_ARCHITECTURE.md](DATA_ARCHITECTURE.md).

## Deterministic keyword handling (code, before any model call)

Every inbound message is parsed by **code first**, in the fixed order in ARCHITECTURE §routing.

### Compliance keywords (always handled by code)

| Keyword | Behavior |
|---|---|
| `STOP` / `UNSUBSCRIBE` / `END` / `QUIT` | **Global** opt-out of all SMS. Clears `global_sms` immediately. **Can never be reinterpreted by conversation state.** Send the single confirming opt-out reply, then nothing further. |
| `START` | Re-subscribe (re-set `global_sms`). |
| `JOIN` | Opt into a program (per-program consent). |
| `HELP` / `INFO` | Return help text; never suppressed by state. |

### Commitment tokens (context-bound, never global)

| Token | Behavior |
|---|---|
| `YES` / `NO` | Commit / decline the **live pending confirmation** (publish, activation, or gleaning signup). **Context-bound** — a `YES` with no pending context does **not** commit. Commits **exactly once**; the pending confirmation **expires** (GC'd). |
| `OUT` / `IGNORE` | Farmer action on a stock-out alert (`OUT` = mark the item out; `IGNORE` = dismiss). Context-bound to the alert. |

`YES`/`NO`/`OUT`/`IGNORE` are **never global** and never override `STOP`/`HELP`/`FLAG`.

### The FLAG safety rail

`FLAG` **pauses the thread** and **creates a review item** for VIGA staff (the human-handoff).
Once public SMS is live (untrusted inbound), the flag-review UI + thread viewer (**F-009**) is a
**hard pre-launch gate** — compliance requires the rail before public SMS. `FLAG` is handled by
code, upstream of any model call.

## Consent model

- **`global_sms`** — the top-level SMS consent. `STOP` clears it; `START` re-sets it. No SMS is
  sent to a person without it.
- **Per-program opt-in** — each program (inventory publish, stock-out alerts, gleaning) requires
  its own opt-in via `JOIN` / program enrollment. A farmer opted into publish is not thereby
  opted into gleaning.
- Consent lives in `subscriptions`; consent decisions are **pure code, never a model call**.

## Required behavior

- Honor opt-out **immediately** and durably.
- Every program message is attributable to a consented recipient (code checks consent before send).
- Outbound passes the **redaction guard** — no raw phone numbers / private fields, regardless of
  model output (see [AI_ARCHITECTURE.md](AI_ARCHITECTURE.md) §safety boundary).
- Raw inbound bodies are **TTL-bounded**; the phone is stored **hashed**.

## Provisional copy

Message templates (opt-out confirmation, help text, publish confirm, activation confirm, stock-out
alert) are drafted provisionally and finalized at A2P registration. Keep them in one place so the
registered copy is a single swap; none of the copy is a compliance *enforcement* point — the
enforcement is the deterministic code above.
