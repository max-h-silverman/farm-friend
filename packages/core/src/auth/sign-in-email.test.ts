import { describe, expect, it } from "vitest";
import { renderSignInEmail, SIGN_IN_LINK_TTL_MS } from "./sign-in-email";

// F-032 — the sign-in email is CODE-RENDERED.
//
// No model is reachable from this path and no caller supplies prose. The tests below are the
// spec for that: the body is a pure function of a link, and nothing a requester types can
// reach it (there is no parameter through which they could).

describe("renderSignInEmail", () => {
  const link = "https://ff.example/api/auth/callback?token=abc.def";

  it("renders a subject and body containing the link", () => {
    const email = renderSignInEmail({ link, ttlMs: SIGN_IN_LINK_TTL_MS });
    expect(email.subject).toBeTruthy();
    expect(email.text).toContain(link);
  });

  it("states the expiry in minutes so a stale link is explicable", () => {
    const email = renderSignInEmail({ link, ttlMs: 15 * 60_000 });
    expect(email.text).toContain("15 minutes");
  });

  it("is a pure function of its input — same input, byte-identical output", () => {
    const a = renderSignInEmail({ link, ttlMs: SIGN_IN_LINK_TTL_MS });
    const b = renderSignInEmail({ link, ttlMs: SIGN_IN_LINK_TTL_MS });
    expect(a).toEqual(b);
  });

  it("tells a recipient who did not request it that they can ignore it", () => {
    // An address that is an administrator's but whose owner did not ask must not be alarmed
    // into thinking someone signed in as them; nothing happened until the link is opened.
    const email = renderSignInEmail({ link, ttlMs: SIGN_IN_LINK_TTL_MS });
    expect(email.text.toLowerCase()).toContain("ignore");
  });

  it("carries no marketing, tracking pixel, or link other than the sign-in link", () => {
    const email = renderSignInEmail({ link, ttlMs: SIGN_IN_LINK_TTL_MS });
    // Every URL in the body must be the sign-in link itself. A second URL here would be a
    // tracker or an unsubscribe footer, and this is a transactional credential, not mail.
    const urls = email.text.match(/https?:\/\/\S+/g) ?? [];
    expect(urls).toEqual([link]);
  });

  it("defaults the link lifetime to fifteen minutes", () => {
    // Decided 2026-07-26 (F-032). A bearer credential in a mailbox should go stale fast; the
    // durable session it mints carries its own, longer TTL.
    expect(SIGN_IN_LINK_TTL_MS).toBe(15 * 60_000);
  });
});
