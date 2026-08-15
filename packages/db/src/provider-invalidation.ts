import type { Db } from "./index";
import type { Sql, Tx } from "./sql";

/*
  F-114 Phase B item 8 — invalidation on pause, revocation, and closure.

  ## What did not exist before this

  Nothing. Closure was read at SEND time (`scheduled-prompts.ts`) and no queued work was ever
  invalidated, so a provider paused after a prompt went out could still have a live confirmation
  token sitting in someone's phone. Answering YES would publish for a listing that is no longer
  public — a customer seeing goods from a seller who had withdrawn them.

  ## The rule, stated once

  A provider state change invalidates THAT PROVIDER's open confirmations and queued reminders.
  A stand shutdown invalidates ALL of them, because a closed stand is locked and no one's goods
  are buyable there — which is exactly the `providerId`-omitted call below, rather than a second
  function. One mechanism with a parameter, not two near-duplicates.

  ## What it deliberately does NOT touch

  - **A proposal the farmer already answered.** `accepted` and `declined` are real acts, and the
    revision an acceptance published is immutable. Rewriting them would erase what somebody did.
    Only `open` proposals are closed, which is also what makes this idempotent.
  - **An outbox row that already sent.** A sent message cannot be recalled; marking it suppressed
    would make the outbox lie about what reached the handset, and the delivery record is what the
    audit trail keeps.

  ## Why this makes the re-open confirmation possible

  §facts and authority: *a paused provider is offered re-opening, never refused.* That works only
  if the old token is dead — otherwise a stale YES publishes silently and the seller is never
  asked. Invalidating here is what forces the next update through a NEW confirmation stating the
  consequence. The prompt itself is Phase C.2; the guarantee it rests on is this.
*/

/** What one invalidation actually did. Counts, so a caller can log or assert real effects. */
export interface ProviderInvalidation {
  proposalsInvalidated: number;
  remindersSuppressed: number;
}

type Queryable = Db | Sql | Tx;

function queryable(db: Queryable): Sql | Tx {
  return "sql" in db ? (db.sql as Sql) : db;
}

/**
 * Close every open confirmation and queued reminder for one provider, or for a whole stand.
 *
 * `providerId` omitted means the STAND closed and every provider at it is invalidated. Supplying
 * it scopes the invalidation to that provider alone — the case a stand-keyed implementation gets
 * silently wrong, cancelling a host's live confirmation when a hosted seller pauses.
 *
 * `salesLocationId` is always required and always in the predicate, even when `providerId` is
 * given. A provider id alone would be enough to find the rows, but naming the pair means a
 * provider from another stand matches nothing rather than reaching across stands.
 */
export async function invalidateProviderWork(
  db: Queryable,
  input: {
    salesLocationId: string;
    /** Omit for a stand shutdown: every provider at the stand is invalidated. */
    providerId?: string;
    occurredAt: Date;
  },
): Promise<ProviderInvalidation> {
  const sql = queryable(db);
  const { salesLocationId, providerId, occurredAt } = input;

  // Only `open` proposals close. `state = 'open'` in the predicate is what makes a second call a
  // no-op, and what protects an answer the farmer already gave.
  const closed = providerId === undefined
    ? await sql`
        update inventory_publication_proposals
        set state = 'invalidated', closed_at = ${occurredAt}, updated_at = ${occurredAt}
        where sales_location_id = ${salesLocationId} and state = 'open'
        returning id, activation_outbox_id
      `
    : await sql`
        update inventory_publication_proposals
        set state = 'invalidated', closed_at = ${occurredAt}, updated_at = ${occurredAt}
        where sales_location_id = ${salesLocationId}
          and provider_id = ${providerId} and state = 'open'
        returning id, activation_outbox_id
      `;

  const proposalIds = closed.map((row) => row.id as string);
  if (proposalIds.length === 0) {
    return { proposalsInvalidated: 0, remindersSuppressed: 0 };
  }

  /*
    The queued reminders that carry those tokens, reached two ways because a proposal is bound to
    its outbox row two ways: `activation_outbox_id` on the proposal once a prompt has been
    accepted by the provider, and `scheduled_inventory_prompt_subjects.outbox_work_id` for a
    scheduled prompt that has not been dispatched yet. A prompt still QUEUED has no activation
    row, so reading only the first would leave exactly the messages that have not gone out.

    `state = 'queued'` is the guard that leaves a sent message alone.
  */
  const suppressed = await sql`
    update outbox_work
    set state = 'suppressed', completed_at = ${occurredAt}
    where state = 'queued'
      and id in (
        select activation_outbox_id from inventory_publication_proposals
        where id = any(${proposalIds}) and activation_outbox_id is not null
        union
        select outbox_work_id from scheduled_inventory_prompt_subjects
        where proposal_id = any(${proposalIds})
      )
    returning id
  `;

  return {
    proposalsInvalidated: proposalIds.length,
    remindersSuppressed: suppressed.length,
  };
}
