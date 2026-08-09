import { hashFarmerLinkToken } from "@farm-friend/core";
import {
  listActiveSalesLocationParticipants,
  readStandListing,
  resolveFarmerLink,
} from "@farm-friend/db";
import { readCurrentStandEntries, resolveStandFromToken } from "../../../lib/farmer-stand";
import { loadFarmerSettings } from "../../../lib/farmer-settings";
import { publicReadContext } from "../../../lib/public-context";
import { ListingStep } from "../../farmer/onboarding/[token]/listing-step";
import { SettingsForm } from "./settings/settings-form";
import { StandForm } from "./stand-form";
import { StandTabs } from "./stand-tabs";

// The farmer's bookmarkable stand page (F-040), now TABBED (F-090).
//
// **Resolved server-side on every request.** There is no session and no cookie: the token in
// the path is the whole credential, and it is checked against the database each time the page
// is opened. A farmer whose access VIGA revoked sees the refusal on their very next load,
// which is the entire safety net behind a link that never expires.
//
// The page renders the farm name so a farmer can tell at a glance that the link is theirs —
// and deliberately nothing else about them. No phone number, no other farm, no customer data.
// What it can show is bounded by `resolveFarmerLink`'s projection, not by what this file
// remembers to leave out.
//
// ## F-090 — the two links became the second tab
//
// This page used to end in a nav headed "Change your stand's details", pointing at
// `/stand/[token]/listing` and `/stand/[token]/settings`. Both are now panels here: a farmer's
// two commonest return errands are one tap from where they land rather than one navigation,
// and a half-typed update survives switching between them because both panels stay mounted.
//
// The old routes still exist and still work — a farmer may have bookmarked one, and Farm
// Friend's own SMS replies name them. They are simply no longer the only way in.

export const dynamic = "force-dynamic";

export default async function StandPage({
  params,
}: {
  params: { token: string };
}) {
  const { db } = publicReadContext();
  const stand = await resolveStandFromToken(db, params.token);

  if (stand === null) {
    // The SAME message for a revoked link, a fabricated one, and a malformed one. Naming the
    // difference would tell whoever holds a copied link whether it was ever real.
    return (
      <main className="farmer-form">
        <h1>This link is not active</h1>
        <p id="new-link-help">
          It may have been replaced or turned off. Text <strong>LINK</strong> to VIGA Farm
          Friend to get a new one.
        </p>
      </main>
    );
  }

  const farms = await db.sql`
    select name from farms where id = ${stand.farmId}
  `;
  const locations = await db.sql`
    select name from sales_locations where id = ${stand.salesLocationId}
  `;
  // Scoped to the location AND sender the TOKEN resolved to, never ones named by the
  // request. The sender matters: the editor must show the base this farmer's next edit will
  // be composed against, which is their own open proposal when they have one.
  const currentEntries = await readCurrentStandEntries(
    db,
    stand.salesLocationId,
    stand.senderHash,
  );

  /*
    The details tab's data, read HERE rather than inside a client component.

    Both reads are the same ones the standalone pages perform, and they stay server-side for
    the same reason those do: `readStandListing` is the prefill the whole-listing writer
    depends on (B-037), and a client fetch would put a window between arriving and having it
    in which a save would erase what had not loaded.
  */
  const link = await resolveFarmerLink(db, {
    tokenHash: hashFarmerLinkToken(params.token),
  });
  const listing =
    link === null
      ? null
      : await readStandListing(db, { salesLocationId: link.salesLocationId });
  const settings = await loadFarmerSettings(db, params.token);
  const participantNamesByLocation =
    settings.status === "active"
      ? Object.fromEntries(
          await Promise.all(
            settings.locations.map(
              async (location) =>
                [
                  location.salesLocationId,
                  await listActiveSalesLocationParticipants(db, location.salesLocationId),
                ] as const,
            ),
          ),
        )
      : {};

  return (
    <main className="farmer-form">
      <header>
        <h1>{(locations[0]?.name as string | undefined) ?? "Your stand"}</h1>
        <p className="farmer-form-note">
          {(farms[0]?.name as string | undefined) ?? ""}
        </p>
      </header>

      <StandTabs
        statusPanel={
          <StandForm token={params.token} currentEntries={currentEntries} />
        }
        detailsPanel={
          <>
            {listing === null ? (
              <p className="farmer-form-note">
                We could not find your stand&apos;s details. Text Farm Friend and VIGA will
                sort it out.
              </p>
            ) : (
              <ListingStep
                credential={{ kind: "stand_link", token: params.token }}
                // The FARM's name, which is a different record from the stand's.
                farmName={listing.farmName}
                defaults={{
                  standName: listing.standName,
                  visitability: listing.visitability,
                  publicAddress: listing.publicAddress,
                  addressPublic: listing.addressPublic,
                  // F-092 — same B-037 rule: the writer sets this on every save, so an edit
                  // form that did not carry it would switch a farmer's prices back off.
                  pricesPublic: listing.pricesPublic,
                  latitude: listing.latitude,
                  longitude: listing.longitude,
                  hoursText: listing.hoursText,
                  availability: listing.availability,
                  paymentMethods: listing.paymentMethods,
                  // F-090 — carries each item's price. B-037's rule: the writer rewrites every
                  // item row on every save, so a price this could not see would be deleted.
                  items: listing.items,
                  description: listing.description,
                }}
              />
            )}

            {settings.status === "active" && (
              <SettingsForm
                token={params.token}
                locations={settings.locations}
                participantNamesByLocation={participantNamesByLocation}
              />
            )}
          </>
        }
      />

      <p id="new-link-help" className="farmer-form-note">
        Anyone with it can update this stand. Text <strong>LINK</strong> for a new
        one; ask VIGA to disable a shared link.
      </p>
    </main>
  );
}
