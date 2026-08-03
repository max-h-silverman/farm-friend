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
  const farmHeading =
    invitation.farmName === null
      ? "Verify your phone for Farm Friend"
      : `Verify your phone for ${invitation.farmName}`;
  const invitationDescription =
    invitation.farmName === null
      ? "VIGA invited you to start onboarding a new farm on Farm Friend."
      : `VIGA invited ${invitation.farmName} to join Farm Friend.`;

  return (
    <main className="farmer-onboarding">
      <p className="farmer-eyebrow">VIGA Farm Friend</p>
      <h1>{farmHeading}</h1>
      <p>
        {invitationDescription} Use the phone Farm Friend should use for stand updates. This
        invitation arrived by {invitation.channel === "sms" ? "text" : "email"}.
      </p>

      <section className="farmer-onboarding-card" aria-labelledby="verify-phone-heading">
        <p className="farmer-eyebrow">Step 1 of 3: verify your phone</p>
        <h2 id="verify-phone-heading">Send one prepared text</h2>
        <p>
          Send this from the phone you want to use. It proves you control the number; it does
          not approve your farm or publish anything.
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
          The prepared message includes this invitation, so VIGA can connect your request to
          {invitation.farmName === null ? (
            <strong> new-farm onboarding</strong>
          ) : (
            <strong> {invitation.farmName}</strong>
          )}.
        </p>
      </section>

      <ol className="farmer-onboarding-steps">
        <li>After you send it, you are done for now.</li>
        <li>VIGA reviews the request and decides whether to authorize your farm.</li>
        <li>When your farm is ready, Farm Friend texts how to update your stand by SMS or web.</li>
      </ol>

      <p className="farmer-onboarding-note">
        Nothing is public yet. This invitation expires after seven days and can be used once.
      </p>
    </main>
  );
}
