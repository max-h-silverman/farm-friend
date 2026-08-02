import { loadFarmerInvitation } from "@farm-friend/db";
import { buildSignupSmsUrl } from "../../../../lib/farmer-invite";
import { publicReadContext } from "../../../../lib/public-context";

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
      <h1>Start onboarding for {invitation.farmName}</h1>
      <p>
        VIGA invited this farm to join Farm Friend. The first step is proving that you control
        the phone number Farm Friend will use for updates. This invitation arrived by {invitation.channel === "sms" ? "text" : "email"}.
      </p>

      <section className="farmer-onboarding-card" aria-labelledby="verify-phone-heading">
        <h2 id="verify-phone-heading">Verify your phone</h2>
        <p>
          It does not matter whether you already joined Farm Friend by SMS. Send the message
          below from the phone you want to use, and VIGA will see that this farm invitation is
          yours.
        </p>
        {signupUrl === null ? (
          <p className="farmer-onboarding-instruction">
            Text <strong>SIGNUP {params.token}</strong> to the Farm Friend number from your
            invitation.
          </p>
        ) : (
          <a className="farmer-primary-link" href={signupUrl}>
            Text SIGNUP to verify this phone
          </a>
        )}
        <p className="farmer-onboarding-instruction">
          The prepared message includes this invitation, so your request is connected to
          <strong> {invitation.farmName}</strong>.
        </p>
      </section>

      <ol className="farmer-onboarding-steps">
        <li>Send the prepared text from your phone.</li>
        <li>VIGA reviews the request and gives farmer access when approved.</li>
        <li>Farm Friend sends your private link for updating your stand.</li>
      </ol>

      <p className="farmer-onboarding-note">
        This invitation expires after seven days and can be used once. It does not publish the
        farm or give access by itself.
      </p>
    </main>
  );
}
