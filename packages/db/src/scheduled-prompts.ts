import {
  nextPromptDueSlot,
  type Clock,
  type PromptCadence,
} from "@farm-friend/core";
import { readCurrentRevisionRef } from "./current-inventory";
import type { Db } from "./index";
import { lockKnownSenderState } from "./farmer-targeting";
import { resolveProviderWriteAuthority } from "./provider-write-authority";

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
 * Explicitly choose one LISTING's cadence and make this live authorization its recipient.
 *
 * F-114 Phase C.4. This took a `salesLocationId` and said "the stand's own listing" three
 * separate ways — locking `sales_locations`, checking the caller against `own_seller_id`, and
 * calling `readNativeProviderId`. §facts and authority: **reminder cadence is per provider, not
 * per stand.** A hosted seller restocking weekly at a stand whose owner restocks daily needs her
 * own cadence, and the recipient differs by construction.
 *
 * Authority comes from `resolveProviderWriteAuthority` rather than a fourth enumeration of the
 * arms — except that the HOST arm is deliberately rejected here. That seam answers *may this
 * phone write this provider's stock*, and `host_may_update_stock` grants exactly that: a
 * physical observation about goods on a shelf. A reminder schedule is not an observation, and
 * its recipient is the seller by construction, so only the seller's own arm may set it.
 *
 * Pausing is schedule state only; this transaction never reads or writes SMS consent.
 */
export async function setInventoryPromptPreference(
  db: Db,
  input: {
    senderHash: string;
    authorizationId: string;
    providerId: string;
    cadence: PromptCadence;
    clock: Clock;
  },
): Promise<SetInventoryPromptPreferenceResult> {
  const now = input.clock.now();
  return db.sql.begin(async (tx) => {
    if (!(await lockKnownSenderState(tx, input.senderHash, now))) {
      return { status: "not_authorized" as const };
    }

    const authority = await resolveProviderWriteAuthority(tx, {
      providerId: input.providerId,
      senderHash: input.senderHash,
    });
    // The seller's own arm only — see the doc comment. `paused` is not consulted: a listing's
    // schedule is exactly what a paused seller may still want to change, and pausing REMINDERS
    // is itself one of the four cadences.
    if (authority.status !== "authorized" || authority.via !== "seller") {
      return { status: "not_authorized" as const };
    }
    // The caller names which authorization it is acting under, and the seam resolved one
    // independently. They must be the same row, or a caller holding any valid id could present
    // it beside another phone's and have the write filed under it.
    if (authority.authorizationId !== input.authorizationId) {
      return { status: "not_authorized" as const };
    }

    const salesLocationId = authority.salesLocationId;
    const locations = await tx`
      select id, timezone from sales_locations
      where id = ${salesLocationId}
      for update
    `;
    if (locations.length === 0) return { status: "not_authorized" as const };
    const location = locations[0] as Record<string, unknown>;

    const existing = await tx`
      select id, version, last_due_slot_at
      from inventory_prompt_preferences
      where provider_id = ${input.providerId}
      for update
    `;
    const providerId = input.providerId;
    const currentRevision = await readCurrentRevisionRef(tx, {
      salesLocationId,
      providerId,
      lock: false,
    });
    const previous = existing[0] as Record<string, unknown> | undefined;
    const baseline = laterDate(
      now,
      currentRevision?.publishedAt,
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
            owner_seller_id, sales_location_id, provider_id,
            designated_authorization_id, cadence, version, next_due_at, updated_at
          ) values (
            ${authority.sellerId}, ${salesLocationId}, ${providerId},
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
