# Farm Friend SMS Compliance

This document is the SMS behavior source of truth until formal A2P 10DLC campaign language is approved.

## Program Identity

Public SMS identity: `Farm Friend`.

The product should use one phone number if carrier campaign design permits it. Users should be able to save a single Farm Friend contact.

## Deterministic Keywords

These keywords must be parsed before any LLM call:

- Opt in: `JOIN`, `START`
- Opt out: `STOP`, `UNSUBSCRIBE`, `END`, `QUIT`
- Help: `HELP`, `INFO`
- Safety/admin: `FLAG`
- Gleaning response: `YES`, `NO`

`STOP` always unsubscribes the sender from Farm Friend SMS globally according to compliance rules. Do not let active conversation state reinterpret `STOP`.

`JOIN` and `START` create global Farm Friend SMS opt-in. They do not automatically enroll the sender in every program broadcast unless the carrier-approved disclosure and the user's state support that enrollment.

`YES` is never global opt-in. It can confirm a pending action or sign up for a specific opportunity only when state proves the target.

`NO` is not a global command. It can decline, cancel, or release a spot only when pending confirmation or opportunity state proves the target.

## Consent

MVP uses self opt-in for SMS identity and program participation, plus staff/admin-managed onboarding for farmers and VIGA roles. Consent records must store:

- phone/person,
- program,
- consent source,
- timestamp,
- required disclosure version.

Track one global SMS consent plus separate program subscriptions even with one phone number:

- `global_sms`
- `farmstand`
- `gleaning`

Users may participate in one program without the other. Global opt-out overrides every program subscription.

## Required Behavior

- Unknown sender asking farmstand questions can receive public inventory answers without signup. Abuse and infrastructure rate limits may still apply.
- Unknown sender trying to volunteer must be guided to opt in.
- Volunteers must opt into gleaning before receiving broadcasts.
- Farmers must be verified before publishing inventory for a farm.
- VIGA staff must be verified before broadcasting gleaning opportunities.
- Every initiating outbound broadcast includes opt-out language.
- Direct replies, confirmations, and receipts may omit repeated STOP language if campaign rules allow, but STOP must always work.
- `FLAG` requires an admin review UI before public SMS launch because it pauses automation on that thread.

## Safety Rail

Any user can text `FLAG` to pause automation on that thread and create an admin review item.

Use `FLAG` for:

- wrong or confusing reply,
- unsafe instructions,
- bad inventory answer,
- incorrect signup state,
- harassment or interpersonal problem,
- anything requiring human judgment.

## Copy

Exact carrier-approved copy is not settled yet. Once it is approved, it must live in code templates and this doc must point to those templates.

Until then, implementation should keep SMS copy short, plain, and explicit about:

- who the message is from,
- why the user is receiving it,
- what reply is expected,
- how to stop messages.
