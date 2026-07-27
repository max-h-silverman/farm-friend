import { describe, expect, it, beforeEach } from "vitest";
import { FixedClock, createPublicActionThrottle, type MailMessage } from "@farm-friend/core";
import { handleRequestLinkRequest, type RequestLinkDeps } from "./request-link";

// F-032 — the public, unauthenticated "send me a sign-in link" endpoint.
//
// Two claims carry this file, and both are stated as tests that compare WHOLE artifacts
// rather than shapes, because a shape check is what let a comparable claim pass unproven
// during F-030:
//
//   (a) A non-administrator address gets a BYTE-IDENTICAL response to an administrator's.
//       This route is public, so any observable difference — status, headers, body, error
//       code — enumerates who VIGA's operators are.
//   (b) A sign-in token never appears in a response body or a log line. It goes to exactly
//       one place, the rendered message handed to the mail seam.

/** A mail seam that records what it was asked to send. */
function recordingMail() {
  const sent: MailMessage[] = [];
  return {
    sent,
    sender: { send: (m: MailMessage) => { sent.push(m); return Promise.resolve(); } },
  };
}

/** Captures everything written to the console during a call. */
async function captureLogs(run: () => Promise<Response>): Promise<{
  response: Response;
  logged: string;
}> {
  const lines: string[] = [];
  const methods = ["log", "info", "warn", "error", "debug"] as const;
  const originals = methods.map((m) => console[m]);
  for (const m of methods) {
    console[m] = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  }
  try {
    const response = await run();
    return { response, logged: lines.join("\n") };
  } finally {
    methods.forEach((m, i) => { console[m] = originals[i]!; });
  }
}

describe("request-link handler", () => {
  const administrators = new Set(["operator@viga.example"]);
  let mail: ReturnType<typeof recordingMail>;
  let clock: FixedClock;

  /** Deps with a generous throttle; the throttle tests override the limit. */
  function deps(overrides: Partial<RequestLinkDeps> = {}): RequestLinkDeps {
    return {
      clock,
      mail: mail.sender,
      throttle: createPublicActionThrottle({ clock, limit: 100, windowMs: 60_000 }),
      magicLinkSecret: "test-secret",
      signalSalt: "test-salt",
      baseUrl: "https://ff.example",
      isAdministrator: (email: string) => Promise.resolve(administrators.has(email)),
      ...overrides,
    };
  }

  const post = (body: unknown, headers: Record<string, string> = {}) =>
    new Request("https://ff.example/api/auth/request-link", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });

  /** Serialize a response completely: status, headers, and body. */
  async function serialize(response: Response): Promise<string> {
    const headers = [...response.headers.entries()]
      .filter(([k]) => k !== "date")
      .sort()
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n");
    return `${response.status} ${response.statusText}\n${headers}\n\n${await response.text()}`;
  }

  beforeEach(() => {
    clock = new FixedClock(new Date("2026-07-26T12:00:00Z"));
    mail = recordingMail();
  });

  describe("enumeration safety", () => {
    it("answers a non-administrator byte-identically to an administrator", async () => {
      const asAdmin = await handleRequestLinkRequest(
        post({ email: "operator@viga.example" }),
        deps(),
      );
      const asStranger = await handleRequestLinkRequest(
        post({ email: "stranger@example.com" }),
        deps(),
      );

      // Whole responses, not shapes: status line, every header, and the exact body.
      expect(await serialize(asStranger)).toBe(await serialize(asAdmin));
    });

    it("sends nothing and creates nothing for a non-administrator", async () => {
      await handleRequestLinkRequest(post({ email: "stranger@example.com" }), deps());
      expect(mail.sent).toEqual([]);
    });

    it("sends exactly one message for an administrator", async () => {
      await handleRequestLinkRequest(post({ email: "operator@viga.example" }), deps());
      expect(mail.sent).toHaveLength(1);
      expect(mail.sent[0]?.to).toBe("operator@viga.example");
    });

    it("treats an unknown address case-insensitively, matching the stored identity", async () => {
      // `administrators.email` is stored lowercased; an operator typing their address with
      // capitals must not be silently treated as a stranger and get no mail.
      await handleRequestLinkRequest(post({ email: "Operator@VIGA.example" }), deps());
      expect(mail.sent).toHaveLength(1);
    });

    it("answers a malformed address identically too", async () => {
      // A distinct validation error would separate "not an address" from "not an operator",
      // which is a coarser but still real enumeration oracle.
      const asAdmin = await handleRequestLinkRequest(
        post({ email: "operator@viga.example" }),
        deps(),
      );
      const asGarbage = await handleRequestLinkRequest(post({ email: "not-an-email" }), deps());
      expect(await serialize(asGarbage)).toBe(await serialize(asAdmin));
      expect(mail.sent).toHaveLength(1); // only the administrator's
    });
  });

  describe("the token never escapes the message", () => {
    it("does not appear in the response body", async () => {
      const response = await handleRequestLinkRequest(
        post({ email: "operator@viga.example" }),
        deps(),
      );
      const body = await response.text();
      const token = mail.sent[0]?.text.match(/token=([^\s&]+)/)?.[1];
      expect(token).toBeTruthy();
      expect(body).not.toContain(token as string);
      // Nor any base64url-ish run that could be one.
      expect(body).not.toMatch(/[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/);
    });

    it("does not appear in any log line", async () => {
      const { logged } = await captureLogs(() =>
        handleRequestLinkRequest(post({ email: "operator@viga.example" }), deps()),
      );
      const token = mail.sent[0]?.text.match(/token=([^\s&]+)/)?.[1];
      expect(token).toBeTruthy();
      expect(logged).not.toContain(token as string);
    });

    it("does not log the requested address, administrator or not", async () => {
      const { logged } = await captureLogs(async () => {
        await handleRequestLinkRequest(post({ email: "operator@viga.example" }), deps());
        return handleRequestLinkRequest(post({ email: "stranger@example.com" }), deps());
      });
      expect(logged).not.toContain("operator@viga.example");
      expect(logged).not.toContain("stranger@example.com");
    });

    it("still answers identically when the mail seam throws", async () => {
      // The unconfigured sender throws by design. That must not become an oracle: a
      // deployment with no provider would otherwise answer 500 for operators and 202 for
      // everyone else, which enumerates them precisely.
      const failing = deps({
        mail: { send: () => Promise.reject(new Error("no mail provider is configured")) },
      });
      const asAdmin = await handleRequestLinkRequest(
        post({ email: "operator@viga.example" }),
        failing,
      );
      const asStranger = await handleRequestLinkRequest(
        post({ email: "stranger@example.com" }),
        failing,
      );
      expect(await serialize(asStranger)).toBe(await serialize(asAdmin));
    });

    it("does not leak the token when the mail seam throws with the body attached", async () => {
      // A real vendor SDK commonly puts the request payload on the error it throws.
      const failing = deps({
        mail: {
          send: (m: MailMessage) =>
            Promise.reject(new Error(`vendor rejected payload: ${m.text}`)),
        },
      });
      const { response, logged } = await captureLogs(() =>
        handleRequestLinkRequest(post({ email: "operator@viga.example" }), failing),
      );
      expect(logged).not.toMatch(/token=/);
      expect(await response.text()).not.toMatch(/token=/);
    });
  });

  describe("rate limiting", () => {
    it("refuses once the limit is exhausted", async () => {
      const shared = deps({
        throttle: createPublicActionThrottle({ clock, limit: 2, windowMs: 60_000 }),
      });
      const from = { "x-forwarded-for": "203.0.113.7" };

      expect((await handleRequestLinkRequest(post({ email: "a@b.example" }, from), shared)).status).toBe(202);
      expect((await handleRequestLinkRequest(post({ email: "a@b.example" }, from), shared)).status).toBe(202);
      const third = await handleRequestLinkRequest(post({ email: "a@b.example" }, from), shared);
      expect(third.status).toBe(429);
      expect(third.headers.get("retry-after")).toBeTruthy();
    });

    it("counts an administrator's request against the budget too", async () => {
      // Otherwise the throttle itself is the oracle: an address that never exhausts the
      // budget is an address that never sent mail, i.e. not an operator's.
      const shared = deps({
        throttle: createPublicActionThrottle({ clock, limit: 1, windowMs: 60_000 }),
      });
      const from = { "x-forwarded-for": "203.0.113.9" };
      await handleRequestLinkRequest(post({ email: "operator@viga.example" }, from), shared);
      const second = await handleRequestLinkRequest(post({ email: "operator@viga.example" }, from), shared);
      expect(second.status).toBe(429);
    });

    it("buckets separate clients separately", async () => {
      const shared = deps({
        throttle: createPublicActionThrottle({ clock, limit: 1, windowMs: 60_000 }),
      });
      await handleRequestLinkRequest(
        post({ email: "a@b.example" }, { "x-forwarded-for": "203.0.113.1" }),
        shared,
      );
      const other = await handleRequestLinkRequest(
        post({ email: "a@b.example" }, { "x-forwarded-for": "203.0.113.2" }),
        shared,
      );
      expect(other.status).toBe(202);
    });

    it("throttles before looking up whether the address is an administrator", async () => {
      // A refused request must not perform the lookup: doing so would make the database the
      // thing an attacker times, and would let a throttled attacker still probe.
      let lookups = 0;
      const shared = deps({
        throttle: createPublicActionThrottle({ clock, limit: 1, windowMs: 60_000 }),
        isAdministrator: (email: string) => {
          lookups += 1;
          return Promise.resolve(administrators.has(email));
        },
      });
      const from = { "x-forwarded-for": "203.0.113.11" };
      await handleRequestLinkRequest(post({ email: "operator@viga.example" }, from), shared);
      await handleRequestLinkRequest(post({ email: "operator@viga.example" }, from), shared);
      expect(lookups).toBe(1);
    });
  });

  describe("works without JavaScript", () => {
    // `/admin/login` is the recovery path for the whole admin surface, so it must not be the
    // one screen that breaks when a script fails to load. A native form post sends
    // `application/x-www-form-urlencoded`, NOT JSON — a handler that only parsed JSON would
    // answer 400 to every no-JS submission while the enhanced path worked fine.
    const form = (email: string, headers: Record<string, string> = {}) =>
      new Request("https://ff.example/api/auth/request-link", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
        body: new URLSearchParams({ email }).toString(),
      });

    it("accepts a form-encoded submission", async () => {
      const response = await handleRequestLinkRequest(form("operator@viga.example"), deps());
      expect(response.status).toBe(202);
      expect(mail.sent).toHaveLength(1);
    });

    it("answers a form-encoded non-administrator identically", async () => {
      const asAdmin = await handleRequestLinkRequest(form("operator@viga.example"), deps());
      const asStranger = await handleRequestLinkRequest(form("stranger@example.com"), deps());
      expect(await serialize(asStranger)).toBe(await serialize(asAdmin));
    });

    it("sends nothing for a form-encoded non-administrator", async () => {
      await handleRequestLinkRequest(form("stranger@example.com"), deps());
      expect(mail.sent).toEqual([]);
    });
  });

  describe("input handling", () => {
    it("rejects a malformed JSON body without consuming budget", async () => {
      const shared = deps({
        throttle: createPublicActionThrottle({ clock, limit: 1, windowMs: 60_000 }),
      });
      const from = { "x-forwarded-for": "203.0.113.21" };
      const bad = await handleRequestLinkRequest(post("{not json", from), shared);
      expect(bad.status).toBe(400);
      // The budget is intact, so a typo does not lock a real operator out.
      expect((await handleRequestLinkRequest(post({ email: "a@b.example" }, from), shared)).status).toBe(202);
    });

    it("refuses an absurdly long address before doing any work", async () => {
      const response = await handleRequestLinkRequest(
        post({ email: `${"a".repeat(5_000)}@example.com` }),
        deps(),
      );
      expect(response.status).toBe(400);
      expect(mail.sent).toEqual([]);
    });

    it("builds the link against the configured base URL, never a request header", async () => {
      // Otherwise `Host: evil.example` turns the endpoint into a way to have Farm Friend mail
      // an operator a link pointing at an attacker's origin.
      await handleRequestLinkRequest(
        post({ email: "operator@viga.example" }, { host: "evil.example" }),
        deps(),
      );
      expect(mail.sent[0]?.text).toContain("https://ff.example/api/auth/callback?token=");
      expect(mail.sent[0]?.text).not.toContain("evil.example");
    });
  });
});
