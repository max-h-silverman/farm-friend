import type {
  Clock,
  ConsentCaptureSource,
  ConsentState,
  LaunchConsentRecord,
  LaunchMessageCategory,
} from "@farm-friend/core";
import { confirmationEligibility, isProactiveSendPermitted } from "@farm-friend/core";
import type postgres from "postgres";
import type { Db } from "./index";

// The authoritative SMS transactions (F-014).
//
// One verified provider event produces at most one current, authorized durable
// consequence and one safely dispatched response. Every guarantee here is a database
// transaction with real locks and constraints — not an application convention:
//
//   - durable acceptance before acknowledgement, deduplicated by provider event ID;
//   - at most one claimed inbound event per sender, recoverable after an abandoned claim;
//   - conversation ordering that fails closed on stale events;
//   - consent ordered on its own watermark, so an older START cannot undo a newer STOP;
//   - one open proposal per sender, published exactly once after rechecking authority;
//   - a dispatch claim that is STOP's honest linearization point.
//
// External SMS and model calls never happen inside these transactions: they commit the
// decision and the outbox work, and workers perform the I/O and record the outcome.

/** How long a confirmation stays live after Telnyx accepts its current prompt. */
export const CONFIRMATION_WINDOW_MS = 12 * 60 * 60 * 1000;

/** How long a worker may hold an inbound claim before it is recoverable. */
export const DEFAULT_CLAIM_TTL_MS = 5 * 60 * 1000;

/** Telnyx dispatch attempts are bounded by the schema; keep the policy in one place. */
export const MAX_DISPATCH_ATTEMPTS = 3;

/**
 * How long a dispatch authorization may stay unresolved before it is recoverable (GL-003).
 *
 * `authorizeDispatch` commits `dispatching` before the worker reads the body, resolves a
 * number, calls the provider, and records the outcome. If the process dies in that window
 * the row has no other way back — outbound enumeration selects `queued` only.
 *
 * Generous on purpose. The deadline must clear the slowest plausible provider call plus the
 * worker's own retry, because expiring a lease on a call that is merely slow would quarantine
 * work that is about to succeed. Bounded recovery matters more than fast recovery here: the
 * consequence of waiting is a delayed reply, and the consequence of rushing is a duplicate
 * SMS to a real person.
 */
export const DISPATCH_LEASE_MS = 10 * 60 * 1000;

type Sql = ReturnType<typeof postgres>;
type Tx = postgres.TransactionSql<Record<string, unknown>>;

function driver(db: Db): Sql {
  return db.sql;
}

export type ProviderEventInput =
  | {
      providerEventId: string;
      eventType: "message_received";
      providerMessageId: string;
      senderHash: string;
      body: string | null;
      occurredAt: Date;
      /** How long the minimized body may be retained. */
      bodyExpiresAt?: Date;
    }
  | {
      providerEventId: string;
      eventType: "message_sent" | "message_finalized";
      dispatchAttemptId: string;
      deliveryStatus: "sent" | "delivered" | "delivery_failed";
      occurredAt: Date;
    };

export interface AcceptedProviderEvent {
  /** False when this event was already accepted — a duplicate is a successful no-op. */
  accepted: boolean;
  inboxEventId: string;
}

const DEFAULT_BODY_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Commit the minimized inbox projection for a verified provider event. The caller has
 * already verified the Telnyx signature over the raw bytes; the raw envelope is never
 * stored. Acknowledgement happens only after this commits.
 */
export async function acceptProviderEvent(
  db: Db,
  event: ProviderEventInput,
): Promise<AcceptedProviderEvent> {
  return driver(db).begin(async (tx) => {
    const existing = await tx`
      select id from provider_inbox_events
      where provider_event_id = ${event.providerEventId}
    `;
    if (existing.length > 0) {
      return { accepted: false, inboxEventId: existing[0]?.id as string };
    }

    if (event.eventType === "message_received") {
      const bodyExpiresAt =
        event.bodyExpiresAt ??
        new Date(event.occurredAt.getTime() + DEFAULT_BODY_TTL_MS);

      // The message is minimized and deduplicated on the provider message ID, so a
      // retried event reuses the same durable row rather than storing it twice.
      const message = await tx`
        insert into sms_messages (
          provider_message_id, sender_hash, body, body_expires_at, received_at
        )
        values (
          ${event.providerMessageId}, ${event.senderHash}, ${event.body},
          ${event.body === null ? null : bodyExpiresAt}, ${event.occurredAt}
        )
        on conflict (provider_message_id) do update
          set provider_message_id = excluded.provider_message_id
        returning id
      `;

      const inserted = await tx`
        insert into provider_inbox_events (
          provider_event_id, event_type, message_id, sender_hash, occurred_at
        )
        values (
          ${event.providerEventId}, 'message_received', ${message[0]?.id as string},
          ${event.senderHash}, ${event.occurredAt}
        )
        on conflict (provider_event_id) do nothing
        returning id
      `;
      if (inserted.length === 0) {
        const raced = await tx`
          select id from provider_inbox_events
          where provider_event_id = ${event.providerEventId}
        `;
        return { accepted: false, inboxEventId: raced[0]?.id as string };
      }
      return { accepted: true, inboxEventId: inserted[0]?.id as string };
    }

    const inserted = await tx`
      insert into provider_inbox_events (
        provider_event_id, event_type, dispatch_attempt_id, delivery_status, occurred_at
      )
      values (
        ${event.providerEventId}, ${event.eventType}, ${event.dispatchAttemptId},
        ${event.deliveryStatus}, ${event.occurredAt}
      )
      on conflict (provider_event_id) do nothing
      returning id
    `;
    if (inserted.length === 0) {
      const raced = await tx`
        select id from provider_inbox_events
        where provider_event_id = ${event.providerEventId}
      `;
      return { accepted: false, inboxEventId: raced[0]?.id as string };
    }
    return { accepted: true, inboxEventId: inserted[0]?.id as string };
  }) as Promise<AcceptedProviderEvent>;
}

export interface ClaimedInboundEvent {
  inboxEventId: string;
  senderHash: string;
  messageId: string;
  body: string | null;
  occurredAt: Date;
  /**
   * The PROVIDER's event ID, distinct from `inboxEventId` (our row's UUID). Routing needs
   * it because the consent watermark and the confirmation audit trail record provenance by
   * provider event ID; substituting our own row ID would record a value that corresponds to
   * nothing at the provider and would break the STOP/START tie-break ordering, which
   * compares provider event IDs.
   */
  providerEventId: string;
  /**
   * True when this event predates the sender's accepted conversation watermark. The
   * caller must not mutate conversation, confirmation, or publication state; it may
   * send a deterministic clarification asking the sender to resend.
   */
  isStale: boolean;
  finalize(input: {
    outcome: "processed" | "rejected";
    now: Date;
    failureCode?: string;
  }): Promise<void>;
}

export interface ClaimInboundInput {
  senderHash: string;
  now: Date;
  claimTtlMs?: number;
}

/**
 * Claim the sender's next pending inbound event. A short transaction locks the sender,
 * claims at most one row, and commits — it never spans a model or SMS call. Delivery
 * callbacks are processed by their own path and never enter conversation state.
 */
export async function claimNextInboundEvent(
  db: Db,
  input: ClaimInboundInput,
): Promise<ClaimedInboundEvent | null> {
  const sql = driver(db);
  const ttl = input.claimTtlMs ?? DEFAULT_CLAIM_TTL_MS;

  const claimed = await sql.begin(async (tx) => {
    // Serialize this sender's stateful work. The row lock is the whole point: two
    // workers cannot both hold conversation work for one sender.
    const senderRows = await tx`
      insert into sender_states (sender_hash, updated_at)
      values (${input.senderHash}, ${input.now})
      on conflict (sender_hash) do update set sender_hash = excluded.sender_hash
      returning sender_hash, conversation_occurred_at, conversation_provider_event_id
    `;
    await tx`
      select sender_hash from sender_states
      where sender_hash = ${input.senderHash}
      for update
    `;

    const alreadyProcessing = await tx`
      select id from provider_inbox_events
      where sender_hash = ${input.senderHash}
        and event_type = 'message_received'
        and state = 'processing'
    `;
    if (alreadyProcessing.length > 0) return null;

    const next = await tx`
      select event.id, event.message_id, event.occurred_at, event.provider_event_id,
             message.body
      from provider_inbox_events as event
      join sms_messages as message on message.id = event.message_id
      where event.sender_hash = ${input.senderHash}
        and event.event_type = 'message_received'
        and event.state = 'pending'
      order by event.occurred_at asc, event.provider_event_id asc
      limit 1
    `;
    if (next.length === 0) return null;

    const row = next[0] as Record<string, unknown>;
    const claimToken = randomClaimToken();
    await tx`
      update provider_inbox_events
      set state = 'processing', claim_token = ${claimToken},
          claimed_at = ${input.now},
          claim_expires_at = ${new Date(input.now.getTime() + ttl)}
      where id = ${row.id as string}
    `;

    const watermark = senderRows[0]?.conversation_occurred_at as Date | null;
    const watermarkEventId = senderRows[0]
      ?.conversation_provider_event_id as string | null;
    const occurredAt = row.occurred_at as Date;
    const providerEventId = row.provider_event_id as string;

    // Fail closed: an event at or before the accepted watermark cannot mutate newer
    // state. Ties break on provider event ID so ordering is total.
    const isStale =
      watermark !== null &&
      (occurredAt < watermark ||
        (occurredAt.getTime() === watermark.getTime() &&
          watermarkEventId !== null &&
          providerEventId <= watermarkEventId));

    return {
      inboxEventId: row.id as string,
      messageId: row.message_id as string,
      body: (row.body as string | null) ?? null,
      occurredAt,
      providerEventId,
      isStale,
    };
  });

  if (!claimed) return null;
  const result = claimed as {
    inboxEventId: string;
    messageId: string;
    body: string | null;
    occurredAt: Date;
    providerEventId: string;
    isStale: boolean;
  };

  return {
    inboxEventId: result.inboxEventId,
    senderHash: input.senderHash,
    messageId: result.messageId,
    body: result.body,
    occurredAt: result.occurredAt,
    providerEventId: result.providerEventId,
    isStale: result.isStale,
    async finalize({ outcome, now, failureCode }) {
      await sql.begin(async (tx) => {
        // Re-lock the sender: a consequence applies only if the claim is still current.
        await tx`
          select sender_hash from sender_states
          where sender_hash = ${input.senderHash} for update
        `;
        await tx`
          update provider_inbox_events
          set state = ${outcome}, claim_token = null, claim_expires_at = null,
              finalized_at = ${now},
              failure_code = ${outcome === "rejected" ? (failureCode ?? "unspecified") : null}
          where id = ${result.inboxEventId} and state = 'processing'
        `;
        // Only a successfully processed, non-stale event advances the watermark.
        if (outcome === "processed" && !result.isStale) {
          await tx`
            update sender_states
            set conversation_occurred_at = ${result.occurredAt},
                conversation_provider_event_id = ${result.providerEventId},
                updated_at = ${now}
            where sender_hash = ${input.senderHash}
          `;
        }
      });
    },
  };
}

function randomClaimToken(): string {
  return globalThis.crypto.randomUUID();
}

/** Release claims whose TTL lapsed so an abandoned inbound event is retried. */
export async function releaseAbandonedClaims(
  db: Db,
  input: { now: Date },
): Promise<number> {
  const released = await driver(db)`
    update provider_inbox_events
    set state = 'pending', claim_token = null, claimed_at = null,
        claim_expires_at = null
    where state = 'processing' and claim_expires_at <= ${input.now}
    returning id
  `;
  return released.length;
}

export interface ConsentTransitionInput {
  recipientHash: string;
  transition: "start" | "stop";
  occurredAt: Date;
  providerEventId: string;
  captureEvidenceRef?: string;
  /**
   * Which registered opt-in keyword established consent (F-016). `JOIN` and `START` are
   * two spellings of the ONE launch program and differ only in recorded provenance —
   * never in what they enroll. Ignored for a `stop` transition, which records none.
   */
  captureSource?: ConsentCaptureSource;
  /**
   * B-011 — this transition may establish consent only when NO consent record exists yet.
   *
   * Set for `JOIN`, which is Farm Friend's own registered opt-in keyword and carries no
   * meaning to the carrier's compliance layer: Telnyx keeps its own opt-out list, only
   * `START` clears it, and while a number is on it every send is refused 409 / 40300. A
   * `JOIN` that "restored" consent would therefore record `active` for someone the carrier
   * blocks — the database and the carrier disagreeing about the same person.
   *
   * Evaluated INSIDE this function's row lock rather than by the caller, because a
   * read-then-write in the caller is a race: two concurrent JOINs could both observe "no
   * record" and both establish consent. `for update` on the watermark is what serializes it.
   */
  firstTimeOnly?: boolean;
}

export interface ConsentTransitionResult {
  applied: boolean;
  state: "active" | "stopped";
  /**
   * Why an unapplied transition was refused. `applied: false` alone is ambiguous, and the
   * two causes need different answers to the sender (B-011):
   *
   * - `stale` — an older event arriving late, refused by the watermark. Says nothing about
   *   the sender's intent; they get the registered copy.
   * - `already_enrolled` — a `firstTimeOnly` JOIN from someone who already has a record.
   *   This is the returning farmer who must be told to text START.
   *
   * Absent when `applied` is true.
   */
  refusal?: "stale" | "already_enrolled";
}

/**
 * Apply STOP/START on their own provider-time watermark, independent of conversation
 * state. The chronologically later command wins and STOP wins an exact tie, so an older
 * START delivered after a newer STOP can never restore consent.
 */
export async function applyConsentTransition(
  db: Db,
  input: ConsentTransitionInput,
): Promise<ConsentTransitionResult> {
  return driver(db).begin(async (tx) => {
    const current = await tx`
      select transition, occurred_at from consent_transition_watermarks
      where recipient_hash = ${input.recipientHash}
      for update
    `;

    if (current.length > 0) {
      const previousAt = current[0]?.occurred_at as Date;
      const previous = current[0]?.transition as "start" | "stop";
      const older = input.occurredAt < previousAt;
      // On an exact tie STOP wins: a start can never displace a stop at the same instant.
      const losesTie =
        input.occurredAt.getTime() === previousAt.getTime() &&
        (input.transition === previous || previous === "stop");

      if (older || losesTie) {
        const state = await tx`
          select state from sms_consents where recipient_hash = ${input.recipientHash}
        `;
        return {
          applied: false,
          state: (state[0]?.state as "active" | "stopped") ?? "stopped",
          refusal: "stale",
        };
      }
    }

    // B-011: JOIN establishes consent only for a sender with no record yet.
    //
    // Enforced by the PRIMARY KEY on `sms_consents.recipient_hash`, not by a read — and this
    // distinction was found by an integration test, not by reasoning. The `for update` above
    // locks EXISTING watermark rows; a genuinely first-time sender has none, so there is
    // nothing to lock and concurrent JOINs are not serialized by it at all. An earlier draft
    // of this guard did `select ... from sms_consents` and refused on a hit, and the
    // 8-claimant race enrolled THREE of them: every transaction read "no record" before any
    // of them wrote one. The comment claiming the lock serialized it was simply wrong.
    //
    // `on conflict do nothing` moves the decision into the unique index, where the database
    // resolves it: exactly one insert reports a row, the losers report none, and they learn
    // it from the write rather than from a stale read. `returning` is what makes the outcome
    // observable — a plain conflict-swallowing insert cannot tell winner from loser.
    //
    // Keyed on the CONSENT row rather than the watermark on purpose: the watermark is written
    // by every transition including ones that do not enroll, so an absent consent row is the
    // honest test of "never opted in".
    if (input.firstTimeOnly) {
      const claimed = await tx`
        insert into sms_consents (
          recipient_hash, state, capture_source, captured_at, capture_evidence_ref, updated_at
        )
        values (
          ${input.recipientHash}, 'active', ${input.captureSource ?? "join"},
          ${input.occurredAt}, ${input.captureEvidenceRef ?? input.providerEventId},
          ${input.occurredAt}
        )
        on conflict (recipient_hash) do nothing
        returning state
      `;

      if (claimed.length === 0) {
        // Someone already holds the record — a returning farmer, or a concurrent JOIN that
        // won the insert. No watermark write either: this command had no consent
        // consequence, and advancing the watermark would let a JOIN mask a later
        // legitimate START arriving at an earlier provider time.
        const existing = await tx`
          select state from sms_consents where recipient_hash = ${input.recipientHash}
        `;
        return {
          applied: false,
          state: (existing[0]?.state as "active" | "stopped") ?? "stopped",
          refusal: "already_enrolled",
        };
      }

      // This transaction established consent. Record the watermark and report it, skipping
      // the generic write below — the consent row is already exactly what it would produce.
      await tx`
        insert into consent_transition_watermarks (
          recipient_hash, transition, occurred_at, provider_event_id
        )
        values (
          ${input.recipientHash}, ${input.transition}, ${input.occurredAt},
          ${input.providerEventId}
        )
        on conflict (recipient_hash) do update
          set transition = excluded.transition,
              occurred_at = excluded.occurred_at,
              provider_event_id = excluded.provider_event_id
      `;
      return { applied: true, state: "active" };
    }

    await tx`
      insert into consent_transition_watermarks (
        recipient_hash, transition, occurred_at, provider_event_id
      )
      values (
        ${input.recipientHash}, ${input.transition}, ${input.occurredAt},
        ${input.providerEventId}
      )
      on conflict (recipient_hash) do update
        set transition = excluded.transition,
            occurred_at = excluded.occurred_at,
            provider_event_id = excluded.provider_event_id
    `;

    const state = input.transition === "start" ? "active" : "stopped";
    if (state === "active") {
      // Both registered opt-in keywords establish the same one launch-program consent;
      // only the provenance differs, so there is one row and no program discriminator.
      const captureSource = input.captureSource ?? "start";
      await tx`
        insert into sms_consents (
          recipient_hash, state, capture_source, captured_at, capture_evidence_ref,
          updated_at
        )
        values (
          ${input.recipientHash}, 'active', ${captureSource}, ${input.occurredAt},
          ${input.captureEvidenceRef ?? input.providerEventId}, ${input.occurredAt}
        )
        on conflict (recipient_hash) do update
          set state = 'active', capture_source = excluded.capture_source,
              captured_at = excluded.captured_at,
              capture_evidence_ref = excluded.capture_evidence_ref,
              updated_at = excluded.updated_at
      `;
    } else {
      // STOP clears consent immediately and applies across all Farm Friend messaging.
      await tx`
        insert into sms_consents (recipient_hash, state, updated_at)
        values (${input.recipientHash}, 'stopped', ${input.occurredAt})
        on conflict (recipient_hash) do update
          set state = 'stopped', updated_at = excluded.updated_at
      `;
    }

    return { applied: true, state };
  }) as Promise<ConsentTransitionResult>;
}

export interface ProposalEntryInput {
  itemName: string;
  quantity?: number;
  unit?: string;
  priceText?: string;
  approximation?: "some" | "limited" | "plentiful";
}

export interface OpenProposalInput {
  senderHash: string;
  salesLocationId: string;
  entries: ProposalEntryInput[];
  now: Date;
  /** Defaults to the location's current published revision. */
  baseRevisionId?: string | null;
  baseIsFirstPublication?: boolean;
  schemaVersion?: string;
}

export interface OpenProposalResult {
  proposalId: string;
  proposalVersion: number;
  /**
   * Record that Telnyx accepted the current confirmation prompt. This starts the
   * 12-hour window; before it, no token can consume the proposal.
   */
  activate(input: {
    providerAcceptedAt: Date;
    outboxLogicalKey: string;
  }): Promise<void>;
}

/**
 * Open the sender's one proposal, or revise it in place. New inventory text always
 * revises the single pending proposal and increments its version, which suspends token
 * acceptance until the replacement prompt is provider-accepted.
 */
export async function openOrReviseProposal(
  db: Db,
  input: OpenProposalInput,
): Promise<OpenProposalResult> {
  const sql = driver(db);

  const opened = (await sql.begin(async (tx) => {
    await tx`
      insert into sender_states (sender_hash, updated_at)
      values (${input.senderHash}, ${input.now})
      on conflict (sender_hash) do update set sender_hash = excluded.sender_hash
    `;
    await tx`
      select sender_hash from sender_states
      where sender_hash = ${input.senderHash} for update
    `;

    let baseRevisionId: string | null;
    let isFirstPublication: boolean;
    if (input.baseIsFirstPublication !== undefined) {
      baseRevisionId = input.baseRevisionId ?? null;
      isFirstPublication = input.baseIsFirstPublication;
    } else {
      const current = await tx`
        select id from inventory_revisions
        where sales_location_id = ${input.salesLocationId} and is_current
      `;
      baseRevisionId = (current[0]?.id as string | undefined) ?? null;
      isFirstPublication = baseRevisionId === null;
    }

    // The pending payload is the complete resulting snapshot, stored as opaque JSON.
    const payload = { entries: input.entries } as unknown as Parameters<
      Tx["json"]
    >[0];
    const existing = await tx`
      select id, proposal_version from inventory_publication_proposals
      where sender_hash = ${input.senderHash} and state = 'open'
      for update
    `;

    if (existing.length > 0) {
      const id = existing[0]?.id as string;
      const nextVersion = (existing[0]?.proposal_version as number) + 1;
      // Revising invalidates the prior activation: the window restarts only once the
      // replacement prompt is accepted.
      await tx`
        update inventory_publication_proposals
        set payload = ${tx.json(payload)},
            proposal_version = ${nextVersion},
            sales_location_id = ${input.salesLocationId},
            base_revision_id = ${baseRevisionId},
            base_is_first_publication = ${isFirstPublication},
            activation_outbox_id = null,
            activated_version = null,
            activated_at = null,
            expires_at = null,
            updated_at = ${input.now}
        where id = ${id}
      `;
      return { proposalId: id, proposalVersion: nextVersion };
    }

    const inserted = await tx`
      insert into inventory_publication_proposals (
        sender_hash, sales_location_id, payload, schema_version, proposal_version,
        yes_token, no_token, base_revision_id, base_is_first_publication,
        created_at, updated_at
      )
      values (
        ${input.senderHash}, ${input.salesLocationId}, ${tx.json(payload)},
        ${input.schemaVersion ?? "1"}, 1, 'YES', 'NO', ${baseRevisionId},
        ${isFirstPublication}, ${input.now}, ${input.now}
      )
      returning id
    `;
    return { proposalId: inserted[0]?.id as string, proposalVersion: 1 };
  })) as { proposalId: string; proposalVersion: number };

  return {
    ...opened,
    async activate({ providerAcceptedAt, outboxLogicalKey }) {
      await sql.begin(async (tx) => {
        const prompt = await tx`
          insert into outbox_work (
            logical_key, recipient_hash, message_category, body, body_expires_at,
            available_at, state, dispatch_authorized_at, completed_at, created_at
          )
          values (
            ${outboxLogicalKey}, ${input.senderHash}, 'inventory_confirmation',
            'Confirm this inventory', ${new Date(providerAcceptedAt.getTime() + DEFAULT_BODY_TTL_MS)},
            ${providerAcceptedAt}, 'sent', ${providerAcceptedAt}, ${providerAcceptedAt},
            ${providerAcceptedAt}
          )
          on conflict (logical_key) do update set logical_key = excluded.logical_key
          returning id
        `;
        const version = await tx`
          select proposal_version from inventory_publication_proposals
          where id = ${opened.proposalId}
        `;
        await tx`
          update inventory_publication_proposals
          set activation_outbox_id = ${prompt[0]?.id as string},
              activated_version = ${version[0]?.proposal_version as number},
              activated_at = ${providerAcceptedAt},
              expires_at = ${new Date(providerAcceptedAt.getTime() + CONFIRMATION_WINDOW_MS)},
              updated_at = ${providerAcceptedAt}
          where id = ${opened.proposalId}
        `;
      });
    },
  };
}

export interface ConfirmPublicationInput {
  proposalId: string;
  senderHash: string;
  token: "yes" | "no";
  occurredAt: Date;
  providerEventId: string;
  clock: Clock;
}

export type ConfirmPublicationResult =
  | { status: "published"; revisionId: string }
  | { status: "declined" }
  | { status: "not_activated" }
  | { status: "awaiting_new_prompt" }
  | { status: "predates_activation" }
  | { status: "expired" }
  | { status: "base_conflict" }
  | { status: "not_authorized" }
  | { status: "not_approved" }
  | { status: "already_consumed" }
  | { status: "no_open_proposal" };

/**
 * Consume the sender's one open proposal exactly once. The transaction locks the sender
 * and the pending row, rechecks the prompt/version, expiry, base revision, current
 * farmer authority and VIGA approval, then publishes and queues the response together.
 *
 * `YES` publishes exactly the stored complete snapshot — never a replayed delta.
 */
export async function confirmInventoryPublication(
  db: Db,
  input: ConfirmPublicationInput,
): Promise<ConfirmPublicationResult> {
  return driver(db).begin(async (tx) => {
    await tx`
      insert into sender_states (sender_hash, updated_at)
      values (${input.senderHash}, ${input.occurredAt})
      on conflict (sender_hash) do update set sender_hash = excluded.sender_hash
    `;
    await tx`
      select sender_hash from sender_states
      where sender_hash = ${input.senderHash} for update
    `;

    const rows = await tx`
      select * from inventory_publication_proposals
      where id = ${input.proposalId} and sender_hash = ${input.senderHash}
      for update
    `;
    if (rows.length === 0) return { status: "no_open_proposal" };
    const proposal = rows[0] as Record<string, unknown>;
    if (proposal.state !== "open") return { status: "already_consumed" };

    const salesLocationId = proposal.sales_location_id as string;
    const currentRevision = await tx`
      select id from inventory_revisions
      where sales_location_id = ${salesLocationId} and is_current
    `;
    const currentRevisionId = (currentRevision[0]?.id as string | undefined) ?? null;

    const eligibility = confirmationEligibility(
      {
        proposalVersion: proposal.proposal_version as number,
        activatedVersion: (proposal.activated_version as number | null) ?? null,
        activatedAt: (proposal.activated_at as Date | null) ?? null,
        expiresAt: (proposal.expires_at as Date | null) ?? null,
        baseRevisionId: (proposal.base_revision_id as string | null) ?? null,
      },
      {
        occurredAt: input.occurredAt,
        currentRevisionId,
        clock: input.clock,
      },
    );

    if (eligibility.status === "expired") {
      // An expired proposal is garbage-collected without changing published inventory.
      await tx`
        update inventory_publication_proposals
        set state = 'expired', closed_at = ${input.occurredAt}, updated_at = ${input.occurredAt}
        where id = ${input.proposalId}
      `;
      return { status: "expired" };
    }
    if (eligibility.status === "base_conflict") {
      // Published state moved: invalidate honestly and require regeneration.
      await tx`
        update inventory_publication_proposals
        set state = 'invalidated', closed_at = ${input.occurredAt}, updated_at = ${input.occurredAt}
        where id = ${input.proposalId}
      `;
      return { status: "base_conflict" };
    }
    if (eligibility.status !== "eligible") {
      return { status: eligibility.status };
    }

    if (input.token === "no") {
      await tx`
        update inventory_publication_proposals
        set state = 'declined', consumed_token = 'no',
            consumption_provider_event_id = ${input.providerEventId},
            closed_at = ${input.occurredAt}, updated_at = ${input.occurredAt}
        where id = ${input.proposalId}
      `;
      await queueOutbox(tx, {
        logicalKey: `proposal-declined-${input.proposalId}-${proposal.proposal_version as number}`,
        recipientHash: input.senderHash,
        messageCategory: "inquiry_reply",
        body: "No problem — your listing is unchanged.",
        now: input.occurredAt,
      });
      return { status: "declined" };
    }

    // Authority and approval are re-read while the locks are held: a revocation that
    // committed after the prompt was sent must prevent publication.
    const location = await tx`
      select farm_id from sales_locations where id = ${salesLocationId}
    `;
    const farmId = location[0]?.farm_id as string;

    const authorization = await tx`
      select farmer.id from farmer_authorizations as farmer
      join contacts on contacts.id = farmer.contact_id
      where farmer.farm_id = ${farmId}
        and contacts.phone_hash = ${input.senderHash}
        and farmer.revoked_at is null
    `;
    if (authorization.length === 0) return { status: "not_authorized" };

    const approval = await tx`
      select id from farm_approvals
      where farm_id = ${farmId} and revoked_at is null
    `;
    if (approval.length === 0) return { status: "not_approved" };

    await tx`
      update inventory_publication_proposals
      set state = 'accepted', consumed_token = 'yes',
          consumption_provider_event_id = ${input.providerEventId},
          closed_at = ${input.occurredAt}, updated_at = ${input.occurredAt}
      where id = ${input.proposalId}
    `;

    if (currentRevisionId !== null) {
      await tx`
        update inventory_revisions
        set is_current = false, superseded_at = ${input.occurredAt}
        where id = ${currentRevisionId}
      `;
    }

    const revision = await tx`
      insert into inventory_revisions (
        farm_id, sales_location_id, proposal_id, published_by_authorization_id,
        farm_approval_id, published_at
      )
      values (
        ${farmId}, ${salesLocationId}, ${input.proposalId},
        ${authorization[0]?.id as string}, ${approval[0]?.id as string},
        ${input.occurredAt}
      )
      returning id
    `;
    const revisionId = revision[0]?.id as string;

    const payload = proposal.payload as { entries?: ProposalEntryInput[] };
    const entries = payload.entries ?? [];
    for (const [index, entry] of entries.entries()) {
      await tx`
        insert into inventory_entries (
          inventory_revision_id, sales_location_id, item_name, quantity, unit,
          price_text, approximation, sort_order
        )
        values (
          ${revisionId}, ${salesLocationId}, ${entry.itemName},
          ${entry.quantity ?? null}, ${entry.unit ?? null}, ${entry.priceText ?? null},
          ${entry.approximation ?? null}, ${index}
        )
      `;
    }

    await queueOutbox(tx, {
      logicalKey: `inventory-published-${revisionId}`,
      recipientHash: input.senderHash,
      messageCategory: "inquiry_reply",
      body: "Your listing is updated. Thank you!",
      now: input.occurredAt,
    });

    return { status: "published", revisionId };
  }) as Promise<ConfirmPublicationResult>;
}

async function queueOutbox(
  tx: Tx,
  input: {
    logicalKey: string;
    recipientHash: string;
    /** Which launch category this is; the dispatch claim reads it for consent. */
    messageCategory: LaunchMessageCategory;
    body: string;
    now: Date;
  },
): Promise<void> {
  await tx`
    insert into outbox_work (
      logical_key, recipient_hash, message_category, body, body_expires_at,
      available_at, created_at
    )
    values (
      ${input.logicalKey}, ${input.recipientHash}, ${input.messageCategory},
      ${input.body},
      ${new Date(input.now.getTime() + DEFAULT_BODY_TTL_MS)}, ${input.now},
      ${input.now}
    )
    on conflict (logical_key) do nothing
  `;
}

export type DispatchAuthorization =
  | { status: "authorized"; dispatchAttemptId: string; attemptNumber: number }
  | { status: "suppressed" }
  | { status: "unavailable" };

/**
 * Atomically claim one queued outbox row for dispatch. This commit is STOP's honest
 * linearization point: STOP committed first suppresses still-queued non-required work,
 * while work authorized first may already be in flight and is never recalled.
 */
export async function authorizeDispatch(
  db: Db,
  input: { outboxWorkId: string; now: Date },
): Promise<DispatchAuthorization> {
  return driver(db).begin(async (tx) => {
    const rows = await tx`
      select id, recipient_hash, state, message_category from outbox_work
      where id = ${input.outboxWorkId}
      for update
    `;
    if (rows.length === 0) return { status: "unavailable" };
    const work = rows[0] as Record<string, unknown>;
    if (work.state !== "queued") return { status: "unavailable" };

    // F-016 — the one launch program decides this, and the decision itself is the pure
    // predicate in core. Note it asks for ACTIVE consent, not merely "not stopped":
    // a recipient with no consent row never opted in, and silence is not permission.
    const consent = await tx`
      select state, capture_source from sms_consents
      where recipient_hash = ${work.recipient_hash as string}
    `;
    const record = consent[0]
      ? ({
          state: consent[0].state as ConsentState,
          ...(consent[0].capture_source
            ? { captureSource: consent[0].capture_source as ConsentCaptureSource }
            : {}),
        } satisfies LaunchConsentRecord)
      : null;

    const category = work.message_category as LaunchMessageCategory;

    if (!isProactiveSendPermitted({ consent: record, category })) {
      await tx`
        update outbox_work
        set state = 'suppressed', completed_at = ${input.now}
        where id = ${input.outboxWorkId}
      `;
      return { status: "suppressed" };
    }

    const prior = await tx`
      select coalesce(max(attempt_number), 0)::integer as attempts
      from outbox_dispatch_attempts where outbox_work_id = ${input.outboxWorkId}
    `;
    const attemptNumber = ((prior[0]?.attempts as number) ?? 0) + 1;
    if (attemptNumber > MAX_DISPATCH_ATTEMPTS) {
      await tx`
        update outbox_work
        set state = 'failed', completed_at = ${input.now}
        where id = ${input.outboxWorkId}
      `;
      return { status: "unavailable" };
    }

    await tx`
      update outbox_work
      set state = 'dispatching', dispatch_authorized_at = ${input.now}
      where id = ${input.outboxWorkId}
    `;
    const attempt = await tx`
      insert into outbox_dispatch_attempts (
        outbox_work_id, attempt_number, state, started_at
      )
      values (${input.outboxWorkId}, ${attemptNumber}, 'authorized', ${input.now})
      returning id
    `;

    return {
      status: "authorized",
      dispatchAttemptId: attempt[0]?.id as string,
      attemptNumber,
    };
  }) as Promise<DispatchAuthorization>;
}

export interface DispatchResultInput {
  dispatchAttemptId: string;
  outcome: "accepted" | "definitive_rejection" | "ambiguous";
  providerMessageId?: string;
  errorCode?: string;
  /** B-010: the provider's machine token (e.g. Telnyx `40300`). Diagnostic today; validated
   *  as a token at capture, so a future rule could key on it. */
  providerCode?: string;
  /** B-010: the provider's own sentence, already phone-masked and length-bounded. */
  providerErrorDetail?: string;
  now: Date;
}

/**
 * Record what the provider said. A definitive retryable rejection may return the work to
 * the queue within the bounded attempt policy; a result that may have been accepted is
 * quarantined as ambiguous and never automatically resent.
 */
export async function recordDispatchResult(
  db: Db,
  input: DispatchResultInput,
): Promise<{ retryable: boolean }> {
  return driver(db).begin(async (tx) => {
    const attempts = await tx`
      select outbox_work_id, attempt_number from outbox_dispatch_attempts
      where id = ${input.dispatchAttemptId} for update
    `;
    const workId = attempts[0]?.outbox_work_id as string;
    const attemptNumber = attempts[0]?.attempt_number as number;

    await tx`
      update outbox_dispatch_attempts
      set state = ${input.outcome}, completed_at = ${input.now},
          provider_message_id = ${input.providerMessageId ?? null},
          error_code = ${input.errorCode ?? null},
          provider_code = ${input.providerCode ?? null},
          provider_error_detail = ${input.providerErrorDetail ?? null}
      where id = ${input.dispatchAttemptId}
    `;

    if (input.outcome === "accepted") {
      await tx`
        update outbox_work set state = 'sent', completed_at = ${input.now}
        where id = ${workId}
      `;
      return { retryable: false };
    }

    if (input.outcome === "ambiguous") {
      // The provider may have accepted it. Resending could duplicate a real SMS.
      await tx`
        update outbox_work set state = 'ambiguous', completed_at = ${input.now}
        where id = ${workId}
      `;
      return { retryable: false };
    }

    const retryable = attemptNumber < MAX_DISPATCH_ATTEMPTS;
    if (retryable) {
      await tx`
        update outbox_work
        set state = 'queued', dispatch_authorized_at = null, completed_at = null
        where id = ${workId}
      `;
    } else {
      await tx`
        update outbox_work set state = 'failed', completed_at = ${input.now}
        where id = ${workId}
      `;
    }
    return { retryable };
  }) as Promise<{ retryable: boolean }>;
}

/**
 * Quarantine dispatch claims abandoned past their lease (GL-003).
 *
 * ## Why these rows exist at all
 *
 * `authorizeDispatch` commits `state = 'dispatching'` and an `authorized` attempt, and only
 * then does the worker read the body, resolve the recipient's number, call the provider, and
 * record the result. Every one of those steps can throw, and the process can simply die. The
 * row is then stranded: `releaseAbandonedClaims` recovers inbound events only, and outbound
 * enumeration selects `queued`, so nothing ever looks at it again. The reply is never sent,
 * never retried, and invisible to an operator.
 *
 * ## Why the outcome is `ambiguous` and never `queued`
 *
 * We do not know whether the provider accepted the message before we lost the thread. The
 * carrier may already have delivered it to a real person's handset. Returning the row to
 * `queued` would resend it — the one failure mode this system refuses everywhere else
 * (`recordDispatchResult` quarantines a genuinely ambiguous provider result for exactly this
 * reason). So recovery resolves the row into that same existing state rather than inventing a
 * new one, and a recovered row is never re-authorized. An operator decides what to do with it.
 *
 * A resend would be safe only with verified provider-side idempotency over our key. Telnyx
 * offers no such guarantee we have tested, so this does not assume one.
 *
 * ## Exactly once under concurrent passes
 *
 * `for update skip locked` over the expired rows: two passes partition the work instead of
 * both resolving the same row or blocking on it. The `state = 'dispatching'` filter inside
 * the same transaction is what makes a second pass a no-op rather than a double write.
 *
 * Returns a COUNT only — outbound work correlates to a recipient, so nothing identifying
 * leaves this function.
 */
export async function recoverAbandonedDispatches(
  db: Db,
  input: { now: Date; limit?: number },
): Promise<number> {
  const limit = input.limit ?? 25;
  const deadline = new Date(input.now.getTime() - DISPATCH_LEASE_MS);

  return driver(db).begin(async (tx) => {
    const stranded = await tx`
      select id from outbox_work
      where state = 'dispatching'
        and dispatch_authorized_at is not null
        and dispatch_authorized_at <= ${deadline}
      order by dispatch_authorized_at asc
      limit ${limit}
      for update skip locked
    `;
    if (stranded.length === 0) return 0;

    const ids = stranded.map((row) => (row as Record<string, unknown>).id as string);

    // Resolve the open attempt too. Left `authorized`, it reads as still in flight forever
    // and would corrupt any operator diagnostic counting outstanding sends. The error code
    // is a fixed machine token, not provider text: no provider ever answered us.
    await tx`
      update outbox_dispatch_attempts
      set state = 'ambiguous', completed_at = ${input.now},
          error_code = 'dispatch_lease_expired'
      where outbox_work_id = any(${ids}) and state = 'authorized'
    `;

    const recovered = await tx`
      update outbox_work
      set state = 'ambiguous', completed_at = ${input.now}
      where id = any(${ids}) and state = 'dispatching'
      returning id
    `;

    return recovered.length;
  }) as Promise<number>;
}

/**
 * Apply a delivery webhook to its outbound work. State advances by provider occurrence
 * time only; a duplicate is a no-op and a late event never regresses a terminal result.
 */
export async function applyDeliveryEvent(
  db: Db,
  input: {
    dispatchAttemptId: string;
    deliveryStatus: "sent" | "delivered" | "delivery_failed";
    occurredAt: Date;
    providerEventId: string;
  },
): Promise<void> {
  await driver(db).begin(async (tx) => {
    const attempts = await tx`
      select outbox_work_id from outbox_dispatch_attempts
      where id = ${input.dispatchAttemptId}
    `;
    if (attempts.length === 0) return;
    const workId = attempts[0]?.outbox_work_id as string;

    const rows = await tx`
      select delivery_occurred_at, delivery_event_id from outbox_work
      where id = ${workId} for update
    `;
    const previousAt = rows[0]?.delivery_occurred_at as Date | null;
    const previousEvent = rows[0]?.delivery_event_id as string | null;

    if (previousEvent === input.providerEventId) return;
    if (previousAt !== null && input.occurredAt <= previousAt) return;

    await tx`
      update outbox_work
      set delivery_status = ${input.deliveryStatus},
          delivery_occurred_at = ${input.occurredAt},
          delivery_event_id = ${input.providerEventId}
      where id = ${workId}
    `;
  });
}

export interface DeliveryPassResult {
  /** Delivery callbacks claimed and applied this pass. */
  applied: number;
}

/** How many delivery callbacks one pass will consume. */
const DEFAULT_DELIVERY_BATCH = 100;

/**
 * Claim and apply the delivery callbacks the webhook durably stored (B-012).
 *
 * The webhook verifies, minimizes, correlates, and stores `message.sent` /
 * `message.finalized` — and before this, nothing ever read them. Every callback sat
 * `pending` forever, so `outbox_work.delivery_status` stayed NULL and `sent` in the outbox
 * meant only "the provider accepted it", never "the carrier delivered it".
 *
 * **Why this is not the inbound path.** A delivery callback is not per-sender
 * conversational work: it carries no sender, no body, and no conversational meaning. The
 * schema encodes that already — `provider_inbox_events_minimal_projection_per_event_type`
 * forbids a `sender_hash` on a delivery row, and the one-claim-per-sender index is scoped
 * `where event_type = 'message_received'`. Routing these through `claimNextInboundEvent`
 * would serialize unrelated carrier traffic behind a farmer's conversation and would risk
 * advancing a conversation watermark from an outbound event, which would make that
 * sender's next real message look stale and be rejected.
 *
 * **Exactly once.** The claim is `for update skip locked`, so concurrent passes partition
 * the work rather than duplicating or blocking on it. Application is idempotent
 * independently of the claim: `applyDeliveryEvent` ignores a repeat of the same provider
 * event ID and any event at or before the row's current delivery instant, so a claim that
 * lapses and is recovered re-applies to the same watermark rather than writing twice.
 *
 * Bounded like every other pass, and it returns a COUNT only — a delivery row correlates
 * to a recipient, so nothing identifying leaves this function.
 */
export async function applyPendingDeliveryEvents(
  db: Db,
  input: { now: Date; limit?: number },
): Promise<DeliveryPassResult> {
  const limit = input.limit ?? DEFAULT_DELIVERY_BATCH;
  const sql = driver(db);

  // Claim in one transaction. `skip locked` is what makes eight simultaneous passes safe:
  // a row another pass already holds is passed over rather than waited on.
  const claimed = (await sql.begin(async (tx) => {
    const rows = await tx`
      select id, dispatch_attempt_id, delivery_status, occurred_at, provider_event_id
      from provider_inbox_events
      where state = 'pending'
        and event_type in ('message_sent', 'message_finalized')
      order by occurred_at asc, provider_event_id asc
      limit ${limit}
      for update skip locked
    `;
    if (rows.length === 0) return [];

    // `coherent_claim_state` requires a claim token and expiry on a processing row, so the
    // claim is a real one and lapses like any other — `releaseAbandonedClaims` is not
    // scoped to inbound events and already recovers these.
    const ids = rows.map((row) => (row as Record<string, unknown>).id as string);
    await tx`
      update provider_inbox_events
      set state = 'processing', claim_token = ${randomClaimToken()},
          claimed_at = ${input.now},
          claim_expires_at = ${new Date(input.now.getTime() + DEFAULT_CLAIM_TTL_MS)}
      where id in ${tx(ids)}
    `;
    return rows;
  })) as Record<string, unknown>[];

  let applied = 0;
  for (const row of claimed) {
    // Application is its own transaction, taking the `outbox_work` row lock. A failure
    // here leaves the claim to lapse and be recovered rather than losing the callback.
    await applyDeliveryEvent(db, {
      dispatchAttemptId: row.dispatch_attempt_id as string,
      deliveryStatus: row.delivery_status as
        | "sent"
        | "delivered"
        | "delivery_failed",
      occurredAt: row.occurred_at as Date,
      providerEventId: row.provider_event_id as string,
    });

    await sql`
      update provider_inbox_events
      set state = 'processed', claim_token = null, claim_expires_at = null,
          finalized_at = ${input.now}
      where id = ${row.id as string} and state = 'processing'
    `;
    applied += 1;
  }

  return { applied };
}

export interface RetentionPassResult {
  /** Inbound message bodies cleared this pass. */
  messageBodiesPurged: number;
  /** Outbound bodies cleared this pass. */
  outboxBodiesPurged: number;
  /** Expired inbound bodies retained because their thread is under flag review. */
  exempted: number;
}

/** How many rows of each kind one pass will touch. */
const DEFAULT_RETENTION_BATCH = 500;

/**
 * Delete raw message context whose retention window has closed (F-026).
 *
 * Golden Rule #5 promises raw context is short-lived. Every body is written with a
 * `body_expires_at`; before this function nothing acted on it, so the promise was a claim
 * rather than a mechanism. This is the mechanism.
 *
 * **What goes:** the body text, and nothing else. **What stays:** the minimized durable
 * projection — the `sms_messages` row, its `provider_inbox_events` projection, dispatch
 * attempts, flags, and audit events. Retention is selective: the record that a message
 * existed is what makes the system auditable; its contents are what the minimization
 * posture exists to shed.
 *
 * **The flagged-thread exemption.** A body whose inbox event carries an OPEN flag is
 * retained — flag review needs a readable thread, and purging evidence out from under an
 * open safety review is irreversible in a way that over-retention is not. The exemption is
 * therefore written to fail SAFE: the purge only touches a row it can positively show has
 * no open flag. `disposeFlag` (F-030, packages/db/src/review.ts) is what ends the exemption —
 * resolution and dismissal both do, since the predicate is `status = 'open'`. There is no
 * grace period after disposal: the very next pass clears the body.
 *
 * **Nothing here is logged.** A purge that reported what it deleted would defeat its own
 * purpose, so the result is counts only — never a body, an ID, or a phone.
 *
 * Bounded and idempotent: each statement takes at most `limit` rows, skips rows another
 * pass has locked, and matches only rows that still have a body, so a second pass over the
 * same data does nothing.
 */
export async function purgeExpiredBodies(
  db: Db,
  input: { now: Date; limit?: number },
): Promise<RetentionPassResult> {
  const limit = input.limit ?? DEFAULT_RETENTION_BATCH;
  const sql = driver(db);

  // Both columns are cleared together: `sms_messages_retained_body_has_expiry` requires
  // body and expiry to be present or absent as a pair, so clearing only the body is not a
  // legal write. The expiry has no meaning once the body it governed is gone.
  //
  // `skip locked` is what makes concurrent passes safe: a row another pass is already
  // clearing is left alone rather than blocking or being counted twice.
  const purgedMessages = await sql`
    update sms_messages
    set body = null, body_expires_at = null
    where id in (
      select m.id from sms_messages m
      where m.body is not null
        and m.body_expires_at is not null
        and m.body_expires_at <= ${input.now}
        and not exists (
          select 1
          from provider_inbox_events e
          join flags f on f.inbox_event_id = e.id
          where e.message_id = m.id and f.status = 'open'
        )
      order by m.body_expires_at asc
      limit ${limit}
      for update of m skip locked
    )
    returning id
  `;

  // Outbound bodies are cleared only once the dispatcher is finished with them.
  // `runOutboundPass` reads `outbox_work.body` to send it, so clearing a queued or
  // dispatching row would race the dispatcher and deliver an empty SMS to a real person.
  // `body` is NOT NULL, so the empty string is the cleared value.
  const purgedOutbox = await sql`
    update outbox_work
    set body = ''
    where id in (
      select w.id from outbox_work w
      where w.body <> ''
        and w.body_expires_at <= ${input.now}
        and w.state in ('sent', 'failed', 'ambiguous', 'suppressed')
      order by w.body_expires_at asc
      limit ${limit}
      for update of w skip locked
    )
    returning id
  `;

  // Counted separately so an operator can see the exemption is doing something without
  // learning anything about the threads it protects.
  const exempt = await sql`
    select count(distinct m.id)::integer as count
    from sms_messages m
    join provider_inbox_events e on e.message_id = m.id
    join flags f on f.inbox_event_id = e.id
    where m.body is not null
      and m.body_expires_at is not null
      and m.body_expires_at <= ${input.now}
      and f.status = 'open'
  `;

  return {
    messageBodiesPurged: purgedMessages.length,
    outboxBodiesPurged: purgedOutbox.length,
    exempted: (exempt[0]?.count as number) ?? 0,
  };
}
