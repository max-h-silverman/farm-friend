import {
  validatePublicStrings,
  type ProhibitedPublicStringKind,
} from "@farm-friend/core";
import type { Db } from "./index";

export type SaveSalesLocationParticipantsResult =
  | {
      status: "saved";
      activeDisplayNames: string[];
      addedDisplayNames: string[];
      retiredDisplayNames: string[];
    }
  | { status: "invalid_names" }
  | { status: "not_authorized" }
  | {
      status: "unsafe_public_text";
      prohibited: ProhibitedPublicStringKind[];
    };

function canonicalDisplayName(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function normalizedDisplayName(value: string): string {
  return canonicalDisplayName(value).toLocaleLowerCase("en");
}

/** Public reader for active, owner-confirmed display text. It performs no identity matching. */
export async function listActiveSalesLocationParticipants(
  db: Db,
  salesLocationId: string,
): Promise<string[]> {
  const rows = await db.sql`
    select display_name
    from sales_location_participants
    where sales_location_id = ${salesLocationId} and retired_at is null
    order by lower(display_name), display_name, id
  `;
  return rows.map((row) => row.display_name as string);
}

/**
 * Save the complete owner-confirmed participant-name list for one location.
 *
 * The save itself is confirmation: no model or second commitment lifecycle is involved. Shared
 * lock order is sender -> location -> participant -> authorization. A partial unique index is
 * still the arbiter for a first insert, because a row lock cannot serialize a row that does not
 * exist; every insert uses ON CONFLICT and trusts only RETURNING as proof that it won.
 */
export async function saveSalesLocationParticipants(
  db: Db,
  input: {
    senderHash: string;
    salesLocationId: string;
    activeDisplayNames: readonly string[];
    occurredAt: Date;
  },
): Promise<SaveSalesLocationParticipantsResult> {
  const publicStringValidation = validatePublicStrings(input.activeDisplayNames);
  if (!publicStringValidation.ok) {
    return {
      status: "unsafe_public_text",
      prohibited: publicStringValidation.prohibited,
    };
  }

  const desired = input.activeDisplayNames.map(canonicalDisplayName);
  if (desired.some((name) => name === "")) return { status: "invalid_names" };
  const desiredKeys = desired.map(normalizedDisplayName);
  if (new Set(desiredKeys).size !== desiredKeys.length) {
    return { status: "invalid_names" };
  }

  return db.sql.begin(async (tx) => {
    await tx`
      insert into sender_states (sender_hash, updated_at)
      values (${input.senderHash}, ${input.occurredAt})
      on conflict (sender_hash) do update set sender_hash = excluded.sender_hash
    `;
    await tx`
      select sender_hash from sender_states
      where sender_hash = ${input.senderHash} for update
    `;

    const locations = await tx`
      select owner_farm_id from sales_locations
      where id = ${input.salesLocationId}
      for update
    `;
    if (locations.length === 0) return { status: "not_authorized" as const };
    const ownerFarmId = locations[0]?.owner_farm_id as string;

    const currentRows = await tx`
      select id, display_name from sales_location_participants
      where sales_location_id = ${input.salesLocationId} and retired_at is null
      order by id
      for update
    `;

    const authorizations = await tx`
      select farmer.id from farmer_authorizations as farmer
      join contacts on contacts.id = farmer.contact_id
      where farmer.farm_id = ${ownerFarmId}
        and contacts.phone_hash = ${input.senderHash}
        and farmer.revoked_at is null
      for update of farmer
    `;
    if (authorizations.length === 0) return { status: "not_authorized" as const };
    const authorizationId = authorizations[0]?.id as string;

    const desiredByKey = new Map(
      desired.map((displayName) => [normalizedDisplayName(displayName), displayName]),
    );
    const current = currentRows.map((row) => ({
      id: row.id as string,
      displayName: row.display_name as string,
      key: normalizedDisplayName(row.display_name as string),
    }));

    const retiring = current.filter(
      (row) => desiredByKey.get(row.key) !== row.displayName,
    );
    for (const row of retiring) {
      await tx`
        update sales_location_participants
        set retired_by_authorization_id = ${authorizationId},
            retired_at = ${input.occurredAt}
        where id = ${row.id}
      `;
    }

    const exactCurrent = new Set(
      current
        .filter((row) => !retiring.some((retired) => retired.id === row.id))
        .map((row) => row.displayName),
    );
    const addedDisplayNames: string[] = [];
    for (const displayName of desired) {
      if (exactCurrent.has(displayName)) continue;
      const inserted = await tx`
        insert into sales_location_participants (
          owner_farm_id, sales_location_id, display_name,
          confirmed_by_authorization_id, confirmed_at
        ) values (
          ${ownerFarmId}, ${input.salesLocationId}, ${displayName},
          ${authorizationId}, ${input.occurredAt}
        )
        on conflict (
          sales_location_id,
          (lower(regexp_replace(trim(display_name), '[[:space:]]+', ' ', 'g')))
        ) where retired_at is null do nothing
        returning display_name
      `;
      if (inserted.length > 0) addedDisplayNames.push(inserted[0]?.display_name as string);
    }

    const audit = await tx`
      insert into audit_events (
        action, actor_contact_hash, subject_type, subject_id, occurred_at
      ) values (
        'sales_location_participants_saved', ${input.senderHash},
        'sales_location', ${input.salesLocationId}, ${input.occurredAt}
      )
      returning id
    `;
    if (audit.length !== 1) throw new Error("participant save audit event was not recorded");

    const active = await tx`
      select display_name from sales_location_participants
      where sales_location_id = ${input.salesLocationId} and retired_at is null
      order by lower(display_name), display_name, id
    `;
    return {
      status: "saved" as const,
      activeDisplayNames: active.map((row) => row.display_name as string),
      addedDisplayNames: addedDisplayNames.sort((a, b) => a.localeCompare(b, "en")),
      retiredDisplayNames: retiring
        .map((row) => row.displayName)
        .sort((a, b) => a.localeCompare(b, "en")),
    };
  }) as Promise<SaveSalesLocationParticipantsResult>;
}
