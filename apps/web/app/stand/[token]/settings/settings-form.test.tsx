// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DetailsPanel, useTabCommit } from "../details-panel";
import { SettingsForm } from "./settings-form";

const listings: Parameters<typeof SettingsForm>[0]["listings"] = [
  {
    providerId: "stand-a",
    salesLocationId: "loc-a",
    locationName: "Orchard Stand",
    sellerName: null,
    selected: true,
    cadence: null,
  },
  {
    providerId: "stand-b",
    salesLocationId: "loc-b",
    locationName: "Harbor Stand",
    sellerName: null,
    selected: false,
    cadence: "paused" as const,
  },
];

/** The common case on Vashon: one listing, so nothing to choose between. */
const oneListing: Parameters<typeof SettingsForm>[0]["listings"] = [
  {
    providerId: "stand-a",
    salesLocationId: "loc-a",
    locationName: "Orchard Stand",
    sellerName: null,
    selected: true,
    cadence: "weekly" as const,
  },
];

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("farmer reminder settings", () => {
  it("keeps seller names with stand setup rather than the daily-update form", () => {
    render(
      <SettingsForm
        token="private-token"
        listings={listings}
        participantNamesByLocation={{ "loc-a": ["Neighbor Farm"] }}
      />,
    );
    expect(screen.getByRole("heading", { name: "Also selling here" })).toBeVisible();
    expect(screen.getByLabelText("Seller names")).toHaveValue("Neighbor Farm");
  });

  it("asks nothing about a default stand when there is only one", () => {
    // F-097 (max, 2026-08-08). A radio group with a single radio is a question with one
    // answer. `STAND` already says "if you have more than one"; this is that rule on the web.
    render(<SettingsForm token="private-token" listings={oneListing} />);

    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    expect(screen.queryByText(/which stand your texts are about/i)).not.toBeInTheDocument();
    // And it does not label the one stand by name, which would be telling the farmer apart
    // from nobody.
    expect(screen.queryByRole("heading", { name: "Orchard Stand" })).not.toBeInTheDocument();
  });

  it("offers the default-stand choice as soon as there are two", () => {
    render(<SettingsForm token="private-token" listings={listings} />);
    expect(screen.getByRole("radio", { name: "Orchard Stand" })).toBeVisible();
    expect(screen.getByRole("radio", { name: "Harbor Stand" })).toBeVisible();
  });

  it("saves the whole panel with ONE button, and never says Submit", async () => {
    // The panel had three save buttons — one per writer — for what a farmer reads as one
    // screen, and one of them said "Submit", which is onboarding's word.
    const fetchMock = vi.fn(async () => Response.json({}));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<SettingsForm token="private-token" listings={oneListing} />);

    expect(screen.queryByRole("button", { name: /submit/i })).not.toBeInTheDocument();
    /*
      ONE SAVE, which is the claim — not one button on the panel. The three this replaced were
      "Save default stand", "Save reminder", and "Save seller names": three writers for what a
      farmer reads as one screen. Asserted as "no second button that SAVES" so it keeps failing
      if one comes back, while the invite button — which mints a link rather than saving a
      setting, and has its own suite below — does not trip it.
    */
    const saveButtons = screen
      .getAllByRole("button")
      .filter((button) => /save/i.test(button.textContent ?? ""));
    expect(saveButtons).toHaveLength(1);
    expect(saveButtons[0]).toHaveAccessibleName("Save settings");

    // Nothing changed yet, so there is nothing to save.
    expect(saveButtons[0]).toBeDisabled();
    await user.type(screen.getByLabelText("Seller names"), "Neighbor Farm");
    expect(screen.getByRole("button", { name: "Save settings" })).toBeEnabled();
  });

  it("writes only what the farmer actually changed", async () => {
    // Sending every writer on every press would file a participant audit event claiming the
    // seller list was edited whenever a farmer touched an unrelated setting.
    const fetchMock = vi.fn(async () => Response.json({ locationName: "Harbor Stand" }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(
      <SettingsForm
        token="private-token"
        listings={listings}
        participantNamesByLocation={{ "loc-a": ["Neighbor Farm"] }}
      />,
    );

    await user.click(screen.getByRole("radio", { name: "Harbor Stand" }));
    await user.click(screen.getByRole("button", { name: "Save settings" }));

    expect(await screen.findByText("Settings saved.")).toBeVisible();
    // The default moved and the seller names did not, so the participant writer stays untouched.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/farmer/settings",
      expect.objectContaining({
        // The LISTING (C.4). Its own id, not the stand's — the two differ in this fixture
        // precisely so a body posting `loc-b` could not pass.
        body: JSON.stringify({
          token: "private-token",
          providerId: "stand-b",
        }),
      }),
    );
  });

  it("saves a seller-name edit through the participant writer, and nothing else", async () => {
    const fetchMock = vi.fn(async () => Response.json({ activeDisplayNames: ["Neighbor Farm"] }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<SettingsForm token="private-token" listings={oneListing} />);

    await user.type(screen.getByLabelText("Seller names"), "Neighbor Farm");
    await user.click(screen.getByRole("button", { name: "Save settings" }));

    expect(await screen.findByText("Settings saved.")).toBeVisible();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/farmer/stand",
      expect.objectContaining({
        body: JSON.stringify({
          token: "private-token",
          action: "save_participants",
          participantNames: ["Neighbor Farm"],
        }),
      }),
    );
  });

  it("loads the newly selected stand's seller names after its default changes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ locationName: "Harbor Stand" })),
    );
    const user = userEvent.setup();
    render(
      <SettingsForm
        token="private-token"
        listings={listings}
        // Keyed by STAND — participants are the stand's own record, and the ids here differ
        // from the listing ids so a lookup through the wrong one yields nothing.
        participantNamesByLocation={{
          "loc-a": ["Neighbor Farm"],
          "loc-b": ["Harbor Apiary"],
        }}
      />,
    );

    await user.click(screen.getByRole("radio", { name: "Harbor Stand" }));
    await user.click(screen.getByRole("button", { name: "Save settings" }));

    expect(await screen.findByLabelText("Seller names")).toHaveValue("Harbor Apiary");
  });

  /*
    F-114 Phase C.1 — THE STAND OWNER'S OWN INVITATION DOOR.

    It sits directly under "Also selling here" because that box is where a farmer already thinks
    about who is on their table — and because the two are the honest halves of one question. A
    NAME on that list is a credit and nothing more; an INVITATION gives that person their own
    phone, their own inventory, and their own listing at this stand. A farmer choosing between
    them is choosing how much the other seller runs themselves.

    **It is NOT a setting, so it does not ride the Save button.** Every other control here writes
    what changed when the farmer presses save; this one mints a link that exists exactly once,
    and folding it into a save would either issue an invitation for an untouched field or lose
    the link behind an unrelated failure. Its own press, its own result — the same shape VIGA's
    "Invite and copy link" has.

    **From her phone, too.** `LINK` and `SETTINGS` both text the farmer this page, so the SMS
    door for this act is the one she already holds. No new keyword: a keyword would need a
    free-text grammar for a name that becomes a public brand, and a way to text a 64-hex link
    back for forwarding.
  */
  describe("inviting another seller to the stand", () => {
    it("mints a link on its OWN press, never through Save settings", async () => {
      const fetchMock = vi.fn(async () =>
        Response.json({
          status: "invited",
          sellerName: "Gracies Greens",
          link: `https://farmfriend.test/farmer/onboarding/${"a".repeat(64)}`,
        }),
      );
      vi.stubGlobal("fetch", fetchMock);
      const user = userEvent.setup();
      render(<SettingsForm token="private-token" listings={oneListing} />);

      await user.type(screen.getByLabelText(/who are you inviting/i), "Gracies Greens");
      // Typing a name is not an unsaved setting: the Save button has nothing to write.
      expect(screen.getByRole("button", { name: "Save settings" })).toBeDisabled();

      await user.click(screen.getByRole("button", { name: /^invite/i }));

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/farmer/stand",
        expect.objectContaining({
          body: JSON.stringify({
            token: "private-token",
            action: "invite_seller",
            newSellerName: "Gracies Greens",
          }),
        }),
      );

      // The link is SHOWN, because the farmer forwards it by hand and it is minted once.
      expect(await screen.findByLabelText(/invitation link/i)).toHaveValue(
        `https://farmfriend.test/farmer/onboarding/${"a".repeat(64)}`,
      );
    });

    it("is never sent by Save settings, with a name typed or without", async () => {
      /*
        The other half of "its own press", and the half a sabotage caught missing: asserting that
        Invite posts once proves nothing about what Save does. A Save that also invited would
        mint a link the farmer never asked for, behind a button whose whole contract is "write
        what changed" — and the link would then be lost inside a save report.

        Both states matter. With a name typed and nothing else changed, Save must be inert; with
        a real setting changed too, Save must write THAT and still not invite.
      */
      const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
        Response.json({ activeDisplayNames: ["Neighbor Farm"] }),
      );
      vi.stubGlobal("fetch", fetchMock);
      const user = userEvent.setup();
      render(<SettingsForm token="private-token" listings={oneListing} />);

      await user.type(screen.getByLabelText(/who are you inviting/i), "Gracies Greens");
      // A typed name is not an unsaved change, so Save is inert and cannot even be pressed.
      expect(screen.getByRole("button", { name: "Save settings" })).toBeDisabled();

      await user.type(screen.getByLabelText("Seller names"), "Neighbor Farm");
      await user.click(screen.getByRole("button", { name: "Save settings" }));
      expect(await screen.findByText("Settings saved.")).toBeVisible();

      // EXACTLY the participant write. An invitation riding along would be a second call.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const body = JSON.parse(
        String(fetchMock.mock.calls[0]?.[1]?.body),
      ) as Record<string, unknown>;
      expect(body.action).toBe("save_participants");
      expect(screen.queryByLabelText(/invitation link/i)).toBeNull();
    });

    it("is not sent by the TAB's save either, which reaches this panel directly", async () => {
      /*
        The path the case above cannot see, and the one a sabotage slipped through.

        Inside "Details & settings" (F-098) this panel renders NO button: the listing form's
        single press runs `registerSave` instead. That call reaches `save` directly, so the
        disabled state that makes the standalone page safe is not in the way — and a `save` that
        invited when it had nothing else to write would mint a link on a press about the
        listing.
      */
      const fetchMock = vi.fn(async () => Response.json({}));
      vi.stubGlobal("fetch", fetchMock);
      const user = userEvent.setup();

      // Stands in for the listing form: the one thing it does here is own the tab's press.
      function ListingFormStandIn() {
        const tab = useTabCommit();
        return (
          <button type="button" onClick={() => void tab?.alsoSave()}>
            Save changes
          </button>
        );
      }
      render(
        <DetailsPanel>
          <ListingFormStandIn />
          <SettingsForm token="private-token" listings={oneListing} />
        </DetailsPanel>,
      );

      await user.type(screen.getByLabelText(/who are you inviting/i), "Gracies Greens");
      // The panel's own Save is gone inside a tab, which is what makes this path reachable.
      expect(screen.queryByRole("button", { name: "Save settings" })).toBeNull();

      await user.click(screen.getByRole("button", { name: "Save changes" }));

      // Nothing changed, so nothing was written — and above all, nobody was invited.
      expect(fetchMock).not.toHaveBeenCalled();
      expect(screen.queryByLabelText(/invitation link/i)).toBeNull();
    });

    it("tells the farmer to send it, and that nothing is public yet", async () => {
      // max, 2026-08-15: the host forwards the link, and nothing is public until the seller
      // finishes. A farmer who thought Farm Friend had texted them would wait for nothing.
      render(<SettingsForm token="private-token" listings={oneListing} />);
      expect(screen.getByText(/send them the link|you send them/i)).toBeVisible();
      expect(screen.getByText(/nobody.*listed until|not.*public until/i)).toBeVisible();
    });

    it("cannot be pressed with no name", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const user = userEvent.setup();
      render(<SettingsForm token="private-token" listings={oneListing} />);

      await user.click(screen.getByRole("button", { name: /^invite/i }));
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("shows the refusal rather than claiming an invitation was sent", async () => {
      // The server's code-owned copy, shown as it came. A name carrying a phone number is
      // refused at the writer, and the farmer is told what to remove.
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          new Response(
            JSON.stringify({
              status: "refused",
              reason: "unsafe_public_text",
              message: "I couldn't publish that. Remove a phone number, then send the update again.",
            }),
            { status: 409, headers: { "content-type": "application/json" } },
          ),
        ),
      );
      const user = userEvent.setup();
      render(<SettingsForm token="private-token" listings={oneListing} />);

      await user.type(
        screen.getByLabelText(/who are you inviting/i),
        "Gracies Greens 206-555-0199",
      );
      await user.click(screen.getByRole("button", { name: /^invite/i }));

      expect(await screen.findByRole("alert")).toHaveTextContent(/remove a phone number/i);
      expect(screen.queryByLabelText(/invitation link/i)).toBeNull();
    });
  });

  it("does not claim success when the write fails", async () => {
    // The lie this prevents: "Settings saved." over a screen where nothing was written.
    //
    // The two writers here are mutually exclusive by design — a default-stand move resets the
    // seller box, so the participant write is skipped — which is why the MULTI-write partial
    // failure is proven in `reminder-schedules.test.tsx`, where several writes really do run.
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 500 })));
    const user = userEvent.setup();
    render(
      <SettingsForm
        token="private-token"
        listings={listings}
        participantNamesByLocation={{ "loc-a": ["Neighbor Farm"] }}
      />,
    );

    await user.type(screen.getByLabelText("Seller names"), "Another Farm");
    await user.click(screen.getByRole("button", { name: "Save settings" }));

    expect(await screen.findByRole("alert")).toBeVisible();
    expect(screen.queryByText("Settings saved.")).not.toBeInTheDocument();
  });
});
