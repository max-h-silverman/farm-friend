import { matchStandName } from "@farm-friend/core";
import type { SeedOfferingInput } from "./seed";

/** Parse the human-reviewed offering artifact shared by both seed entry points. */
export function parseApprovedOfferings(raw: unknown): {
  approved: SeedOfferingInput[];
  skippedNoItems: string[];
} {
  if (!Array.isArray(raw)) {
    throw new Error("approved file must be a JSON array of { standName, items } entries");
  }

  const approved: SeedOfferingInput[] = [];
  const skippedNoItems: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) {
      throw new Error("approved file entries must be objects");
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.standName !== "string" || record.standName.trim() === "") {
      throw new Error("an approved entry is missing its standName");
    }
    if (record.items === undefined) {
      skippedNoItems.push(record.standName);
      continue;
    }
    if (
      !Array.isArray(record.items) ||
      !record.items.every((item) => typeof item === "string" && item.trim() !== "")
    ) {
      throw new Error(`"${record.standName}" has a malformed items array`);
    }
    approved.push({ standName: record.standName, items: record.items });
  }
  return { approved, skippedNoItems };
}

/** Approved names that cannot resolve to any stand in the same restore batch. */
export function findUnknownOfferingStands(
  stands: readonly { name: string }[],
  offerings: readonly SeedOfferingInput[],
): string[] {
  const standKeys = new Set(stands.map((stand) => matchStandName(stand.name)));
  return offerings
    .filter((offering) => !standKeys.has(matchStandName(offering.standName)))
    .map((offering) => offering.standName);
}
