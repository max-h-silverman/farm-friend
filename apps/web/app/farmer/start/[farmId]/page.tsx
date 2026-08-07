import { claimGrandfatheredFarm } from "@farm-friend/db";
import { publicReadContext } from "../../../../lib/public-context";
import { ListingStep } from "../../onboarding/[token]/listing-step";

export const dynamic = "force-dynamic";

/**
 * F-072 — a grandfathered farmer fills in their own listing, with no invitation.
 *
 * This is the page VIGA's Google weekly-status form becomes. The farm was picked from the public
 * dropdown; there is no token, no administrator, and no phone check — max chose the honour
 * system (2026-08-06) because VIGA supplied no phone roster to verify anyone against.
 *
 * **The claim is re-checked here and again on submit.** Rendering the form for a farm that
 * already has a farmer would invite a farmer to type a listing that is then refused, and
 * checking only here would let a stale page write after someone else onboarded.
 *
 * The form itself is the SAME component the invited path uses, parameterized by credential.
 * Two forms would drift into publishing different shapes onto one map.
 */
export default async function GrandfatheredOnboardingPage({
  params,
}: {
  params: { farmId: string };
}) {
  const { db } = publicReadContext();
  const claim = await claimGrandfatheredFarm(db, { farmId: params.farmId });

  if (claim.status === "already_onboarded") {
    return (
      <main className="farmer-onboarding">
        <p className="farmer-eyebrow">VIGA Farm Friend</p>
        <h1>This farm is already set up</h1>
        <p>
          Someone has already set this farm up on Farm Friend. Go back and choose it again to
          have your update link texted to you.
        </p>
        <p className="farmer-picker-next">
          <a className="farmer-primary-action" href="/farmer/start">
            Back to the farm list
          </a>
        </p>
      </main>
    );
  }

  if (claim.status !== "claimable") {
    return (
      <main className="farmer-onboarding">
        <p className="farmer-eyebrow">VIGA Farm Friend</p>
        <h1>We could not find that farm</h1>
        <p>Go back and pick your farm from the list.</p>
        <p className="farmer-picker-next">
          <a className="farmer-primary-action" href="/farmer/start">
            Back to the farm list
          </a>
        </p>
      </main>
    );
  }

  return (
    <main className="farmer-onboarding">
      <p className="farmer-eyebrow">VIGA Farm Friend</p>
      <h1>{claim.farmName}</h1>
      <p className="farmer-onboarding-lede">
        Tell people what you have. This goes straight onto the island map.
      </p>

      <section className="farmer-onboarding-card" aria-labelledby="listing-heading">
        <h2 id="listing-heading">Your stand</h2>
        {/*
          NO `defaults`, deliberately — this door CREATES a listing rather than editing one,
          so there is nothing to prefill and nothing B-037 could erase. Only the edit page
          passes them.
        */}
        <ListingStep
          credential={{ kind: "grandfathered", farmId: claim.farmId }}
          farmName={claim.farmName}
        />
      </section>

      {/*
        No phone-verification step here, and its absence is deliberate. The invited page ends in a text
        because redeeming an invitation from a handset is what authorizes that farmer. This door
        has no invitation to redeem, so it publishes the LISTING only — updating stock by text
        still needs an authorization, which still needs VIGA. Saying so plainly beats letting a
        farmer discover it when their first text is refused.
      */}
      <section className="farmer-onboarding-next" aria-labelledby="whats-next-heading">
        <h2 id="whats-next-heading">What happens next</h2>
        <p>
          Your stand goes on the map as soon as you save. To update what is in stock by text,
          contact VIGA and they will finish setting you up.
        </p>
      </section>
    </main>
  );
}
