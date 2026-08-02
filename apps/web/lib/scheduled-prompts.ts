import {
  nextPromptDueSlot,
  projectClosure,
  renderScheduledInventoryPrompt,
  renderScheduledInventoryUpdateRequest,
  type Clock,
  type ClosureInstruction,
  type PromptCadence,
  type SnapshotEntry,
} from "@farm-friend/core";
import { lockKnownSenderState, type Db } from "@farm-friend/db";
import { scheduledPromptFitsSms } from "@farm-friend/sms";

const BODY_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface ScheduledPromptPassResult {
  scheduled: number;
  deferred: number;
}

type Candidate = {
  preference_id: string;
  sender_hash: string;
};

/**
 * Add due full-snapshot checks to the ordinary confirmation outbox.
 *
 * The pass derives both the body and durable `offers_same` value from current database facts.
 * No caller can claim that a hidden or oversized snapshot was visible to the farmer.
 */
export async function runScheduledPromptPass(deps: {
  db: Db;
  clock: Clock;
  maxPreferences?: number;
}): Promise<ScheduledPromptPassResult> {
  const now = deps.clock.now();
  const limit = deps.maxPreferences ?? 25;
  const candidates = await deps.db.sql`
    select preference.id as preference_id, contact.phone_hash as sender_hash
    from inventory_prompt_preferences as preference
    join farmer_authorizations as auth
      on auth.id = preference.designated_authorization_id
    join contacts as contact on contact.id = auth.contact_id
    where preference.cadence <> 'paused'
      and preference.next_due_at is not null
      and preference.next_due_at <= ${now}
    order by preference.next_due_at asc, preference.sales_location_id asc
    limit ${limit}
  ` as unknown as Candidate[];

  let scheduled = 0;
  let deferred = 0;
  for (const candidate of candidates) {
    const result = await schedulePreference(deps.db, candidate, now);
    if (result === "scheduled") scheduled += 1;
    if (result === "deferred") deferred += 1;
  }
  return { scheduled, deferred };
}

async function schedulePreference(
  db: Db,
  candidate: Candidate,
  now: Date,
): Promise<"scheduled" | "deferred" | "ineligible"> {
  return db.sql.begin(async (tx) => {
    if (!(await lockKnownSenderState(tx, candidate.sender_hash, now))) return "ineligible";

    const preflight = await tx`
      select sales_location_id from inventory_prompt_preferences
      where id = ${candidate.preference_id}
    `;
    if (preflight.length === 0) return "ineligible";
    const salesLocationId = preflight[0]?.sales_location_id as string;

    const locations = await tx`
      select id, owner_farm_id, name, timezone from sales_locations
      where id = ${salesLocationId}
      for update
    `;
    if (locations.length === 0) return "ineligible";
    const location = locations[0] as Record<string, unknown>;

    const preferences = await tx`
      select id, designated_authorization_id, cadence, version,
             next_due_at, last_due_slot_at, updated_at
      from inventory_prompt_preferences
      where id = ${candidate.preference_id}
        and sales_location_id = ${salesLocationId}
      for update
    `;
    if (preferences.length === 0) return "ineligible";
    const preference = preferences[0] as Record<string, unknown>;
    const dueSlotAt = (preference.next_due_at as Date | null) ?? null;
    if (
      preference.cadence === "paused" ||
      dueSlotAt === null ||
      dueSlotAt.getTime() > now.getTime()
    ) {
      return "ineligible";
    }

    const existing = await tx`
      select id from inventory_publication_proposals
      where sender_hash = ${candidate.sender_hash} and state = 'open'
      for update
    `;
    if (existing.length > 0) return "deferred";

    const authorizations = await tx`
      select auth.id
      from farmer_authorizations as auth
      join contacts as contact on contact.id = auth.contact_id
      where auth.id = ${preference.designated_authorization_id as string}
        and auth.farm_id = ${location.owner_farm_id as string}
        and contact.phone_hash = ${candidate.sender_hash}
        and auth.revoked_at is null
      for update of auth
    `;
    if (authorizations.length === 0) return "ineligible";

    const approvals = await tx`
      select id from farm_approvals
      where farm_id = ${location.owner_farm_id as string} and revoked_at is null
      for update
    `;
    if (approvals.length === 0) return "ineligible";

    const consent = await tx`
      select state from sms_consents where recipient_hash = ${candidate.sender_hash}
    `;
    if (consent[0]?.state !== "active") return "ineligible";

    const closureRows = await tx`
      select id, result, closure_kind, starts_on, closed_through
      from closure_revisions
      where sales_location_id = ${salesLocationId} and is_current
    `;
    const closureRow = closureRows[0] as Record<string, unknown> | undefined;
    const closure = closureRow === undefined
      ? undefined
      : closureInstruction(closureRow);
    if (projectClosure(closure, now).state === "active") return "deferred";

    const revisions = await tx`
      select id, published_at from inventory_revisions
      where sales_location_id = ${salesLocationId} and is_current
    `;
    const revision = revisions[0] as Record<string, unknown> | undefined;
    const revisionId = (revision?.id as string | undefined) ?? null;

    // A farmer publication after this preference's stored slot resets the cadence. This is
    // checked under the location lock, so no prompt can race a just-published revision.
    const latestActivity = laterDate(
      preference.updated_at as Date,
      (preference.last_due_slot_at as Date | null) ?? undefined,
      revision?.published_at as Date | undefined,
    );
    const expectedDue = nextPromptDueSlot({
      cadence: preference.cadence as PromptCadence,
      timeZone: location.timezone as string,
      laterOf: latestActivity,
    });
    if (expectedDue !== null && expectedDue.getTime() > dueSlotAt.getTime()) {
      await tx`
        update inventory_prompt_preferences
        set next_due_at = ${expectedDue}
        where id = ${candidate.preference_id}
      `;
      return "ineligible";
    }

    const entryRows = revisionId === null
      ? []
      : await tx`
          select id, item_name, quantity, unit, price_text, approximation
          from inventory_entries
          where inventory_revision_id = ${revisionId}
          order by sort_order asc, id asc
        `;
    const entries = entryRows.map(snapshotEntry);
    const fullBody = renderScheduledInventoryPrompt({
      locationName: location.name as string,
      entries,
    });
    const offersSame = revisionId !== null && scheduledPromptFitsSms(fullBody);
    const body = offersSame
      ? fullBody
      : renderScheduledInventoryUpdateRequest({ locationName: location.name as string });

    const outbox = await tx`
      insert into outbox_work (
        logical_key, recipient_hash, message_category, body,
        body_expires_at, available_at, created_at
      ) values (
        ${`scheduled-prompt-${candidate.preference_id}-${dueSlotAt.toISOString()}`},
        ${candidate.sender_hash}, 'inventory_prompt', ${body},
        ${new Date(now.getTime() + BODY_TTL_MS)}, ${now}, ${now}
      )
      on conflict (logical_key) do nothing
      returning id
    `;
    if (outbox.length === 0) return "ineligible";

    const proposal = await tx`
      insert into inventory_publication_proposals (
        sender_hash, sales_location_id, payload, schema_version, proposal_version,
        yes_token, no_token, has_inventory, has_closure,
        base_revision_id, base_is_first_publication, created_at, updated_at
      ) values (
        ${candidate.sender_hash}, ${salesLocationId}, ${tx.json({ entries })},
        '2', 1, 'YES', 'NO', true, false, ${revisionId}, ${revisionId === null},
        ${now}, ${now}
      ) returning id
    `;
    const proposalId = proposal[0]?.id as string;

    await tx`
      insert into scheduled_inventory_prompt_subjects (
        proposal_id, proposal_version, preference_id, preference_version,
        authorization_id, owner_farm_id, sales_location_id,
        inventory_base_revision_id, closure_base_revision_id,
        closure_base_is_first_instruction, due_slot_at, outbox_work_id,
        offers_same, created_at
      ) values (
        ${proposalId}, 1, ${candidate.preference_id}, ${preference.version as number},
        ${preference.designated_authorization_id as string},
        ${location.owner_farm_id as string}, ${salesLocationId}, ${revisionId},
        ${(closureRow?.id as string | undefined) ?? null}, ${closureRow === undefined},
        ${dueSlotAt}, ${outbox[0]?.id as string}, ${offersSame}, ${now}
      )
    `;

    const nextDueAt = nextPromptDueSlot({
      cadence: preference.cadence as PromptCadence,
      timeZone: location.timezone as string,
      laterOf: now,
    });
    await tx`
      update inventory_prompt_preferences
      set last_due_slot_at = ${dueSlotAt}, next_due_at = ${nextDueAt}
      where id = ${candidate.preference_id}
    `;
    return "scheduled";
  });
}

function laterDate(...values: (Date | undefined)[]): Date {
  return new Date(Math.max(...values.filter((value): value is Date => value instanceof Date).map(
    (value) => value.getTime(),
  )));
}

function snapshotEntry(row: Record<string, unknown>): SnapshotEntry {
  return {
    entryId: row.id as string,
    itemName: row.item_name as string,
    ...(row.quantity === null ? {} : { quantity: row.quantity as number }),
    ...(row.unit === null ? {} : { unit: row.unit as string }),
    ...(row.price_text === null ? {} : { priceText: row.price_text as string }),
    ...(row.approximation === null
      ? {}
      : { approximation: row.approximation as SnapshotEntry["approximation"] }),
  };
}

function closureInstruction(row: Record<string, unknown>): ClosureInstruction {
  if (row.result === "reopen") return { result: "reopen" };
  return {
    result: "close",
    closureKind: row.closure_kind as "temporary" | "seasonal",
    startsOn: row.starts_on as string,
    ...(row.closed_through === null ? {} : { closedThrough: row.closed_through as string }),
  };
}
