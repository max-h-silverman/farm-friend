// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
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

  it("renders nothing when the write was not refused", () => {
    const { container } = render(<AdminRefusal refusal={null} />);
    expect(container.textContent).toBe("");
  });

  it("reads the server's name for the refusal, not the status code", async () => {
    // The status is 403 in BOTH cases, so a reader that looked at it could never tell them
    // apart — which is the defect this replaces.
    expect(
      await refusalFromResponse(
        new Response(JSON.stringify({ error: "wrong_origin" }), { status: 403 }),
      ),
    ).toBe("wrong_origin");
    expect(
      await refusalFromResponse(
        new Response(JSON.stringify({ error: "not_signed_in" }), { status: 403 }),
      ),
    ).toBe("not_signed_in");
  });

  it("falls back to the session reading when a 403 names nothing", async () => {
    // An older route, or one that refuses before naming itself, still produces a usable screen
    // rather than a blank one. The fallback is the recoverable reading: offering a sign-in that
    // turns out to be unnecessary costs less than withholding one that was needed.
    expect(await refusalFromResponse(new Response("{}", { status: 403 }))).toBe("not_signed_in");
    expect(await refusalFromResponse(new Response("not json", { status: 403 }))).toBe(
      "not_signed_in",
    );
  });

  it("is not a refusal at all for any other failure", async () => {
    // A 409 or a 500 is a different conversation, and answering it with "sign in again" would
    // be the same wrong diagnosis in a new place.
    expect(await refusalFromResponse(new Response("{}", { status: 409 }))).toBeNull();
    expect(await refusalFromResponse(new Response("{}", { status: 500 }))).toBeNull();
  });
});
