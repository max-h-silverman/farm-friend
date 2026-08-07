import { buildStandDescription } from "@farm-friend/core";
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

  // The hand-off number, read the same way and from the same variable the contact card and the
  // send path use — one number in configuration, so the word a farmer is told to text can never
  // drift from the number that receives it.
  //
  // A MISSING value degrades to the generic "send one text" line rather than throwing. This
  // page is the farmer's publishing surface, and F-072 already shipped the other failure once:
  // binding a farmer page to configuration it does not strictly need turned an unrelated absent
  // variable into a 500 on the whole form. The listing must publish with or without this.
  const smsNumber = process.env.TELNYX_FROM_NUMBER?.trim() || undefined;

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
              The listing fields are NOT prefilled — this door replaces VIGA's seeded listing
              with what the farmer states, which is the point of migrating.

              The farm's PARAGRAPH is the exception, and it has to be. It renders on the public
              card, VIGA's copy of it is what is showing there today, and no farmer surface
              could reach it — so a blank box here would publish a listing that silently
              dropped the farm's own words. It arrives with the lines that restate a structured
              fact already stripped (`buildStandDescription`), so what the farmer sees is only
              what no other field on this form covers.
            */}
            <ListingStep
              credential={{ kind: "grandfathered", farmId: claim.farmId }}
              farmName={claim.farmName}
              description={
                buildStandDescription({ mapDescription: claim.description ?? undefined }) ?? ""
              }
              {...(smsNumber === undefined ? {} : { smsNumber })}
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

      {/*
        NO VIGA STEP. This said "contact VIGA and they will finish setting you up", which asked
        a farmer to wait for a coordinator to do by hand what one text does — and F-067 already
        learned that a promised step nobody performs is a silent dead end.

        The farmer texts US, and that direction is not a preference. `isProactiveSendPermitted`
        permits an un-consented send only for `required_reply` (the carrier-required answer to
        the recipient's own message), so Farm Friend cannot send the first text at all. Their
        inbound START is the possession proof and the opt-in in one message, through the same
        consent writer every other opt-in uses.
      */}
      <section className="farmer-onboarding-next" aria-labelledby="whats-next-heading">
        <h2 id="whats-next-heading">What happens next</h2>
        <p>
          Your stand goes on the map as soon as you submit. To update what is in stock{" "}
          <strong>by text</strong>, send one text from your phone afterwards — we will show you
          the word to send. No need to contact anyone.
        </p>
      </section>
    </main>
  );
}
