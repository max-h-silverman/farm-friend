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
  return [
    "Which stand do you mean? Reply with its number within 12 hours:",
    ...choices,
    "Reply STOP to opt out.",
  ].join("\n");
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
        body: `Using ${target.locationName}. Send what changed at this stand. Reply STOP to opt out.`,
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
  const action = purpose === "settings"
    ? `Settings for ${target.locationName}`
    : `Private update link for ${target.locationName}`;
  return {
    status: "issued",
    replies: [{
      body: `VIGA Farm Friend: ${action} - keep it to yourself. ${url} Reply STOP to opt out.`,
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
      body: "That stand choice is not active. Text STAND, LINK, or SETTINGS to start again.",
      category: "inquiry_reply",
      logicalKey: `farmer-target-choice-${input.providerEventId}`,
    }],
  };
}
