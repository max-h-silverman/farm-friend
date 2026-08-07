import { loadFarmerInvitation } from "@farm-friend/db";
import { buildSignupSmsUrl } from "../../../../lib/farmer-invite";
import { publicReadContext } from "../../../../lib/public-context";
import { AgreementStep } from "./agreement-step";
import { ListingStep } from "./listing-step";

export const dynamic = "force-dynamic";

export default async function FarmerOnboardingPage({
  params,
}: {
  params: { token: string };
}) {
  const { db, clock } = publicReadContext();
  const invitation = await loadFarmerInvitation(db, params.token, clock.now());

  if (invitation.status !== "active") {
    return (
      <main className="farmer-onboarding">
        <p className="farmer-eyebrow">VIGA Farm Friend</p>
        <h1>This invitation is no longer available</h1>
        <p>
          Ask the VIGA coordinator who invited you for a new link. No farm information was
          changed.
        </p>
      </main>
    );
  }

  const fromNumber = process.env.TELNYX_FROM_NUMBER?.trim();
  const signupUrl =
    fromNumber === undefined || fromNumber === ""
      ? null
      : buildSignupSmsUrl(fromNumber, params.token);
  return (
    <main className="farmer-onboarding">
      <p className="farmer-eyebrow">VIGA Farm Friend</p>
      {/*
        The farm's name IS the heading. It is the one fact the farmer must check before
        agreeing — that this invitation is for their farm — and an earlier version buried it
        inside "Verify your phone for {farm}", where the instruction competed with the
        identification. The task itself is stated once, below, next to the control that
        performs it.
      */}
      <h1>{invitation.farmName ?? "Set up your farm"}</h1>
      <p className="farmer-onboarding-lede">
        Tell people what you have, then send one text from the phone you want to use for
        stand updates.
      </p>

      {/*
        F-067 — the listing comes FIRST, and the order is deliberate.

        The agreement step ends in a prepared `SIGNUP` text that leaves the page, and the
        invitation is spent when that text arrives. A farmer who texted first and then met
        the listing form would be finishing their listing on a page whose link no longer
        works if they ever reloaded it. So the listing is written while they are still here.

        max chose (2026-08-05) that it publishes on submit rather than waiting for the text:
        "the admin can fix anything that's erroneous".
      */}
      <section className="farmer-onboarding-card" aria-labelledby="listing-heading">
        <h2 id="listing-heading">Your stand</h2>
        {/*
          NO `defaults`, deliberately — an invitation CREATES a listing rather than editing
          one, so there is nothing to prefill and nothing B-037 could erase. Only the edit
          page passes them.
        */}
        <ListingStep
          credential={{ kind: "invitation", token: params.token }}
          farmName={invitation.farmName ?? ""}
        />
      </section>

      <section className="farmer-onboarding-card" aria-labelledby="verify-phone-heading">
        <h2 className="sr-only" id="verify-phone-heading">
          Agree to texts and verify your phone
        </h2>
        <AgreementStep token={params.token} signupUrl={signupUrl} />
      </section>

      {/*
        NOT a numbered to-do list. Presenting this as "step 2, step 3" told farmers more
        screens were coming when there are none. Framed as what to expect, it answers "what
        now?" rather than reading as an unfinished task.

        WHAT THIS NO LONGER SAYS: "VIGA reviews your request." Redeeming an agreed invitation
        that names a farm now authorizes the farmer and approves the farm in one transaction,
        with no administrator acting — so a review the farmer waits for would be a promise
        nobody keeps.
      */}
      <section className="farmer-onboarding-next" aria-labelledby="whats-next-heading">
        <h2 id="whats-next-heading">What happens next</h2>
        <p>
          Once you send the text, Farm Friend replies with how to update your stand. You can
          change anything here later by texting SETTINGS.
        </p>
      </section>

      <p className="farmer-onboarding-note">
        This link expires after seven days and works once.
      </p>
    </main>
  );
}
