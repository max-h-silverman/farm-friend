import {
  FARMER_ONBOARDING_REQUEST_ACKNOWLEDGEMENT,
  farmerLinkUrl,
  farmerSettingsUrl,
} from "@farm-friend/core";
import {
  issueFarmerLink,
  resolveFarmerTarget,
  selectFarmerTarget,
  type Db,
  type FarmerTarget,
  type FarmerTargetOption,
  type FarmerTargetPurpose,
} from "@farm-friend/db";
import type { RoutedReply } from "./routing";

export interface FarmerTargetHandlerDeps {
  db: Db;
  /** Configured origin only; never request headers. */
  publicBaseUrl: string;
}

interface HandlerInputBase {
  senderHash: string;
  occurredAt: Date;
  providerEventId: string;
}

export interface FarmerTargetHandlerResult {
  status: string;
  replies: RoutedReply[];
}

function refusal(providerEventId: string): FarmerTargetHandlerResult {
  return {
    status: "not_authorized",
    replies: [{
      body: FARMER_ONBOARDING_REQUEST_ACKNOWLEDGEMENT,
      category: "required_reply",
      logicalKey: `farmer-target-refused-${providerEventId}`,
    }],
  };
}

export function renderFarmerTargetMenu(options: FarmerTargetOption[]): string {
  const choices = options.map((option) => `${option.optionNumber}. ${option.locationName}`);
  // No opt-out footer (F-096): this answers a farmer keyword sent seconds ago. The instruction
  // that stays is the one the menu cannot work without — the reply is a bare number.
  //
  // The deadline is NOT stated (max, 2026-08-11). The 12 hours is real
  // (`FARMER_TARGET_MENU_TTL_MS`) but naming it spends a line of an SMS on a rule that almost
  // never binds — a farmer answering a menu answers it now. The farmer who does reply the next
  // morning is told plainly that the window closed, which is where that fact actually helps.
  return ["Which stand do you mean? Reply with the number:", ...choices].join("\n");
}

function menuReply(
  options: FarmerTargetOption[],
  providerEventId: string,
): FarmerTargetHandlerResult {
  return {
    status: "menu",
    replies: [{
      body: renderFarmerTargetMenu(options),
      category: "inquiry_reply",
      logicalKey: `farmer-target-menu-${providerEventId}`,
    }],
  };
}

async function finishPurpose(
  deps: FarmerTargetHandlerDeps,
  input: HandlerInputBase,
  target: FarmerTarget,
  purpose: FarmerTargetPurpose,
): Promise<FarmerTargetHandlerResult> {
  if (purpose === "update") {
    return {
      status: "selected",
      replies: [{
        body: `Using ${target.locationName}. Text us what you have out there now.`,
        category: "inquiry_reply",
        logicalKey: `farmer-target-selected-${input.providerEventId}`,
      }],
    };
  }

  const issued = await issueFarmerLink(deps.db, {
    authorizationId: target.authorizationId,
    salesLocationId: target.salesLocationId,
    occurredAt: input.occurredAt,
  });
  if (issued.status !== "issued") return refusal(input.providerEventId);
  const url = purpose === "settings"
    ? farmerSettingsUrl(deps.publicBaseUrl, issued.token)
    : farmerLinkUrl(deps.publicBaseUrl, issued.token);
  // Says what the farmer will DO on the page, not what the page is called. "Settings" and
  // "private update link" are our words for these screens; "change how often we text you" and
  // "update your listing" are what the farmer came for.
  const action = purpose === "settings"
    ? `Change how often we text you about ${target.locationName}:`
    : `Update your listing for ${target.locationName}:`;
  return {
    status: "issued",
    replies: [{
      // The URL on its own line and no footer (F-096) — the link is the one thing the farmer
      // needs to tap, and it used to sit mid-sentence between prose and compliance boilerplate.
      // "Keep it to yourself" is the honest warning for a link with no password behind it.
      body: `VIGA Farm Friend: ${action}\n${url}\nThis link is just for you - please don't share it.`,
      category: "inventory_prompt",
      logicalKey: `farmer-${purpose}-${input.providerEventId}`,
    }],
  };
}

/** Handle one deterministic LINK/STAND/SETTINGS command without any model dependency. */
export async function handleFarmerTarget(
  deps: FarmerTargetHandlerDeps,
  input: HandlerInputBase & { keyword: "LINK" | "STAND" | "SETTINGS" },
): Promise<FarmerTargetHandlerResult> {
  const purpose: FarmerTargetPurpose = input.keyword === "STAND"
    ? "update"
    : input.keyword.toLowerCase() as "link" | "settings";
  const resolved = await resolveFarmerTarget(deps.db, {
    senderHash: input.senderHash,
    occurredAt: input.occurredAt,
    purpose,
    ...(input.keyword === "STAND" ? { forceMenu: true } : {}),
  });
  if (resolved.status === "not_authorized") return refusal(input.providerEventId);
  if (resolved.status === "menu") return menuReply(resolved.options, input.providerEventId);
  return finishPurpose(deps, input, resolved.target, purpose);
}

/** Continue the action stored with the server-issued menu; a number never chooses a new job. */
export async function handleStandSelection(
  deps: FarmerTargetHandlerDeps,
  input: HandlerInputBase & { optionNumber: number },
): Promise<FarmerTargetHandlerResult> {
  const selected = await selectFarmerTarget(deps.db, input);
  if (selected.status === "selected") {
    return finishPurpose(deps, input, selected.target, selected.purpose);
  }
  if (selected.status === "not_authorized") return refusal(input.providerEventId);
  return {
    status: selected.status,
    replies: [{
      // The menu no longer states its deadline, so this is where a farmer learns there was
      // one. It keeps naming the recovery keywords: a refusal with no way forward is worse
      // than the expiry itself. Covers `no_menu` too — a bare number with nothing pending
      // reads the same to the farmer, and distinguishing them helps nobody.
      body:
        "Sorry - the response window expired. Text LINK to update your listing, " +
        "STAND to pick a different stand, or SETTINGS to change how often we text you.",
      category: "inquiry_reply",
      logicalKey: `farmer-target-choice-${input.providerEventId}`,
    }],
  };
}
