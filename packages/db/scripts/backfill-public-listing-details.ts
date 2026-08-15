// Fill the public description/payment columns for rows seeded before those fields were wired.
// This is intentionally a guarded, null-only operation: a farmer or operator edit is never
// silently replaced by reference input.

import postgres from "postgres";
import { readFileSync } from "node:fs";
import { matchStandName, publicListingDetails } from "@farm-friend/core";

type SourceEntry = { standName: string; sourceText: string };
type PaymentFact = { standName: string; farmBucksAccepted: boolean };

function readSource(path: string): SourceEntry[] {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(raw)) throw new Error("source file must be an array");

  return raw.map((entry, index) => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`source entry ${index + 1} must be an object`);
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.standName !== "string" || typeof record.sourceText !== "string") {
      throw new Error(`source entry ${index + 1} needs standName and sourceText`);
    }
    return { standName: record.standName, sourceText: record.sourceText };
  });
}

function readPaymentFacts(path: string): Map<string, PaymentFact> {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(raw)) throw new Error("payment facts file must be an array");

  const facts = new Map<string, PaymentFact>();
  for (const [index, entry] of raw.entries()) {
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`payment fact ${index + 1} must be an object`);
    }
    const record = entry as Record<string, unknown>;
    if (
      typeof record.standName !== "string" ||
      typeof record.farmBucksAccepted !== "boolean"
    ) {
      throw new Error(`payment fact ${index + 1} needs standName and farmBucksAccepted`);
    }
    const fact = { standName: record.standName, farmBucksAccepted: record.farmBucksAccepted };
    const key = matchStandName(fact.standName);
    if (facts.has(key)) throw new Error(`duplicate payment fact: ${fact.standName}`);
    facts.set(key, fact);
  }
  return facts;
}

const sourcePath = process.argv[2];
const paymentFactsPath = process.argv.includes("--payment-facts")
  ? process.argv[process.argv.indexOf("--payment-facts") + 1]
  : undefined;
const apply = process.argv.includes("--apply");

if (sourcePath === undefined) {
  console.error(
    "usage: npm run db:backfill-public-listing-details -- <source.json> " +
      "[--payment-facts facts.json] [--apply]",
  );
  process.exit(1);
}

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const source = readSource(sourcePath);
const paymentFacts =
  paymentFactsPath === undefined ? new Map<string, PaymentFact>() : readPaymentFacts(paymentFactsPath);
const sql = postgres(databaseUrl, { max: 1 });

try {
  await sql.begin(async (tx) => {
    const rows = await tx`
      select l.id as location_id, l.name, l.farm_bucks_accepted, l.farm_bucks_eligible,
             f.id as seller_id, f.description
      from sales_locations l
      join sellers f on f.id = l.own_seller_id
    `;
    const byKey = new Map<string, (typeof rows)[number]>();
    for (const row of rows) {
      const key = matchStandName(row.name as string);
      if (byKey.has(key)) throw new Error(`duplicate database stand key: ${row.name}`);
      byKey.set(key, row);
    }

    let descriptionsFilled = 0;
    let paymentFactsFilled = 0;
    const unmatched: string[] = [];

    for (const entry of source) {
      const row = byKey.get(matchStandName(entry.standName));
      if (row === undefined) {
        unmatched.push(entry.standName);
        continue;
      }

      const details = publicListingDetails(entry);
      const paymentFact = paymentFacts.get(matchStandName(entry.standName));
      const farmBucksAccepted = details.farmBucksAccepted ?? paymentFact?.farmBucksAccepted;
      const shouldFillDescription = row.description === null && details.description !== undefined;
      const shouldFillPayment =
        row.farm_bucks_eligible === false &&
        row.farm_bucks_accepted === false &&
        farmBucksAccepted !== undefined;

      if (shouldFillDescription) {
        descriptionsFilled += 1;
        if (apply) {
          await tx`
            update sellers set description = ${details.description}
            where id = ${row.seller_id} and description is null
          `;
        }
      }

      if (shouldFillPayment) {
        paymentFactsFilled += 1;
        if (apply) {
          await tx`
            update sales_locations
            set farm_bucks_accepted = ${farmBucksAccepted}, farm_bucks_eligible = true
            where id = ${row.location_id}
              and farm_bucks_accepted = false and farm_bucks_eligible = false
          `;
        }
      }
    }

    console.log(
      `${apply ? "applied" : "would apply"}: ${descriptionsFilled} descriptions, ` +
        `${paymentFactsFilled} payment facts; ${unmatched.length} unmatched source entries`,
    );
    for (const name of unmatched) console.log(`  UNMATCHED  ${name}`);
    if (!apply) console.log("--dry-run: nothing written (pass --apply to write null-only updates)");
  });
} finally {
  await sql.end({ timeout: 5 });
}
