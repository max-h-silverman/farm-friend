import { resolveStandFromToken } from "../../../lib/farmer-stand";
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
        <p>
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

  return (
    <main className="farmer-form">
      <header>
        <h1>{(locations[0]?.name as string | undefined) ?? "Your stand"}</h1>
        <p className="farmer-form-note">
          {(farms[0]?.name as string | undefined) ?? ""}
        </p>
      </header>

      <p className="farmer-form-note">
        Type what you have today, the way you would say it. We&apos;ll show you exactly what
        your stand will say, and <strong>nothing changes until you confirm it</strong>.
      </p>

      <StandForm token={params.token} />

      <p className="farmer-form-note">
        This link is private — anyone with it can update this stand. If you lose your phone or
        share it by accident, ask VIGA to turn it off.
      </p>
    </main>
  );
}
