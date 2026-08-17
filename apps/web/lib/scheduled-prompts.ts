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
import {
  lockKnownSenderState,
  readCurrentInventory,
  type CurrentInventoryEntry,
  type Db,
} from "@farm-friend/db";
import { scheduledPromptFitsSms } from "@farm-friend/sms";
import type { JSONValue } from "postgres";

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
      select id, name, timezone from sales_locations
      where id = ${salesLocationId}
      for update
    `;
    if (locations.length === 0) return "ineligible";
    const location = locations[0] as Record<string, unknown>;

    const preferences = await tx`
      select id, provider_id, owner_seller_id, designated_authorization_id, cadence, version,
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

    /*
      F-114 Phase C.4 — whose reminder this is is the PREFERENCE'S fact, not the roof's.

      All three checks below read `preference.owner_seller_id`. They read
      `sales_locations.own_seller_id` before, which is Kelsey for every listing at Kelsey's
      stand — so Zoe's designated authorization (naming Gracie's Greens) failed the first check
      and her cadence could never fire, while Kelsey's approval was the one consulted for goods
      that are not Kelsey's.

      `inventory_prompt_preferences_provider_seller_fk` (`0048`) is what makes reading it safe:
      the seller on the preference is the seller of the listing it schedules, guaranteed by the
      database rather than by this pass re-deriving it.
    */
    const ownerSellerId = preference.owner_seller_id as string;

    const authorizations = await tx`
      select auth.id
      from farmer_authorizations as auth
      join contacts as contact on contact.id = auth.contact_id
      where auth.id = ${preference.designated_authorization_id as string}
        and auth.seller_id = ${ownerSellerId}
        and contact.phone_hash = ${candidate.sender_hash}
        and auth.revoked_at is null
      for update of auth
    `;
    if (authorizations.length === 0) return "ineligible";

    // VIGA's approval of the seller whose goods these are. §hosting and approval lifecycle lets
    // VIGA revoke a seller globally, and a prompt is an offer to publish — so a hosted seller
    // VIGA has revoked must not be prompted even though her host is approved and unaffected.
    const approvals = await tx`
      select id from seller_approvals
      where seller_id = ${ownerSellerId} and revoked_at is null
      for update
    `;
    if (approvals.length === 0) return "ineligible";

    // The relationship itself. A seller whose listing has ended still has a seller record, a
    // live authorization and an approval — all three checks above pass — but there is nothing
    // at this stand left to confirm.
    const live = await tx`
      select id from stand_providers
      where id = ${preference.provider_id as string}
        and ended_at is null
        and lifecycle_state in ('active', 'paused')
      for update
    `;
    if (live.length === 0) return "ineligible";

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

    // F-114 Phase B — the PREFERENCE names the provider this reminder addresses. Reading it
    // from the row rather than re-deriving it is what lets a hosted seller's cadence prompt
    // about their own listing rather than the host's.
    const providerId = preference.provider_id as string;
    const current = await readCurrentInventory(tx, { salesLocationId, providerId });
    const revisionId = current?.revisionId ?? null;

    // A farmer publication after this preference's stored slot resets the cadence. This is
    // checked under the location lock, so no prompt can race a just-published revision.
    const latestActivity = laterDate(
      preference.updated_at as Date,
      (preference.last_due_slot_at as Date | null) ?? undefined,
      current?.publishedAt,
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

    const entries = (current?.entries ?? []).map(snapshotEntry);
    const fullBody = renderScheduledInventoryPrompt({
      locationName: location.name as string,
      entries,
      publishedAt: current?.publishedAt ?? null,
      now,
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
        sender_hash, sales_location_id, provider_id, payload, proposal_version,
        has_inventory, has_closure,
        base_revision_id, base_is_first_publication, created_at, updated_at
      ) values (
        ${candidate.sender_hash}, ${salesLocationId}, ${providerId},
        ${tx.json({ entries } as unknown as JSONValue)},
        1, true, false, ${revisionId}, ${revisionId === null},
        ${now}, ${now}
      ) returning id
    `;
    const proposalId = proposal[0]?.id as string;

    await tx`
      insert into scheduled_inventory_prompt_subjects (
        proposal_id, proposal_version, preference_id, preference_version,
        authorization_id, owner_seller_id, sales_location_id, provider_id,
        inventory_base_revision_id, closure_base_revision_id,
        closure_base_is_first_instruction, due_slot_at, outbox_work_id,
        offers_same, created_at
      ) values (
        ${proposalId}, 1, ${candidate.preference_id}, ${preference.version as number},
        ${preference.designated_authorization_id as string},
        ${ownerSellerId}, ${salesLocationId}, ${providerId},
        ${revisionId},
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

function snapshotEntry(entry: CurrentInventoryEntry): SnapshotEntry {
  return {
    entryId: entry.entryId,
    itemName: entry.itemName,
    ...(entry.quantity === null ? {} : { quantity: entry.quantity }),
    ...(entry.unit === null ? {} : { unit: entry.unit }),
    ...(entry.priceText === null ? {} : { priceText: entry.priceText }),
    ...(entry.approximation === null ? {} : { approximation: entry.approximation }),
  };
}

function closureInstruction(row: Record<string, unknown>): ClosureInstruction {
  if (row.result === "reopen") return { result: "reopen" };
  return {
    result: "close",
    closureKind: row.closure_kind as "temporary" | "seasonal",
    startsOn: storedLocalDate(row.starts_on),
    ...(row.closed_through === null ? {} : { closedThrough: storedLocalDate(row.closed_through) }),
  };
}

function storedLocalDate(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  throw new Error("closure date missing from a close revision");
}
