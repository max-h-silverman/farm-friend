import { loadFarmerInvitation } from "@farm-friend/db";
import { buildSignupSmsUrl } from "../../../../lib/farmer-invite";
import { publicReadContext } from "../../../../lib/public-context";
import { AgreementStep } from "./agreement-step";

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
        Agree to texts and send one message from the phone you want to use for stand updates.
      </p>

      <section className="farmer-onboarding-card" aria-labelledby="verify-phone-heading">
        <h2 className="sr-only" id="verify-phone-heading">
          Agree to texts and verify your phone
        </h2>
        <AgreementStep token={params.token} signupUrl={signupUrl} />
      </section>

      {/*
        NOT a numbered to-do list. Everything here happens without the farmer, and presenting
        it as "step 2, step 3" told them two more screens were coming when there are none —
        the remaining work is VIGA's. Framed as what to expect, the wait becomes the
        page's answer to "what now?" rather than an unfinished task.
      */}
      <section className="farmer-onboarding-next" aria-labelledby="whats-next-heading">
        <h2 id="whats-next-heading">What happens next</h2>
        <p>
          VIGA reviews your request. Once your farm is approved, Farm Friend texts you how to
          update your stand.
        </p>
      </section>

      <p className="farmer-onboarding-note">
        Nothing is public yet. This link expires after seven days and works once.
      </p>
    </main>
  );
}
