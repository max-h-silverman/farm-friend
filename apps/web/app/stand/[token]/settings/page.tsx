import Link from "next/link";
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

  return (
    <main className="farmer-form">
      <header>
        <h1>Stand settings</h1>
        <p className="farmer-form-note">
          Choose your default SMS stand and when Farm Friend should ask for a fresh listing.
        </p>
      </header>

      <SettingsForm token={params.token} locations={settings.locations} />

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
