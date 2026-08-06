import { listFarmsForSelfService } from "@farm-friend/db";
import { publicReadContext } from "../../../lib/public-context";
import { FarmPicker } from "./farm-picker";

export const dynamic = "force-dynamic";

/**
 * F-072 / F-073 — the public door that replaces VIGA's Google weekly-status form.
 *
 * One global link, no token and no administrator. A farmer picks their farm and the LIST does
 * the routing: a farm nobody can publish for goes to onboarding, and a farm that already has a
 * farmer goes to the update path instead of being set up twice.
 *
 * **The dropdown is a convenience, never the guarantee.** Anyone can post any farm id to the
 * endpoints behind it, so `claimGrandfatheredFarm` re-checks on submit. What this page owes the
 * farmer is a correct answer about where to go; what the boundary owes VIGA is that a wrong one
 * cannot write.
 *
 * Saying plainly that a farm is already set up discloses nothing: participation is already
 * public on the map (max, 2026-08-06).
 */
export default async function FarmerStartPage() {
  const { db } = publicReadContext();
  // BOTH kinds: the picker routes rather than merely offering, so a farmer whose farm is
  // already set up must find it here and be sent to the update path.
  const farms = await listFarmsForSelfService(db);

  return (
    <main className="farmer-onboarding">
      <p className="farmer-eyebrow">VIGA Farm Friend</p>
      <h1>Update your farm stand</h1>
      <p className="farmer-onboarding-lede">
        Find your farm to put what you have on the island map. If you have not set your stand
        up on Farm Friend yet, this is where you do it.
      </p>

      <section className="farmer-onboarding-card" aria-labelledby="pick-farm-heading">
        <h2 id="pick-farm-heading">Which farm is yours?</h2>
        <FarmPicker farms={farms} />
      </section>

      <p className="farmer-onboarding-note">
        Not listed? Text SIGNUP to Farm Friend and VIGA will set you up.
      </p>
    </main>
  );
}
