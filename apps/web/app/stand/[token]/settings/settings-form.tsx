"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
// The SUBPATH, not the barrel. `@farm-friend/core` re-exports `privacy/phone.ts`, which
// imports `node:crypto` — unresolvable in a client bundle, and it 500s every farmer screen
// in local dev. `seller-credit.ts` is pure and is exported for exactly this reason.
import { creditSeller, LISTING_SEPARATOR } from "@farm-friend/core/seller-credit";
import { useTabCommit } from "../details-panel";

interface SettingsListing {
  providerId: string;
  salesLocationId: string;
  locationName: string;
  sellerName: string;
  /** The SELF-POINTER: true when this seller IS the stand. `creditSeller` decides from it. */
  describesOwnStand: boolean;
  /**
   * Whether THIS farmer may pause and resume this listing — the seam's own arm, carried here.
   *
   * F-101. A seller may pause, resume and end; a host may end and may NEVER pause. The screen's
   * duty is to offer no control that would be refused, so it renders from this rather than
   * deciding for itself — and never from `describesOwnStand`, which answers a different
   * question and is false for a hosted seller's OWN listing.
   */
  mayPause: boolean;
  selected: boolean;
  cadence: "every_2_days" | "weekly" | "every_2_weeks" | "paused" | null;
}

/*
  THE SETTINGS PANEL, after F-097's pass (max, 2026-08-08).

  What it looked like before, and why each part moved:

    * THREE save buttons — "Save default stand", "Save reminder" (one per stand), and "Save
      seller names" — for what a farmer reads as one screen of settings. Each wrote through a
      different endpoint, which is a real distinction in the code and none at all to the
      person looking at it. There is now ONE "Save settings" that writes everything that
      changed, and it names what it is saving rather than which endpoint it reaches.

    * "SUBMIT" as a label. That is onboarding's word — the act of handing in a form for the
      first time — and it read as though this page were being filed somewhere. A farmer
      changing a setting is saving, not submitting.

    * "ALSO SELLING HERE" at the very bottom, below the reminder schedules, so a question
      about WHO SELLS at a stand sat underneath a question about HOW OFTEN WE TEXT. It now
      sits directly under the stand it describes, which is where the farmer is already
      looking when they think about it.

    * THE DEFAULT-STAND PICKER shown to everyone. A farmer with one stand was asked to choose
      between one option — a radio group with a single radio, which cannot be answered wrongly
      and therefore should not be asked. It appears only when there is a genuine choice.

  The three endpoints are unchanged. Combining the SCREEN is not the same as combining the
  writers, and merging those would have put the participant save — which has its own audit
  event and its own public-text refusal — behind the same request as a cadence change.
*/
/**
 * ONE listing's pause / resume / Remove, on the farmer's own screen.
 *
 * F-101. The admin views carry the mirror of this (`SellerParticipation`); this is deliberately
 * NOT that component parameterised. The two say different things to different people: VIGA acts
 * on someone else's arrangement from a roster and reaches all three transitions, while a farmer
 * acts on her own listing and may be a host who can only end. Sharing one component would mean
 * one file holding both audiences' copy and both authority shapes.
 *
 * **Its own press, never "Save settings".** These acts are immediate and one of them is
 * terminal; a Save that carried them would end a listing because an unrelated field moved.
 *
 * **Remove is `end` and has no inverse** (max, 2026-08-17). Coming back is a fresh invitation
 * the seller must accept, so nothing here offers a restore.
 */
function ListingParticipation({
  token,
  listing,
  soleListing,
}: {
  token: string;
  listing: SettingsListing;
  /**
   * Whether this is the farmer's ONLY listing, which changes what pausing MEANS to her.
   *
   * The farmer-side reading of max's adapting label: on a stand where hers is the only listing,
   * pausing is her stand being closed, because on that stand that is its true effect. Where she
   * holds several, the control speaks about the one listing it sits under. The label tracks the
   * situation, not the mechanism — and no stand-level closed state exists either way.
   */
  soleListing: boolean;
}) {
  const [state, setState] = useState<"active" | "paused" | "ended">("active");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function act(transition: "pause" | "resume" | "end"): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/farmer/participation", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, providerId: listing.providerId, transition }),
      });
      if (!response.ok) {
        // Named by what it failed to do, not by which status came back.
        setError(
          transition === "end"
            ? "We could not remove that listing. Nothing changed."
            : "We could not change that listing. Nothing changed.",
        );
        return;
      }
      setState(transition === "end" ? "ended" : transition === "pause" ? "paused" : "active");
      setConfirming(false);
    } catch {
      setError("We could not reach Farm Friend. Nothing changed.");
    } finally {
      setBusy(false);
    }
  }

  const label = creditSeller(listing, LISTING_SEPARATOR);

  if (state === "ended") {
    return (
      <div className="farmer-settings-schedule" role="group" aria-label={label}>
        <p role="status" className="farmer-form-published">
          {label} is removed. It is off the map now. To sell there again, ask them for a new
          invitation.
        </p>
      </div>
    );
  }

  return (
    <div className="farmer-settings-schedule" role="group" aria-label={label}>
      {/*
        The name is shown only when there is more than one listing to tell apart — F-097's rule,
        which the default-listing picker follows for the same reason: naming her only stand back
        to her distinguishes it from nothing. The GROUP still carries the label either way, so a
        screen reader announces which listing a Remove button belongs to.
      */}
      {!soleListing && <h4>{label}</h4>}

      {state === "paused" && (
        <p role="status" className="farmer-form-note">
          {soleListing
            ? "Your stand is closed. Nobody sees it on the map until you open it again."
            : "This listing is paused. Nobody sees it on the map until you resume it."}
        </p>
      )}

      {error !== null && (
        <p className="farmer-form-error" role="alert">
          {error}
        </p>
      )}

      <div className="farmer-settings-listing-controls">
        {/*
          PAUSE only where the seam would allow it. A host reaches this listing through
          `host_may_update_stock` — which governs stock and never participation — so she gets
          Remove alone rather than a button that would answer `not_authorized`.
        */}
        {listing.mayPause && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void act(state === "paused" ? "resume" : "pause")}
          >
            {state === "paused"
              ? soleListing ? "Open my stand" : "Resume this listing"
              : soleListing ? "Close my stand for now" : "Pause this listing"}
          </button>
        )}

        {/*
          REMOVE, behind an inline confirmation — the existing farm-retire pattern. Terminal, so
          the confirming copy says what is lost rather than asking "are you sure".
        */}
        {confirming ? (
          <>
            {/* Spans the row, so the warning reads as a sentence above the choice rather than
                as a third item beside the two buttons. */}
            <p className="farmer-form-note farmer-settings-listing-warning">
              Removing takes {label} off the map for good. Coming back means a new invitation.
            </p>
            <button type="button" disabled={busy} onClick={() => void act("end")}>
              Yes, remove it
            </button>
            <button type="button" disabled={busy} onClick={() => setConfirming(false)}>
              Keep it
            </button>
          </>
        ) : (
          <button type="button" disabled={busy} onClick={() => setConfirming(true)}>
            Remove this listing
          </button>
        )}
      </div>
    </div>
  );
}

export function SettingsForm({
  token,
  listings,
  participantNamesByLocation = {},
}: {
  token: string;
  listings: SettingsListing[];
  participantNamesByLocation?: Record<string, string[]>;
}) {
  const initial = listings.find((listing) => listing.selected)?.providerId
    ?? listings[0]?.providerId
    ?? "";
  /**
   * The STAND behind the initially-selected listing (F-114 C.4).
   *
   * `participantNamesByLocation` is keyed by stand, because participants are the stand's own
   * record — so the listing id cannot index it, and using it would silently show an empty
   * seller list on every load.
   */
  const initialLocationId =
    listings.find((listing) => listing.providerId === initial)?.salesLocationId ?? "";
  /**
   * Whether the farmer has a real choice of default LISTING (C.4).
   *
   * One listing is not a choice, and a radio group holding a single radio asks a question with
   * one answer. `STAND` (the SMS keyword) has the same shape and already says "if you have
   * more than one" — this is that rule on the web surface.
   */
  const hasSeveralListings = listings.length > 1;
  const [providerId, setProviderId] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [linkInactive, setLinkInactive] = useState(false);
  /**
   * What was on screen when the page loaded, so one Save can write only what CHANGED.
   *
   * Held rather than re-read: sending every writer on every press would file a participant
   * audit event whenever a farmer touched an unrelated setting — an event claiming the
   * seller list was edited when it was not.
   */
  const [savedDefault, setSavedDefault] = useState(initial);
  const [participantNames, setParticipantNames] = useState(participantNamesByLocation);
  const [participantText, setParticipantText] = useState(
    (participantNamesByLocation[initialLocationId] ?? []).join("\n"),
  );
  const [savedParticipantText, setSavedParticipantText] = useState(participantText);

  /*
    F-114 Phase C.1 — INVITING ANOTHER SELLER, which is not a setting.

    Its own state and its own press, deliberately kept out of `save` above. Every other control
    here writes what CHANGED when the farmer presses Save; this one mints a link that exists
    exactly once. Folding it in would either issue an invitation because an unrelated field
    moved, or lose the minted link behind an unrelated failure.
  */
  const [inviteName, setInviteName] = useState("");
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [inviteError, setInviteError] = useState<string | null>(null);

  /*
    The seller-name box is about a STAND, not a listing, and stays that way: participants are
    the stand's own record (max, 2026-08-15), so two listings under one roof share one list.
    The selected listing names which stand that is.
  */
  const participantLocationId =
    listings.find((listing) => listing.providerId === savedDefault)?.salesLocationId ?? "";
  const participantLocationName =
    listings.find((listing) => listing.providerId === savedDefault)?.locationName
      ?? "this stand";

  const defaultChanged = providerId !== savedDefault;
  const participantsChanged = participantText !== savedParticipantText;
  const nothingToSave = !defaultChanged && !participantsChanged;

  /** One request, described by what it failed to change rather than by which route it hit. */
  async function post(
    url: string,
    body: Record<string, unknown>,
    unchanged: string,
  ): Promise<Record<string, unknown> | null> {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, ...body }),
      });
      const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (!response.ok) {
        if (response.status === 403) setLinkInactive(true);
        setError(
          response.status === 403
            ? `This link is no longer active. ${unchanged} is unchanged.`
            : typeof payload.message === "string"
              ? payload.message
              : `That did not go through. ${unchanged} is unchanged — try again.`,
        );
        return null;
      }
      return payload;
    } catch {
      setError(`That did not go through. ${unchanged} is unchanged — try again.`);
      return null;
    }
  }

  /**
   * Save everything the farmer changed, in one press.
   *
   * **Stops at the first failure rather than pressing on.** A partial save reported as success
   * is the shape of lie this codebase refuses: the farmer would read "saved" over a screen
   * where one of their three changes silently did not take. What has already been written
   * stays written and is marked as saved, so a retry sends only what is still outstanding.
   */
  async function save(): Promise<boolean> {
    // Nothing to write is a SUCCESSFUL save from the caller's point of view: the tab's one
    // button must not report failure because this panel happened to be untouched.
    if (nothingToSave) return true;
    if (busy) return false;
    setBusy(true);
    setError(null);
    setSaved(false);
    setLinkInactive(false);
    try {
      if (defaultChanged) {
        const payload = await post(
          "/api/farmer/settings",
          { providerId },
          "Your default listing",
        );
        if (payload === null) return false;
        setSavedDefault(providerId);
        // The seller-name box follows the default listing's STAND, so it reloads onto the new
        // one — and its baseline moves with it, or the next Save would post one stand's names
        // against another's. Two listings at one stand share a list and reload to the same
        // text, which is correct: the participants did not change.
        const nextLocationId =
          listings.find((listing) => listing.providerId === providerId)?.salesLocationId ?? "";
        const names = (participantNames[nextLocationId] ?? []).join("\n");
        setParticipantText(names);
        setSavedParticipantText(names);
      }

      // Only when the default did NOT move: that branch already reset the box to the new
      // stand's names, and posting here would write those names against a stand the farmer
      // never edited them for.
      if (participantsChanged && !defaultChanged) {
        const names = participantText
          .split(/\r?\n/)
          .map((name) => name.trim())
          .filter((name) => name !== "");
        const payload = await post(
          "/api/farmer/stand",
          { action: "save_participants", participantNames: names },
          "Seller names",
        );
        if (payload === null) return false;
        const stored = Array.isArray(payload.activeDisplayNames)
          ? payload.activeDisplayNames.filter((name): name is string => typeof name === "string")
          : names;
        setParticipantNames((current) => ({
          ...current,
          [participantLocationId]: stored,
        }));
        setParticipantText(stored.join("\n"));
        setSavedParticipantText(stored.join("\n"));
      }

      setSaved(true);
      return true;
    } finally {
      setBusy(false);
    }
  }

  /**
   * Invite one seller to sell at this stand, and show the link the farmer forwards.
   *
   * **Its own request and its own reporting**, separate from `save` for the reason stated where
   * the state is declared. The refusal message comes from the SERVER when it sends one: that
   * copy is code-owned and shared with VIGA's door, and restating it here is how two doors come
   * to tell a farmer different things about one rule.
   */
  async function invite(): Promise<void> {
    const name = inviteName.trim();
    // Nothing to send. Refused here as well as by the writer — this stops a press that could
    // only fail, rather than restating the rule the writer enforces.
    if (name === "" || inviteBusy) return;
    setInviteBusy(true);
    setInviteError(null);
    setInviteLink(null);
    try {
      const response = await fetch("/api/farmer/stand", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, action: "invite_seller", newSellerName: name }),
      });
      const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (!response.ok || typeof payload.link !== "string") {
        if (response.status === 403) setLinkInactive(true);
        setInviteError(
          response.status === 403
            ? `This link is no longer active. ${name} was not invited.`
            : typeof payload.message === "string"
              ? payload.message
              : payload.reason === "already_selling_here"
                ? `${name} already sells here, or has an invitation waiting. Nobody was invited again.`
                : `That did not go through. ${name} was not invited — try again.`,
        );
        return;
      }
      setInviteLink(payload.link);
      setInviteName("");
    } catch {
      setInviteError(`That did not go through. ${name} was not invited — try again.`);
    } finally {
      setInviteBusy(false);
    }
  }

  /*
    HAND THE SAVE UP, so the tab's one button can run this panel's writers (F-098).

    Through a ref read at call time rather than by re-registering on every render: `save`
    closes over this render's state, and a parent holding a stale copy would post the values
    the farmer saw when the tab mounted rather than what is on screen now.
  */
  const tab = useTabCommit();
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    tab?.registerSave(() => saveRef.current());
  }, [tab]);

  return (
    <section className="farmer-settings-content" aria-labelledby="settings-heading">
      <h2 id="settings-heading" className="farmer-settings-heading">
        Settings
      </h2>

      {error !== null && (
        <p className="farmer-form-error" role="alert">
          {error}{" "}
          {linkInactive && <Link href="#new-link-help">How to get a new link</Link>}
        </p>
      )}
      {saved && tab === null && (
        <p className="farmer-form-published" role="status">
          Settings saved.
        </p>
      )}

      {/*
        THE DEFAULT LISTING, asked only when there is more than one (max 2026-08-08; per-listing
        in F-114 C.4). A single listing makes this a question with one answer, which is noise on
        a settings screen.

        "Which listing" rather than "which stand", for the reason the SMS menu asks the same
        way: a host choosing between two listings under one roof has no answer to "which stand".
      */}
      {hasSeveralListings && (
        <div className="farmer-settings-section">
          <h3>Which listing your texts are about</h3>
          <p id="default-stand-help" className="farmer-form-note">
            When you text an update without saying which listing, we use this one. You can
            switch any time by texting STAND.
          </p>
          <fieldset className="farmer-settings-options" aria-describedby="default-stand-help">
            <legend className="sr-only">Choose your default SMS listing</legend>
            {listings.map((listing) => (
              <label className="farmer-settings-choice" key={listing.providerId}>
                <input
                  type="radio"
                  name="default-stand"
                  value={listing.providerId}
                  checked={providerId === listing.providerId}
                  onChange={() => {
                    setProviderId(listing.providerId);
                    setSaved(false);
                  }}
                />
                <span>{creditSeller(listing, LISTING_SEPARATOR)}</span>
              </label>
            ))}
          </fieldset>
        </div>
      )}

      {/*
        WHO ELSE SELLS AT THIS STAND — moved up from the bottom of the panel (max 2026-08-08).

        It belongs beside the stand it describes rather than below the reminder schedules: a
        farmer thinking about who sells at their stand is not thinking about how often they
        get texted, and the old order put the two questions in that sequence.
      */}
      <div className="farmer-settings-section">
        <h3>Also selling here</h3>
        <p id="seller-names-help" className="farmer-form-note">
          Anyone else whose goods are on the table at {participantLocationName}, one name per
          line. These names show on your public listing and give nobody permission to update
          it.
        </p>
        <label htmlFor="farmer-participant-names" className="sr-only">
          Seller names
        </label>
        <textarea
          id="farmer-participant-names"
          aria-describedby="seller-names-help"
          value={participantText}
          rows={4}
          onChange={(event) => {
            setParticipantText(event.target.value);
            setSaved(false);
          }}
        />
      </div>

      {/*
        INVITE A SELLER (F-114 Phase C.1) — directly under the names, because the two are the
        honest halves of one question. A name on the list above is a CREDIT and nothing more; an
        invitation gives that person their own phone, their own inventory, and their own listing
        here. The farmer choosing between them is choosing how much the other seller runs
        themselves, and putting the two anywhere but together would hide that choice.

        Its own button. This is not a setting, so it must not ride "Save settings" — see the
        state declarations above.
      */}
      <div className="farmer-settings-section">
        <h3>Invite someone to sell here</h3>
        <p id="invite-seller-help" className="farmer-form-note">
          Give another grower or maker their own listing at {participantLocationName}, so they
          keep their own stock up to date from their own phone. We&apos;ll make a link and you
          send them the link yourself — we never text them first. Nobody is listed until they
          finish setting up.
        </p>
        <label htmlFor="farmer-invite-seller">Who are you inviting?</label>
        <input
          id="farmer-invite-seller"
          type="text"
          aria-describedby="invite-seller-help"
          value={inviteName}
          disabled={inviteBusy}
          onChange={(event) => setInviteName(event.target.value)}
        />
        {inviteError !== null && (
          <p className="farmer-form-error" role="alert">
            {inviteError}{" "}
            {linkInactive && <Link href="#new-link-help">How to get a new link</Link>}
          </p>
        )}
        {/*
          SHOWN, not merely copied. The farmer forwards this by hand and it is minted once, so a
          link that only reached the clipboard would be lost to any copy failure.
        */}
        {inviteLink !== null && (
          <div role="status">
            <p className="farmer-form-published">
              Here is their link — send it to them. We only show it once.
            </p>
            <input aria-label="Invitation link" readOnly value={inviteLink} />
          </div>
        )}
        <button
          type="button"
          disabled={inviteBusy || inviteName.trim() === ""}
          onClick={() => void invite()}
        >
          {inviteBusy ? "Inviting…" : "Invite them"}
        </button>
      </div>

      {/*
        PAUSING AND LEAVING (F-101) — last, and deliberately below the invitation.

        The panel reads top to bottom as: which listing we text you about, who else sells here,
        who else you'd like to bring in, and finally — stepping away or leaving altogether. The
        one destructive control on the screen sits at the end, where a farmer arrives at it
        rather than passing it on the way to a cadence setting.

        One block per listing, each with its own state: a farmer who pauses one must not see the
        other change, and the seam invalidates only that provider's open work.
      */}
      <div className="farmer-settings-section">
        <h3>Taking a break, or stopping</h3>
        <p className="farmer-form-note">
          Pausing hides a listing from the map and stops the texts asking about it. Your stock
          and settings are kept, and you can come back whenever you like.
        </p>
        {listings.map((listing) => (
          <ListingParticipation
            key={listing.providerId}
            token={token}
            listing={listing}
            soleListing={listings.length === 1}
          />
        ))}
      </div>

      {/*
        ONE button for the whole panel, and it says SAVE — never "Submit", which is
        onboarding's word for handing a form in the first time.

        HIDDEN when the panel is embedded in a tab that commits for it (F-098, max's call):
        the returning farmer's "Details & settings" tab has a single "Save changes", and a
        second button beside it asks which one counted. The standalone `/stand/[token]/settings`
        page — which a farmer may have bookmarked and which Farm Friend's own SMS replies name —
        has no such button of its own, so there it still renders.
      */}
      {tab === null && (
        <button type="button" disabled={busy || nothingToSave} onClick={() => void save()}>
          {busy ? "Saving…" : "Save settings"}
        </button>
      )}
    </section>
  );
}
