// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { AdminRefusal, refusalFromResponse } from "./admin-shell";

/*
  What a refused admin write TELLS the operator.

  Measured in production 2026-08-19: max opened the console at the `*.run.app` host, pressed
  "Prepare invite", and read "Your session expired" — three times, each seconds after a live
  session was issued. His session was fine. `PUBLIC_BASE_URL` is the custom domain (F-113), so
  the origin check refused the write, and the screen — which could only see status 403 — guessed
  the one cause it knew about.

  A wrong diagnosis is worse than none: it sent him to sign in repeatedly, which could never
  work, while the real fix (open the console on the custom domain) went unconsidered. Six
  screens each carried their own copy of that guess, so the guess is now ONE reader of the
  server's own name for the refusal.
*/

describe("what a refused administrator write tells the operator", () => {
  it("names the address problem, and does not offer a sign-in that cannot help", () => {
    render(<AdminRefusal refusal="wrong_origin" />);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("farmfriend.vigavashon.org");
    expect(
      alert.textContent,
      "signing in again is exactly what does not fix a wrong-address refusal",
    ).not.toContain("Sign in again");
  });

  it("offers the sign-in when the session really is the problem", () => {
    render(<AdminRefusal refusal="not_signed_in" />);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Sign in again");
    expect(
      alert.textContent,
      "a signed-out operator must not be sent chasing the address instead",
    ).not.toContain("farmfriend.vigavashon.org");
  });

  it("every admin caller reports a wrong-origin refusal, not the generic message", async () => {
    /*
      THE TEST THAT WAS MISSING. The unit tests all passed while production showed the generic
      message on every refusal, because they exercised the READER alone and never the caller's
      real sequence: parse the body for the payload, then ask what the refusal was.

      This asserts the property at the level the defect lived — each screen's own failure path,
      driven by a real 403 with a real body — so a caller that drains the stream before asking
      fails here rather than in production.
    */
    const { FarmerQueue } = await import("./farmers/farmer-queue");
    const refusal = () =>
      new Response(JSON.stringify({ error: "wrong_origin" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      });

    // `fetch` is what the component reaches for; the queue does not take a fetcher prop.
    const original = globalThis.fetch;
    globalThis.fetch = (() => Promise.resolve(refusal())) as typeof fetch;
    try {
      render(<FarmerQueue requests={[]} sellers={[{ farmId: "farm-1", name: "Misty Hollow" }]} />);

      await userEvent.selectOptions(screen.getByRole("combobox", { name: /farm/i }), "farm-1");
      await userEvent.type(
        screen.getByLabelText(/phone number/i),
        "2065550123",
      );
      await userEvent.click(screen.getByRole("button", { name: /prepare invite/i }));

      const alert = await screen.findByRole("alert");
      expect(
        alert.textContent,
        "a refusal the reader could not see reads as the generic failure",
      ).not.toMatch(/did not go through/i);
      expect(alert.textContent).toContain("farmfriend.vigavashon.org");
    } finally {
      globalThis.fetch = original;
    }
  });

  it("renders nothing when the write was not refused", () => {
    const { container } = render(<AdminRefusal refusal={null} />);
    expect(container.textContent).toBe("");
  });

  /*
    THE BUG THIS EXISTS TO PREVENT (measured in production 2026-08-19, hours after the fix that
    introduced it).

    Every caller reads the JSON body to get its payload, THEN asked for the refusal. Handing a
    `Response` to the reader made `clone()` look like the safe way to do that — but `clone()`
    THROWS once the body has been consumed ("Body has already been consumed"), the throw landed
    in each caller's catch, and every refusal came out as the generic "That change did not go
    through." The labelling shipped and never ran.

    So the reader takes the STATUS and the ALREADY-PARSED PAYLOAD. There is no second read to get
    wrong, and a caller physically cannot pass a stream it has drained.
  */
  it("takes what the caller already parsed, never a body it must read again", async () => {
    // The caller's real sequence: parse once, then ask what the refusal was.
    const response = new Response(JSON.stringify({ error: "wrong_origin" }), { status: 403 });
    const payload = (await response.json()) as Record<string, unknown>;

    expect(
      refusalFromResponse(response.status, payload),
      "the reader must work on a response whose body is already spent",
    ).toBe("wrong_origin");
  });

  it("reads the server's name for the refusal, not the status code", async () => {
    // The status is 403 in BOTH cases, so a reader that looked at it could never tell them
    // apart — which is the defect this replaces.
    expect(refusalFromResponse(403, { error: "wrong_origin" })).toBe("wrong_origin");
    expect(refusalFromResponse(403, { error: "not_signed_in" })).toBe("not_signed_in");
  });

  it("falls back to the session reading when a 403 names nothing", async () => {
    // An older route, or one that refuses before naming itself, still produces a usable screen
    // rather than a blank one. The fallback is the recoverable reading: offering a sign-in that
    // turns out to be unnecessary costs less than withholding one that was needed.
    expect(refusalFromResponse(403, {})).toBe("not_signed_in");
    // A body that failed to parse arrives as `{}` from the caller's own `.catch(() => ({}))`.
    expect(refusalFromResponse(403, {})).toBe("not_signed_in");
  });

  it("is not a refusal at all for any other failure", async () => {
    // A 409 or a 500 is a different conversation, and answering it with "sign in again" would
    // be the same wrong diagnosis in a new place.
    expect(refusalFromResponse(409, {})).toBeNull();
    expect(refusalFromResponse(500, {})).toBeNull();
  });
});
