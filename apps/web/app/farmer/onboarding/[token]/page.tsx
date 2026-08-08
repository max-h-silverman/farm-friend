import {
  loadFarmerInvitation,
  readFarmListingForOnboarding,
} from "@farm-friend/db";
import { publicReadContext } from "../../../../lib/public-context";
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

  /*
    F-090 — WHAT VIGA ALREADY HOLDS, prefilled (max's point 3, 2026-08-08).

    Nearly every invited farm is one VIGA already seeded. Measured against the real corpus
    rather than assumed: 47 of 48 stands carry an address, 48 carry hours, 37 a season, and
    36 items are standing claims. This page passed no `defaults`, so those farmers met a
    blank form and were asked to retype all of it.

    **And that was a live defect, not merely a chore.** `saveOnboardingListing` replaces the
    WHOLE listing, so submitting the blank form they were shown would have overwritten VIGA's
    seeded address, hours, season and items with nothing — B-037's failure on the door where
    it costs the most, with nothing on screen and nothing failing.

    `null` for a farm VIGA has nothing on, which is a genuinely new farm: the form then starts
    empty, exactly as it always did. Prefilling must never invent a value.
  */
  const existing =
    invitation.farmId === null
      ? null
      : await readFarmListingForOnboarding(db, { farmId: invitation.farmId });

  const fromNumber = process.env.TELNYX_FROM_NUMBER?.trim();
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
      {/*
        NO LEDE (max 2026-08-07). It summarized the page — "tell people what you have, then send
        one text" — directly above a form that says both things where they happen: the section
        heading names the task, and the text hand-off is stated beside the phone field and again
        on the saved screen. A farmer read the same instruction three times before acting once.
      */}

      {/*
        F-067 — the listing comes FIRST, and the order is deliberate.

        The agreement step ends in a prepared `JOIN` text that leaves the page, and the
        invitation is spent when that text arrives. A farmer who texted first and then met
        the listing form would be finishing their listing on a page whose link no longer
        works if they ever reloaded it. So the listing is written while they are still here.

        max chose (2026-08-05) that it publishes on submit rather than waiting for the text:
        "the admin can fix anything that's erroneous".
      */}
      {/*
        The heading is `sr-only` (max 2026-08-07). "Your stand" was visible above a form whose
        first field already asks "What is your farm called?" — a label for a thing the farmer can
        see. It stays in the accessibility tree because `aria-labelledby` names the section, and a
        landmark with a dangling reference is worse than a redundant visible line.
      */}
      <section className="farmer-onboarding-card" aria-labelledby="listing-heading">
        <h2 className="sr-only" id="listing-heading">
          Your stand
        </h2>
        {/*
          `defaults` when VIGA already holds a listing for this farm (F-090). It used to be
          omitted on the reasoning that an invitation CREATES rather than edits — true of the
          RECORD, and wrong about the DATA: almost every invited farm was seeded from VIGA's
          forms, so "creating" meant replacing what was already there with a blank form's
          emptiness. See the read above.

          `smsNumber` is what lets the form name the number the farmer will text START to, both
          beside the phone field and in the confirmation. Absent when `TELNYX_FROM_NUMBER` is
          unset, and the form falls back to copy that names the word without the number rather
          than rendering "undefined".
        */}
        <ListingStep
          credential={{ kind: "invitation", token: params.token }}
          farmName={invitation.farmName ?? ""}
          {...(existing === null ? {} : { defaults: existing })}
          {...(fromNumber === undefined || fromNumber === "" ? {} : { smsNumber: fromNumber })}
        />
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

      {/*
        NO LINK-EXPIRY NOTE (max 2026-08-07). It said "this link expires after seven days and
        works once" — true, but it warned about the page the farmer is already successfully on,
        which is the one moment the fact cannot help them. A farmer who returns to a spent link
        gets the "no longer available" page, which states it where it actually applies and tells
        them what to do.
      */}
    </main>
  );
}
