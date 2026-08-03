import type { Db } from "./index";
import type { Tx } from "./sql";

export const FARMER_TARGET_MENU_TTL_MS = 12 * 60 * 60 * 1000;

export type FarmerTargetPurpose = "update" | "link" | "settings";

export interface FarmerTarget {
  authorizationId: string;
  ownerFarmId: string;
  salesLocationId: string;
  locationName: string;
}

export interface FarmerTargetOption extends FarmerTarget {
  optionNumber: number;
}

export type ResolveFarmerTargetResult =
  | { status: "not_authorized" }
  | { status: "selected"; target: FarmerTarget; autoSelected: boolean }
  | {
      status: "menu";
      options: FarmerTargetOption[];
      expiresAt: Date;
      purpose: FarmerTargetPurpose;
    };

export type SelectFarmerTargetResult =
  | { status: "selected"; target: FarmerTarget; purpose: FarmerTargetPurpose }
  | { status: "expired" }
  | { status: "no_menu" }
  | { status: "invalid_selection" }
  | { status: "not_authorized" };

type TargetRow = {
  authorization_id: string;
  owner_farm_id: string;
  sales_location_id: string;
  location_name: string;
};

function targetFromRow(row: TargetRow): FarmerTarget {
  return {
    authorizationId: row.authorization_id,
    ownerFarmId: row.owner_farm_id,
    salesLocationId: row.sales_location_id,
    locationName: row.location_name,
  };
}

export async function lockKnownSenderState(
  tx: Tx,
  senderHash: string,
  occurredAt: Date,
): Promise<boolean> {
  const senderRows = await tx`
    with known_contact as (
      select phone_hash from contacts
      where phone_hash = ${senderHash}
      for key share
    )
    insert into sender_states (sender_hash, updated_at)
    select phone_hash, ${occurredAt} from known_contact
    on conflict (sender_hash) do update set sender_hash = excluded.sender_hash
    returning sender_hash
  `;
  if (senderRows.length === 0) return false;
  await tx`
    select sender_hash from sender_states
    where sender_hash = ${senderHash}
    for update
  `;
  return true;
}

async function ensureTargetContext(
  tx: Tx,
  senderHash: string,
  occurredAt: Date,
): Promise<void> {
  await tx`
    insert into farmer_target_contexts (sender_hash, updated_at)
    values (${senderHash}, ${occurredAt})
    on conflict (sender_hash) do nothing
  `;
}

async function lockSender(
  tx: Tx,
  senderHash: string,
  occurredAt: Date,
): Promise<boolean> {
  if (!(await lockKnownSenderState(tx, senderHash, occurredAt))) return false;
  await ensureTargetContext(tx, senderHash, occurredAt);
  return true;
}

/**
 * Read and lock the sender's currently editable pairs in the publication lock order:
 * sender (held by the caller), then locations, then authorizations. The first read only
 * discovers candidate ids; the final read after both locks is the authority decision.
 */
async function lockLiveTargets(tx: Tx, senderHash: string): Promise<TargetRow[]> {
  const candidates = await tx`
    select auth.id as authorization_id, location.id as sales_location_id
    from farmer_authorizations as auth
    join contacts as contact on contact.id = auth.contact_id
    join sales_locations as location on location.owner_farm_id = auth.farm_id
    where contact.phone_hash = ${senderHash}
      and auth.revoked_at is null
    order by location.id, auth.id
  `;
  const locationIds = [...new Set(candidates.map((row) => row.sales_location_id as string))];
  const authorizationIds = [
    ...new Set(candidates.map((row) => row.authorization_id as string)),
  ];

  if (locationIds.length > 0) {
    await tx`
      select id from sales_locations
      where id in ${tx(locationIds)}
      order by id
      for update
    `;
  }
  if (authorizationIds.length > 0) {
    await tx`
      select id from farmer_authorizations
      where id in ${tx(authorizationIds)}
      order by id
      for update
    `;
  }

  return (await tx`
    select
      auth.id as authorization_id,
      auth.farm_id as owner_farm_id,
      location.id as sales_location_id,
      location.name as location_name
    from farmer_authorizations as auth
    join contacts as contact on contact.id = auth.contact_id
    join sales_locations as location on location.owner_farm_id = auth.farm_id
    where contact.phone_hash = ${senderHash}
      and auth.revoked_at is null
    order by lower(location.name), location.id, auth.id
  `) as unknown as TargetRow[];
}

/** Check live farmer authority without issuing or changing a stand-selection menu. */
export async function hasLiveFarmerAuthorization(
  db: Db,
  input: { senderHash: string; occurredAt: Date },
): Promise<boolean> {
  return db.sql.begin(async (tx) => {
    if (!(await lockKnownSenderState(tx, input.senderHash, input.occurredAt))) return false;
    return (await lockLiveTargets(tx, input.senderHash)).length > 0;
  });
}

async function clearMenu(tx: Tx, senderHash: string, occurredAt: Date): Promise<void> {
  await tx`delete from farmer_target_menu_options where sender_hash = ${senderHash}`;
  await tx`
    update farmer_target_contexts
    set menu_issued_at = null, menu_expires_at = null, menu_purpose = null,
        updated_at = ${occurredAt}
    where sender_hash = ${senderHash}
  `;
}

async function storeSelection(
  tx: Tx,
  senderHash: string,
  target: FarmerTarget,
  occurredAt: Date,
): Promise<void> {
  await tx`
    update farmer_target_contexts
    set selected_authorization_id = ${target.authorizationId},
        selected_owner_farm_id = ${target.ownerFarmId},
        selected_sales_location_id = ${target.salesLocationId},
        selected_at = ${occurredAt},
        updated_at = ${occurredAt}
    where sender_hash = ${senderHash}
  `;
}

async function clearSelection(
  tx: Tx,
  senderHash: string,
  occurredAt: Date,
): Promise<void> {
  await tx`
    update farmer_target_contexts
    set selected_authorization_id = null, selected_owner_farm_id = null,
        selected_sales_location_id = null, selected_at = null,
        updated_at = ${occurredAt}
    where sender_hash = ${senderHash}
  `;
}

/** Resolve one valid target or issue one durable, numbered menu. */
export async function resolveFarmerTarget(
  db: Db,
  input: {
    senderHash: string;
    occurredAt: Date;
    purpose: FarmerTargetPurpose;
    forceMenu?: boolean;
  },
): Promise<ResolveFarmerTargetResult> {
  return db.sql.begin(async (tx) => {
    // The contact row is locked as part of the conditional sender insert. That both keeps
    // unknown callers non-disclosing and lets the FK protect a known sender throughout this
    // transaction if contact deletion races the first use.
    if (!(await lockSender(tx, input.senderHash, input.occurredAt))) {
      return { status: "not_authorized" as const };
    }
    const targets = (await lockLiveTargets(tx, input.senderHash)).map(targetFromRow);
    const contexts = await tx`
      select selected_authorization_id, selected_owner_farm_id,
        selected_sales_location_id, selected_at
      from farmer_target_contexts
      where sender_hash = ${input.senderHash}
      for update
    `;
    const context = contexts[0] as Record<string, unknown>;
    const selected = targets.find(
      (target) =>
        target.authorizationId === context.selected_authorization_id &&
        target.ownerFarmId === context.selected_owner_farm_id &&
        target.salesLocationId === context.selected_sales_location_id,
    );

    if (targets.length === 0) {
      await clearSelection(tx, input.senderHash, input.occurredAt);
      await clearMenu(tx, input.senderHash, input.occurredAt);
      return { status: "not_authorized" as const };
    }

    if (targets.length === 1) {
      const target = targets[0]!;
      await storeSelection(tx, input.senderHash, target, input.occurredAt);
      await clearMenu(tx, input.senderHash, input.occurredAt);
      return { status: "selected" as const, target, autoSelected: true };
    }

    if (selected !== undefined && input.forceMenu !== true) {
      await clearMenu(tx, input.senderHash, input.occurredAt);
      return { status: "selected" as const, target: selected, autoSelected: false };
    }

    if (selected === undefined) {
      await clearSelection(tx, input.senderHash, input.occurredAt);
    }
    const expiresAt = new Date(input.occurredAt.getTime() + FARMER_TARGET_MENU_TTL_MS);
    await tx`delete from farmer_target_menu_options where sender_hash = ${input.senderHash}`;
    await tx`
      update farmer_target_contexts
      set menu_issued_at = ${input.occurredAt}, menu_expires_at = ${expiresAt},
          menu_purpose = ${input.purpose}, updated_at = ${input.occurredAt}
      where sender_hash = ${input.senderHash}
    `;
    const options = targets.map((target, index) => ({ ...target, optionNumber: index + 1 }));
    for (const option of options) {
      await tx`
        insert into farmer_target_menu_options (
          sender_hash, option_number, authorization_id, owner_farm_id, sales_location_id
        ) values (
          ${input.senderHash}, ${option.optionNumber}, ${option.authorizationId},
          ${option.ownerFarmId}, ${option.salesLocationId}
        )
      `;
    }
    return { status: "menu" as const, options, expiresAt, purpose: input.purpose };
  }) as Promise<ResolveFarmerTargetResult>;
}

/** Consume one number from the sender's current menu, never from freshly reordered targets. */
export async function selectFarmerTarget(
  db: Db,
  input: { senderHash: string; optionNumber: number; occurredAt: Date },
): Promise<SelectFarmerTargetResult> {
  return db.sql.begin(async (tx) => {
    if (!(await lockSender(tx, input.senderHash, input.occurredAt))) {
      return { status: "no_menu" as const };
    }
    const contexts = await tx`
      select menu_expires_at, menu_purpose
      from farmer_target_contexts
      where sender_hash = ${input.senderHash}
      for update
    `;
    const context = contexts[0] as Record<string, unknown>;
    const expiresAt = context.menu_expires_at as Date | null;
    const purpose = context.menu_purpose as FarmerTargetPurpose | null;
    if (expiresAt === null || purpose === null) return { status: "no_menu" };
    if (input.occurredAt.getTime() >= expiresAt.getTime()) {
      await clearMenu(tx, input.senderHash, input.occurredAt);
      return { status: "expired" };
    }

    const options = await tx`
      select authorization_id, owner_farm_id, sales_location_id
      from farmer_target_menu_options
      where sender_hash = ${input.senderHash} and option_number = ${input.optionNumber}
    `;
    const option = options[0] as Record<string, unknown> | undefined;
    if (option === undefined) return { status: "invalid_selection" };

    const locationId = option.sales_location_id as string;
    const authorizationId = option.authorization_id as string;
    await tx`select id from sales_locations where id = ${locationId} for update`;
    await tx`select id from farmer_authorizations where id = ${authorizationId} for update`;
    const live = (await tx`
      select
        auth.id as authorization_id,
        auth.farm_id as owner_farm_id,
        location.id as sales_location_id,
        location.name as location_name
      from farmer_target_menu_options as menu
      join farmer_authorizations as auth
        on auth.id = menu.authorization_id
        and auth.farm_id = menu.owner_farm_id
      join contacts as contact on contact.id = auth.contact_id
      join sales_locations as location
        on location.id = menu.sales_location_id
        and location.owner_farm_id = menu.owner_farm_id
      where menu.sender_hash = ${input.senderHash}
        and menu.option_number = ${input.optionNumber}
        and contact.phone_hash = ${input.senderHash}
        and auth.revoked_at is null
    `) as unknown as TargetRow[];
    if (live.length === 0) {
      await clearMenu(tx, input.senderHash, input.occurredAt);
      return { status: "not_authorized" };
    }

    const target = targetFromRow(live[0]!);
    await storeSelection(tx, input.senderHash, target, input.occurredAt);
    await clearMenu(tx, input.senderHash, input.occurredAt);
    return { status: "selected", target, purpose };
  }) as Promise<SelectFarmerTargetResult>;
}

export interface FarmerSettingsTarget {
  salesLocationId: string;
  locationName: string;
  selected: boolean;
  cadence: "every_2_days" | "weekly" | "every_2_weeks" | "paused" | null;
}

/** List only the locations editable through one live authorization for its own sender. */
export async function listFarmerSettingsTargets(
  db: Db,
  input: { senderHash: string; authorizationId: string },
): Promise<FarmerSettingsTarget[]> {
  const rows = await db.sql`
    select
      location.id as sales_location_id,
      location.name as location_name,
      context.selected_authorization_id = auth.id
        and context.selected_sales_location_id = location.id as selected,
      preference.cadence
    from farmer_authorizations as auth
    join contacts as contact on contact.id = auth.contact_id
    join sales_locations as location on location.owner_farm_id = auth.farm_id
    left join farmer_target_contexts as context
      on context.sender_hash = contact.phone_hash
    left join inventory_prompt_preferences as preference
      on preference.sales_location_id = location.id
    where auth.id = ${input.authorizationId}
      and contact.phone_hash = ${input.senderHash}
      and auth.revoked_at is null
    order by lower(location.name), location.id
  `;
  return rows.map((row) => ({
    salesLocationId: row.sales_location_id as string,
    locationName: row.location_name as string,
    selected: row.selected === true,
    cadence: (row.cadence as FarmerSettingsTarget["cadence"]) ?? null,
  }));
}

/** Store the settings page's exact default target after revalidating its standing authority. */
export async function selectFarmerTargetForAuthorization(
  db: Db,
  input: {
    senderHash: string;
    authorizationId: string;
    salesLocationId: string;
    occurredAt: Date;
  },
): Promise<{ status: "selected"; target: FarmerTarget } | { status: "not_authorized" }> {
  return db.sql.begin(async (tx) => {
    if (!(await lockKnownSenderState(tx, input.senderHash, input.occurredAt))) {
      return { status: "not_authorized" as const };
    }
    await tx`
      select id from sales_locations
      where id = ${input.salesLocationId}
      for update
    `;
    await tx`
      select id from farmer_authorizations
      where id = ${input.authorizationId}
      for update
    `;
    const rows = (await tx`
      select
        auth.id as authorization_id,
        auth.farm_id as owner_farm_id,
        location.id as sales_location_id,
        location.name as location_name
      from farmer_authorizations as auth
      join contacts as contact on contact.id = auth.contact_id
      join sales_locations as location on location.owner_farm_id = auth.farm_id
      where auth.id = ${input.authorizationId}
        and contact.phone_hash = ${input.senderHash}
        and location.id = ${input.salesLocationId}
        and auth.revoked_at is null
    `) as unknown as TargetRow[];
    if (rows.length === 0) return { status: "not_authorized" as const };

    const target = targetFromRow(rows[0]!);
    await ensureTargetContext(tx, input.senderHash, input.occurredAt);
    await storeSelection(tx, input.senderHash, target, input.occurredAt);
    await clearMenu(tx, input.senderHash, input.occurredAt);
    return { status: "selected" as const, target };
  }) as Promise<
    { status: "selected"; target: FarmerTarget } | { status: "not_authorized" }
  >;
}
