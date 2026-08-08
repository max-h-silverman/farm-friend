import { hashFarmerLinkToken } from "@farm-friend/core";
import { readStandListing, resolveFarmerLink } from "@farm-friend/db";
import { publicReadContext } from "../../../../lib/public-context";
import { ListingStep } from "../../../farmer/onboarding/[token]/listing-step";

export const dynamic = "force-dynamic";

/**
 * F-073 — an already-onboarded farmer edits their own listing facts.
 *
 * **This closes a real gap.** Before it, listing facts were frozen for everyone except a farmer
 * mid-onboarding: hours, address, payment methods and what a stand usually sells could be
 * changed by nobody once the invitation was spent. A farmer whose season changed had no way to
 * say so, and the only route was an administrator editing the row by hand.
 *
 * It lives under the farmer's existing private stand link rather than behind a new credential.
 * `resolveFarmerLink` re-reads the authorization on every request, so a revoked farmer's link
 * resolves to nothing here — inherited, not reimplemented.
 *
 * **The form is prefilled, and that is load-bearing rather than polish.** The writer replaces
 * the whole listing, which is what lets a farmer drop an item by leaving it out — so a blank
 * form would erase an address and payment methods for a farmer who only came to change their
 * hours.
 */
export default async function FarmerListingEditPage({
  params,
}: {
  params: { token: string };
}) {
  const { db } = publicReadContext();
  const link = await resolveFarmerLink(db, {
    tokenHash: hashFarmerLinkToken(params.token),
  });

  if (link === null) {
    return (
      <main className="farmer-onboarding">
        <p className="farmer-eyebrow">VIGA Farm Friend</p>
        <h1>This link is no longer available</h1>
        <p>
          Text <strong>LINK</strong> to Farm Friend for a new one. Nothing was changed.
        </p>
      </main>
    );
  }

  const listing = await readStandListing(db, {
    salesLocationId: link.salesLocationId,
  });
  if (listing === null) {
    return (
      <main className="farmer-onboarding">
        <p className="farmer-eyebrow">VIGA Farm Friend</p>
        <h1>We could not find your stand</h1>
        <p>Text Farm Friend and VIGA will sort it out.</p>
      </main>
    );
  }

  return (
    <main className="farmer-onboarding">
      <p className="farmer-eyebrow">VIGA Farm Friend</p>
      <h1>{listing.standName}</h1>
      <p className="farmer-onboarding-lede">
        Change anything about your stand here. This is the information people see on the island
        map — not what is in stock today.
      </p>

      <section className="farmer-onboarding-card" aria-labelledby="listing-heading">
        <h2 id="listing-heading">Your stand</h2>
        <ListingStep
          credential={{ kind: "stand_link", token: params.token }}
          // The FARM's name — this passed `listing.standName` and so filled a field named
          // for the farm with the stand's name. The two are different records.
          farmName={listing.farmName}
          defaults={{
            standName: listing.standName,
            visitability: listing.visitability,
            publicAddress: listing.publicAddress,
            // F-088 — B-037's rule for the newest column: the writer sets it on every save, so
            // an edit form that did not carry it would republish a hidden address.
            addressPublic: listing.addressPublic,
            // F-092 — the same rule for the price switch: a form that could not see it would
            // reset it to off on the next otherwise-untouched save.
            pricesPublic: listing.pricesPublic,
            latitude: listing.latitude,
            longitude: listing.longitude,
            hoursText: listing.hoursText,
            // B-037 — the twelve structured season / hours / restocking columns. They were
            // absent here while `updateStand` wrote all twelve on every save, so a farmer
            // who came to change one field silently lost the rest. `readStandListing`
            // already returned them; only this line was missing.
            availability: listing.availability,
            paymentMethods: listing.paymentMethods,
            items: listing.items,
            // Same reason as the availability above: the writer replaces the farm's paragraph,
            // so a form that could not see it would clear it on the next save.
            description: listing.description,
          }}
        />
      </section>

      <p className="farmer-onboarding-note">
        To say what is in stock today, go back to your stand page and send an update.
      </p>
    </main>
  );
}
