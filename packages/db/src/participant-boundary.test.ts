import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function executable(source: string): string {
  return source
    .replace(/^\s*import\s[\s\S]*?;\s*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

const participantSource = executable(
  readFileSync(new URL("./participants.ts", import.meta.url), "utf8"),
);
const saveStart = participantSource.indexOf(
  "export async function saveSalesLocationParticipants",
);
const saveBody = participantSource.slice(saveStart);
const compactSave = saveBody.replace(/\s+/g, " ");

describe("the participant structured-save boundary", () => {
  it("calls the one shared public-string validator before opening a transaction", () => {
    const validation = saveBody.match(
      /validatePublicStrings\(input\.activeDisplayNames\)/,
    );
    expect(saveStart).toBeGreaterThan(-1);
    expect(validation).not.toBeNull();
    expect(saveBody.indexOf(validation?.[0] ?? "")).toBeLessThan(
      saveBody.indexOf("db.sql.begin"),
    );
  });

  it("locks sender, location, participants, then authorization at their call sites", () => {
    const calls = [
      "select sender_hash from sender_states where sender_hash = ${input.senderHash} for update",
      "select owner_farm_id from sales_locations where id = ${input.salesLocationId} for update",
      "select id, display_name from sales_location_participants where sales_location_id = ${input.salesLocationId} and retired_at is null order by id for update",
      "select farmer.id from farmer_authorizations as farmer join contacts on contacts.id = farmer.contact_id where farmer.farm_id = ${ownerFarmId} and contacts.phone_hash = ${input.senderHash} and farmer.revoked_at is null for update of farmer",
    ];
    const positions = calls.map((call) => compactSave.indexOf(call));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it("arbitrates first inserts at the partial unique index and trusts RETURNING", () => {
    expect(compactSave).toMatch(
      /insert into sales_location_participants \([^)]+\) values \([^)]+\) on conflict \( sales_location_id, \(lower\(regexp_replace\(trim\(display_name\), '\[\[:space:\]\]\+', ' ', 'g'\)\)\) \) where retired_at is null do nothing returning display_name/,
    );
  });

  it("performs no farm-name or profile matching", () => {
    expect(compactSave).not.toMatch(/\b(from|join) farms\b/i);
  });
});

const routeSource = executable(
  readFileSync(
    new URL("../../../apps/web/app/api/farmer/stand/route.ts", import.meta.url),
    "utf8",
  ),
);

describe("the structured participant HTTP action is deterministic", () => {
  it("uses its db-and-clock context without constructing full model composition", () => {
    const branchStart = routeSource.indexOf('if (action === "save_participants")');
    const participantContext = routeSource.indexOf("const context = publicReadContext()", branchStart);
    const participantSave = routeSource.indexOf("await saveParticipantsFromLink(context,", branchStart);

    expect(branchStart).toBeGreaterThan(-1);
    expect(participantContext).toBeGreaterThan(branchStart);
    expect(participantSave).toBeGreaterThan(participantContext);
    expect(routeSource).not.toMatch(/\bappContext\s*\(/);
  });
});
