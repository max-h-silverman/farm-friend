import { listFarmsForSelfService } from "@farm-friend/db";
import { notFound } from "next/navigation";
import { publicReadContext } from "../../../../lib/public-context";
import { farmerStartSecretMatches } from "../../../../lib/farmer-start-secret";
import { FarmPicker } from "../farm-picker";

export const dynamic = "force-dynamic";

/**
 * F-079 — the migration door, behind a secret path segment.
 *
 * This is the page VIGA's Google weekly-status form becomes, and it is deliberately NOT the
 * general front door: new farms are invite-only, and this exists so farmers already using the
 * Google form can move themselves across. The bare `/farmer/start` path no longer exists.
 *
 * **The secret is obscurity, not authentication** — it lands in browser history, `Referer`
 * headers and access logs, and unlike `/stand/[token]` it is neither one-use nor revocable. It
 * keeps this path from being crawled and casually walked in. What actually proves a person may
 * publish for a farm is the emailed code on the next step.
 *
 * A wrong secret and an unconfigured deployment produce the SAME 404, so the response never
 * reveals that the door exists and is merely switched off.
 */
export default async function SecretFarmerStartPage({
  params,
  searchParams,
}: {
  params: Promise<{ secret: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { secret } = await params;
  if (!farmerStartSecretMatches(process.env, secret)) notFound();

  const { db } = publicReadContext();
  const query = await searchParams;
  const farms = await listFarmsForSelfService(db, {
    includeTestFarms: query.hidden === "true",
  });

  return (
    <main className="farmer-onboarding">
      <p className="farmer-eyebrow">VIGA Farm Friend</p>
      <h1>Update your farm stand</h1>
      <p className="farmer-onboarding-lede">
        Find your farm to put what you have on the island map. You will confirm it is you with a
        code emailed to the address VIGA has on file.
      </p>

      <section className="farmer-onboarding-card" aria-labelledby="pick-farm-heading">
        <h2 id="pick-farm-heading">Which farm is yours?</h2>
        <FarmPicker farms={farms} basePath={`/farmer/start/${encodeURIComponent(secret)}`} />
      </section>

      <p className="farmer-onboarding-note">
        Not listed, or no longer have that email address? Contact VIGA and they will help.
      </p>
    </main>
  );
}
