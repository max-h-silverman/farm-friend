// F-024/F-036 — propose offering tags from VIGA's export, for human review.
//
//   npm run offerings:propose -- <path-to-csv> <out-json>
//
// The model PROPOSES; nothing here writes the database (Golden Rule #3). The output file is
// the review artifact: each stand carries its proposed tags beside the stripped source text
// they came from. max edits or approves that file, and `npm run db:seed-offerings` commits
// it idempotently. Contact details are stripped BEFORE the text reaches the model — the
// offering projection fails closed on a raw phone, so an unstripped description would refuse
// rather than leak.
//
// Requires DEEPINFRA_API_KEY (from .env via --env-file) and DEEPINFRA_MODEL. The selection
// passes the same privacy gate the composition root enforces; a script is not exempt.

import { readFileSync, writeFileSync } from "node:fs";
import {
  assertDeepInfraSelectionApproved,
  createDeepInfraProvider,
  extractOfferings,
} from "@farm-friend/ai";
import { parseStandCsv, stripContactDetails } from "@farm-friend/core";

interface Proposal {
  standName: string;
  /** Proposed tags, present when extraction succeeded. Absent on error. */
  items?: string[];
  /** Why extraction failed, when it did. An erroring stand is reported, never dropped. */
  error?: string;
  /** The stripped text the proposal was drawn from, for review. */
  sourceText: string;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    console.error(`${name} is required`);
    process.exit(1);
  }
  return value;
}

async function main(): Promise<void> {
  const [csvPath, outPath] = process.argv.slice(2);
  if (!csvPath || !outPath) {
    console.error("usage: npm run offerings:propose -- <path-to-csv> <out-json>");
    process.exit(1);
  }

  const model = requireEnv("DEEPINFRA_MODEL");
  assertDeepInfraSelectionApproved(model);
  const provider = createDeepInfraProvider({
    apiKey: requireEnv("DEEPINFRA_API_KEY"),
    model,
  });

  const { stands, rejected } = parseStandCsv(readFileSync(csvPath, "utf8"));
  for (const item of rejected) {
    console.error(`CSV REJECTED  ${item.name}: ${item.reason}`);
  }

  const proposals: Proposal[] = [];
  for (const stand of stands) {
    const sourceText = stripContactDetails(stand.description);
    try {
      const result = await extractOfferings(provider, { sourceText });
      if (result.ok) {
        proposals.push({ standName: stand.name, items: result.items, sourceText });
        console.log(`${stand.name}: ${result.items.length === 0 ? "(none)" : result.items.join(", ")}`);
      } else {
        proposals.push({ standName: stand.name, error: result.reason, sourceText });
        console.error(`ERROR  ${stand.name}: ${result.reason}`);
      }
    } catch (error) {
      proposals.push({ standName: stand.name, error: (error as Error).message, sourceText });
      console.error(`ERROR  ${stand.name}: ${(error as Error).message}`);
    }
  }

  writeFileSync(outPath, `${JSON.stringify(proposals, null, 2)}\n`);
  const failed = proposals.filter((proposal) => proposal.error !== undefined).length;
  console.log(
    `\nproposed for ${proposals.length - failed} of ${proposals.length} stands ` +
      `(${failed} errors) -> ${outPath}`,
  );
  console.log("Review the file, then commit it with: npm run db:seed-offerings -- " + outPath);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
