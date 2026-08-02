import {
  nextPromptDueSlot,
  type Clock,
  type PromptCadence,
} from "@farm-friend/core";
import type { Db } from "./index";
import { lockKnownSenderState } from "./farmer-targeting";

export type SetInventoryPromptPreferenceResult =
  | {
      status: "saved";
      preferenceId: string;
      version: number;
      cadence: PromptCadence;
      nextDueAt: Date | null;
    }
  | { status: "not_authorized" };

function laterDate(...values: (Date | null | undefined)[]): Date {
  const present = values.filter((value): value is Date => value instanceof Date);
  return new Date(Math.max(...present.map((value) => value.getTime())));
}

/**
 * Explicitly choose one stand cadence and make this live authorization its recipient.
 * Pausing is schedule state only; this transaction never reads or writes SMS consent.
 */
export async function setInventoryPromptPreference(
  db: Db,
  input: {
    senderHash: string;
    authorizationId: string;
    salesLocationId: string;
    cadence: PromptCadence;
    clock: Clock;
  },
): Promise<SetInventoryPromptPreferenceResult> {
  const now = input.clock.now();
  return db.sql.begin(async (tx) => {
    if (!(await lockKnownSenderState(tx, input.senderHash, now))) {
      return { status: "not_authorized" as const };
    }

    const locations = await tx`
      select id, owner_farm_id, timezone from sales_locations
      where id = ${input.salesLocationId}
      for update
    `;
    if (locations.length === 0) return { status: "not_authorized" as const };
    const location = locations[0] as Record<string, unknown>;

    const authorizations = await tx`
      select auth.id
      from farmer_authorizations as auth
      join contacts as contact on contact.id = auth.contact_id
      where auth.id = ${input.authorizationId}
        and auth.farm_id = ${location.owner_farm_id as string}
        and contact.phone_hash = ${input.senderHash}
        and auth.revoked_at is null
      for update of auth
    `;
    if (authorizations.length === 0) return { status: "not_authorized" as const };

    const existing = await tx`
      select id, version, last_due_slot_at
      from inventory_prompt_preferences
      where sales_location_id = ${input.salesLocationId}
      for update
    `;
    const currentRevision = await tx`
      select published_at from inventory_revisions
      where sales_location_id = ${input.salesLocationId} and is_current
    `;
    const previous = existing[0] as Record<string, unknown> | undefined;
    const baseline = laterDate(
      now,
      currentRevision[0]?.published_at as Date | undefined,
      previous?.last_due_slot_at as Date | null | undefined,
    );
    const nextDueAt = nextPromptDueSlot({
      cadence: input.cadence,
      timeZone: location.timezone as string,
      laterOf: baseline,
    });

    const saved = previous === undefined
      ? await tx`
          insert into inventory_prompt_preferences (
            owner_farm_id, sales_location_id, designated_authorization_id,
            cadence, version, next_due_at, updated_at
          ) values (
            ${location.owner_farm_id as string}, ${input.salesLocationId},
            ${input.authorizationId}, ${input.cadence}, 1, ${nextDueAt}, ${now}
          ) returning id, version
        `
      : await tx`
          update inventory_prompt_preferences
          set designated_authorization_id = ${input.authorizationId},
              cadence = ${input.cadence}, version = version + 1,
              next_due_at = ${nextDueAt}, updated_at = ${now}
          where id = ${previous.id as string}
          returning id, version
        `;

    return {
      status: "saved" as const,
      preferenceId: saved[0]?.id as string,
      version: saved[0]?.version as number,
      cadence: input.cadence,
      nextDueAt,
    };
  });
}
