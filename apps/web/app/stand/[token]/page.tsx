import { readCurrentStandEntries, resolveStandFromToken } from "../../../lib/farmer-stand";
import Link from "next/link";
import { publicReadContext } from "../../../lib/public-context";
import { StandForm } from "./stand-form";

// The farmer's bookmarkable stand page (F-040).
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
  // request. The sender matters: the chips must show the base this farmer's next edit will
  // be composed against, which is their own open proposal when they have one.
  const currentEntries = await readCurrentStandEntries(
    db,
    stand.salesLocationId,
    stand.senderHash,
  );
  return (
    <main className="farmer-form">
      <header>
        <h1>{(locations[0]?.name as string | undefined) ?? "Your stand"}</h1>
        <p className="farmer-form-note">
          {(farms[0]?.name as string | undefined) ?? ""}
        </p>
      </header>

      {/*
        Says what the screen now IS. It used to promise "update in your own words", which
        described the text box back when that was the only way in — with the listing directly
        editable, leading with prose would point a farmer at the slower path.
      */}
      <p className="farmer-form-note">
        Take things off, add what you have, or write it out. We&apos;ll show you exactly what
        people will see, and <strong>nothing changes until you confirm it</strong>.
      </p>

      <StandForm token={params.token} currentEntries={currentEntries} />

      {/*
        F-073 — the listing facts, kept clearly separate from the stock update above. "What I
        usually sell" and "what is on the table today" are two different claims (F-066), and the
        wording says which is which so a farmer does not come here to report today's eggs.

        Grouped under a heading rather than left as two bare links directly beneath the submit
        button, where they read as continuations of the update the farmer was mid-way through —
        a farmer reporting today's eggs should not find "what you usually sell" as the next
        thing after the button they just pressed. These are somewhere ELSE to go, and the
        heading says so before either link is read.
      */}
      <nav className="farmer-stand-elsewhere" aria-labelledby="stand-elsewhere-heading">
        <h2 id="stand-elsewhere-heading">Change your stand&apos;s details</h2>
        <Link className="farmer-settings-back" href={`/stand/${params.token}/listing`}>
          Stand details: address, hours, payment, and what you usually sell
        </Link>

        <Link className="farmer-settings-back" href={`/stand/${params.token}/settings`}>
          Stand settings: reminders, default stand, and other sellers
        </Link>
      </nav>

      <p id="new-link-help" className="farmer-form-note">
        This link is private — anyone with it can update this stand. If it stops working, text
        <strong> LINK</strong> to VIGA Farm Friend for a new one. If you share it by accident,
        ask VIGA to turn it off.
      </p>
    </main>
  );
}
