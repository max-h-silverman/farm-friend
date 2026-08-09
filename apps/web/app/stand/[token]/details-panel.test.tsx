// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { useEffect } from "react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NO_AVAILABILITY_STATED } from "@farm-friend/db";
import { ListingStep } from "../../farmer/onboarding/[token]/listing-step";
import { DetailsPanel, useTabCommit } from "./details-panel";
import { ReminderSchedules } from "./reminder-schedules";

/*
  F-098 — the returning farmer's "Details & settings" tab has ONE commit action.

  max, 2026-08-09, reading the live page: three buttons committed changes on one tab —
  "Save" (the listing), "Submit" (the onboarding wizard's, reached because the editing door
  sets `steps = null` and the Submit was never gated on credential kind), and
  "Save settings". F-097 unified the buttons INSIDE the settings panel and did not touch how
  the panels compose, so the wizard's Submit survived beside the panel that replaced it.

  What is asserted here is the SHAPE of the tab — how many things commit, and what the one
  that does is called. The fields inside each panel keep their own suites.
*/

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

const LISTING_DEFAULTS = {
  standName: "Demo Orchard Stand",
  visitability: "visitable" as const,
  publicAddress: "1 Vashon Hwy",
  addressPublic: true,
  pricesPublic: true,
  latitude: 47.4,
  longitude: -122.4,
  hoursText: "Daily 9-5",
  availability: NO_AVAILABILITY_STATED,
  paymentMethods: [] as string[],
  items: [],
  description: "",
};

describe("the editing door commits once (F-098)", () => {
  it("offers no Submit — that is onboarding's word for handing a form in", () => {
    // The bug this pins: `steps === null` is TRUE for a stand link, which is what made the
    // wizard's Submit render on the editing door. Gating on the credential is what fixes it,
    // so a regression here means the gate was removed rather than the copy reworded.
    render(
      <ListingStep
        credential={{ kind: "stand_link", token: "t" }}
        farmName="Demo Orchard"
        defaults={LISTING_DEFAULTS}
      />,
    );

    expect(screen.queryByRole("button", { name: /submit/i })).toBeNull();
  });

  it("names its one commit button for saving changes", () => {
    render(
      <ListingStep
        credential={{ kind: "stand_link", token: "t" }}
        farmName="Demo Orchard"
        defaults={LISTING_DEFAULTS}
      />,
    );

    // Exactly one control commits the tab. `getAllByRole` rather than `getByRole` so the
    // assertion reports the COUNT when it fails — a second Save is the failure being guarded.
    const commits = screen
      .getAllByRole("button")
      .filter((button) => /^save/i.test(button.textContent ?? ""));

    expect(commits).toHaveLength(1);
    expect(commits[0]).toHaveTextContent(/save changes/i);
  });
});

describe("reminder schedules live with the stock errand (F-098)", () => {
  const LOCATIONS = [
    {
      salesLocationId: "loc-1",
      locationName: "Demo Orchard Stand",
      selected: true,
      cadence: "weekly" as const,
    },
  ];

  it("asks how often we text on the tab where the farmer answers those texts", () => {
    // max's call (2026-08-09): "how often do we ask you" belongs under the inventory widget,
    // beside the errand it schedules — not filed under settings on the other tab.
    render(<ReminderSchedules token="t" locations={LOCATIONS} />);

    expect(screen.getByRole("heading", { name: /inventory reminders/i })).toBeVisible();
    expect(screen.getByLabelText(/reminder schedule/i)).toHaveValue("weekly");
  });

  it("names each stand only when there is more than one to tell apart", () => {
    render(
      <ReminderSchedules
        token="t"
        locations={[
          ...LOCATIONS,
          {
            salesLocationId: "loc-2",
            locationName: "The Red Shed",
            selected: false,
            cadence: "paused" as const,
          },
        ]}
      />,
    );

    expect(screen.getByRole("heading", { name: "The Red Shed" })).toBeVisible();
  });
});

/*
  The cadence guarantees, moved here with the control they describe (F-098).

  These were `settings-form.test.tsx`'s while the schedule lived in that panel. They assert
  behavior, not placement, so they move rather than being restated — the settings suite keeps
  only what it still owns.
*/
describe("saving a reminder schedule (F-098)", () => {
  const TWO = [
    { salesLocationId: "stand-a", locationName: "Orchard Stand", selected: true, cadence: null },
    {
      salesLocationId: "stand-b",
      locationName: "Harbor Stand",
      selected: false,
      cadence: "paused" as const,
    },
  ];

  it("shows unscheduled and paused stands as explicit per-stand states", () => {
    render(<ReminderSchedules token="t" locations={TWO} />);

    expect(screen.getAllByLabelText("Reminder schedule")).toHaveLength(2);
    expect(screen.getByLabelText("Reminder schedule", { selector: "#cadence-stand-a" }))
      .toHaveValue("");
    expect(screen.getByLabelText("Reminder schedule", { selector: "#cadence-stand-b" }))
      .toHaveValue("paused");
    expect(screen.getByText(/Pausing reminders does not stop your other texts/)).toBeVisible();
  });

  it("writes only the stand whose schedule changed", async () => {
    const fetchMock = vi.fn(async () => Response.json({}));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<ReminderSchedules token="private-token" locations={TWO} />);

    await user.selectOptions(
      screen.getByLabelText("Reminder schedule", { selector: "#cadence-stand-a" }),
      "every_2_days",
    );
    await user.click(screen.getByRole("button", { name: "Save reminder schedule" }));

    expect(await screen.findByText("Reminder schedule saved.")).toBeVisible();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/farmer/settings",
      expect.objectContaining({
        body: JSON.stringify({
          token: "private-token",
          salesLocationId: "stand-a",
          cadence: "every_2_days",
        }),
      }),
    );
  });

  it("explains a revoked link without claiming the schedule changed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 403 })));
    const user = userEvent.setup();
    render(<ReminderSchedules token="t" locations={TWO} />);

    await user.selectOptions(
      screen.getByLabelText("Reminder schedule", { selector: "#cadence-stand-a" }),
      "every_2_days",
    );
    await user.click(screen.getByRole("button", { name: "Save reminder schedule" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This link is no longer active. Your reminder schedule is unchanged.",
    );
    expect(screen.getByRole("link", { name: "How to get a new link" })).toBeVisible();
  });

  it("shows a recoverable error without claiming the schedule changed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    const user = userEvent.setup();
    render(<ReminderSchedules token="t" locations={TWO} />);

    await user.selectOptions(
      screen.getByLabelText("Reminder schedule", { selector: "#cadence-stand-a" }),
      "every_2_weeks",
    );
    await user.click(screen.getByRole("button", { name: "Save reminder schedule" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "That did not go through. Your reminder schedule is unchanged — try again.",
    );
  });

  it("does not report success when one of several writes fails", async () => {
    // The lie this prevents: "Reminder schedule saved." over a screen where the first stand
    // took and the second did not. A partial save must read as a failure.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({}))
      .mockResolvedValueOnce(new Response("{}", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<ReminderSchedules token="t" locations={TWO} />);

    await user.selectOptions(
      screen.getByLabelText("Reminder schedule", { selector: "#cadence-stand-a" }),
      "every_2_days",
    );
    await user.selectOptions(
      screen.getByLabelText("Reminder schedule", { selector: "#cadence-stand-b" }),
      "weekly",
    );
    await user.click(screen.getByRole("button", { name: "Save reminder schedule" }));

    expect(await screen.findByRole("alert")).toBeVisible();
    expect(screen.queryByText("Reminder schedule saved.")).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

/*
  THE TAB COMMITS ONCE — the whole point of F-098, asserted across BOTH panels.

  The suite above proves the listing form alone offers one button. That was not enough: the
  live tab still showed "Save changes" AND "Save settings", because the shape was asserted
  inside one component while the TAB stacked two. This asserts the composition.
*/
describe("the details tab commits both panels with one press (F-098)", () => {
  /** Stands in for the listing form: owns the button, runs the companion save after its own. */
  function ListingStub({ ok = true, calls }: { ok?: boolean; calls: string[] }) {
    const tab = useTabCommit();
    return (
      <button
        type="button"
        onClick={() => {
          void (async () => {
            calls.push("listing");
            if (!ok) return;
            const saved = (await tab?.alsoSave()) ?? true;
            calls.push(saved ? "settings:ok" : "settings:failed");
          })();
        }}
      >
        Save changes
      </button>
    );
  }

  /** Stands in for the settings panel: registers on mount, exactly as the real one does. */
  function SettingsStub({ ok, calls }: { ok: boolean; calls: string[] }) {
    const tab = useTabCommit();
    useEffect(() => {
      tab?.registerSave(async () => {
        calls.push("settings:ran");
        return ok;
      });
    }, [tab, ok, calls]);
    return <p>settings panel</p>;
  }

  it("shows exactly one button that commits the tab", () => {
    const calls: string[] = [];
    render(
      <DetailsPanel>
        <ListingStub calls={calls} />
        <SettingsStub ok calls={calls} />
      </DetailsPanel>,
    );

    const commits = screen
      .getAllByRole("button")
      .filter((button) => /save/i.test(button.textContent ?? ""));

    expect(commits).toHaveLength(1);
    expect(commits[0]).toHaveTextContent("Save changes");
  });

  it("runs the settings panel's save on that one press", async () => {
    const user = userEvent.setup();
    const calls: string[] = [];
    render(
      <DetailsPanel>
        <ListingStub calls={calls} />
        <SettingsStub ok calls={calls} />
      </DetailsPanel>,
    );

    await user.click(screen.getByRole("button", { name: "Save changes" }));

    // The listing writes FIRST — the companion save must not run against a listing that
    // failed, which is what would report settings saved over an unsaved stand.
    expect(calls).toEqual(["listing", "settings:ran", "settings:ok"]);
  });

  it("reports the companion failure rather than swallowing it", async () => {
    const user = userEvent.setup();
    const calls: string[] = [];
    render(
      <DetailsPanel>
        <ListingStub calls={calls} />
        <SettingsStub ok={false} calls={calls} />
      </DetailsPanel>,
    );

    await user.click(screen.getByRole("button", { name: "Save changes" }));

    // A false must reach the caller: "saved" over a screen where the seller names did not
    // take is the partial-save lie this codebase refuses.
    expect(calls).toEqual(["listing", "settings:ran", "settings:failed"]);
  });

  it("treats an absent settings panel as nothing to save, not as a failure", async () => {
    // A farm whose settings did not load must not have its listing edit blocked.
    const user = userEvent.setup();
    const calls: string[] = [];
    render(
      <DetailsPanel>
        <ListingStub calls={calls} />
      </DetailsPanel>,
    );

    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(calls).toEqual(["listing", "settings:ok"]);
  });
});
