import Link from "next/link";
import { listActiveSalesLocationParticipants } from "@farm-friend/db";
import { publicReadContext } from "../../../../lib/public-context";
import { loadFarmerSettings } from "../../../../lib/farmer-settings";
import { SettingsForm } from "./settings-form";

export const dynamic = "force-dynamic";

export default async function FarmerSettingsPage({
  params,
}: {
  params: { token: string };
}) {
  const { db } = publicReadContext();
  const settings = await loadFarmerSettings(db, params.token);

  if (settings.status === "not_authorized") {
    return (
      <main className="farmer-form">
        <h1>This link is not active</h1>
        <p id="new-link-help" className="farmer-form-note">
          It may have been replaced or turned off. Text <strong>SETTINGS</strong> to VIGA
          Farm Friend to get a new one.
        </p>
      </main>
    );
  }

  const participantNamesByLocation = Object.fromEntries(
    await Promise.all(
      // Deduplicated by STAND: participants are the stand's own record, so two listings under
      // one roof share one list and must not be fetched (or keyed) twice.
      [...new Set(settings.listings.map((listing) => listing.salesLocationId))].map(
        async (salesLocationId) => [
          salesLocationId,
          await listActiveSalesLocationParticipants(db, salesLocationId),
        ] as const,
      ),
    ),
  );

  return (
    <main className="farmer-form">
      <header>
        <h1>Stand settings</h1>
        <p className="farmer-form-note">
          Choose your default SMS listing and when Farm Friend should ask for a fresh listing.
        </p>
      </header>

      <SettingsForm
        token={params.token}
        listings={settings.listings}
        participantNamesByLocation={participantNamesByLocation}
      />

      <Link className="farmer-settings-back" href={`/stand/${params.token}`}>
        Back to stand update
      </Link>
      <p id="new-link-help" className="farmer-form-note">
        This private link controls only stands VIGA has authorized you to edit. If it stops
        working, text <strong>SETTINGS</strong> for a new one.
      </p>
    </main>
  );
}
