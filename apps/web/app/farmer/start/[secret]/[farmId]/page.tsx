import { claimGrandfatheredFarm, resolvePublishGrant } from "@farm-friend/db";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { publicReadContext } from "../../../../../lib/public-context";
import { farmerStartSecretMatches } from "../../../../../lib/farmer-start-secret";
import { grantTokenFromRequest } from "../../../../../lib/publish-grant";
import { ListingStep } from "../../../onboarding/[token]/listing-step";
import { VerifyGate } from "./verify-gate";

export const dynamic = "force-dynamic";

/**
 * F-079 — the migration door's per-farm page: verify by email, then fill in the listing.
 *
 * **The secret gates the page; the emailed code gates the WRITE.** The secret is obscurity and
 * travels in logs and history, so it cannot be what protects a farm's listing. Verification is
 * per-farm, expiring, single-use, and rate-limited, and it is what the publish grant comes from.
 *
 * **Verification grants publishing rights ONLY, never farmer authorization.** The page says so
 * plainly rather than letting a farmer discover it when their first text is refused — updating
 * stock by SMS still requires an inbound message from a consented handset.
 */
export default async function SecretFarmerOnboardingPage({
  params,
}: {
  params: Promise<{ secret: string; farmId: string }>;
}) {
  const { secret, farmId } = await params;
  if (!farmerStartSecretMatches(process.env, secret)) notFound();

  const { db, clock } = publicReadContext();
  const claim = await claimGrandfatheredFarm(db, { farmId });

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
          <a className="farmer-primary-action" href={`/farmer/start/${encodeURIComponent(secret)}`}>
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
          <a className="farmer-primary-action" href={`/farmer/start/${encodeURIComponent(secret)}`}>
            Back to the farm list
          </a>
        </p>
      </main>
    );
  }

  // The grant is re-resolved from the database on EVERY request rather than trusted from the
  // cookie, and it is checked against THIS farm: a grant for farm A must never open farm B.
  const cookieHeader = (await headers()).get("cookie") ?? "";
  const token = grantTokenFromRequest(
    new Request("https://farm-friend.local/", { headers: { cookie: cookieHeader } }),
  );
  const grant =
    token === null ? null : await resolvePublishGrant(db, { token, now: clock.now() });
  const verified = grant !== null && grant.farmId === claim.farmId;

  return (
    <main className="farmer-onboarding">
      <p className="farmer-eyebrow">VIGA Farm Friend</p>
      <h1>{claim.farmName}</h1>

      {verified ? (
        <>
          <p className="farmer-onboarding-lede">
            Tell people what you have. This goes straight onto the island map.
          </p>
          <section className="farmer-onboarding-card" aria-labelledby="listing-heading">
            <h2 id="listing-heading">Your stand</h2>
            {/*
              NO `defaults` — this door CREATES a listing rather than editing one, so there is
              nothing to prefill and nothing B-037 could erase.
            */}
            <ListingStep
              credential={{ kind: "grandfathered", farmId: claim.farmId }}
              farmName={claim.farmName}
            />
          </section>
        </>
      ) : (
        <>
          <section className="farmer-onboarding-card" aria-labelledby="verify-heading">
            <p className="farmer-step-marker">Step 2 of 2</p>
            <h2 id="verify-heading">Confirm it is you</h2>
            <VerifyGate farmId={claim.farmId} farmName={claim.farmName} />
          </section>
          {/* The way back to the list, so a farmer who picked the wrong farm is not stuck
              reaching for the browser's back button. */}
          <p className="farmer-step-back">
            <a href={`/farmer/start/${encodeURIComponent(secret)}`}>← Choose a different farm</a>
          </p>
        </>
      )}

      <section className="farmer-onboarding-next" aria-labelledby="whats-next-heading">
        <h2 id="whats-next-heading">What happens next</h2>
        <p>
          Your stand goes on the map as soon as you submit.To update what is in stock <strong>by text</strong>, contact VIGA and
          they will finish setting you up.
        </p>
      </section>
    </main>
  );
}
