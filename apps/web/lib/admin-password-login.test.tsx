// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FixedClock } from "@farm-friend/core";
import { LoginForm } from "../app/admin/login/login-form";
import {
  FIXED_ADMIN_EMAIL,
  handleAdminPasswordLogin,
  type AdminPasswordLoginDeps,
} from "./admin-password-login";

const NOW = new Date("2026-08-02T12:00:00.000Z");
const WINDOW_END = new Date("2026-08-02T12:15:00.000Z");

afterEach(() => cleanup());

function request(body: unknown, contentType = "application/json"): Request {
  return new Request("https://ff.example/api/auth/login", {
    method: "POST",
    headers: {
      "content-type": contentType,
      "x-forwarded-for": "198.51.100.42, 35.191.0.1",
    },
    body:
      contentType === "application/json"
        ? JSON.stringify(body)
        : new URLSearchParams(body as Record<string, string>),
  });
}

function dependencies(overrides: Partial<AdminPasswordLoginDeps> = {}) {
  const calls = {
    reserved: [] as string[],
    cleared: [] as string[],
    sessions: [] as Array<{ tokenHash: string; administratorId: string; issuedAt: Date }>,
  };
  const deps: AdminPasswordLoginDeps = {
    clock: new FixedClock(NOW),
    signalSalt: "signal-salt",
    passwordHash: "$argon2id$v=19$m=65536,t=3,p=1$stored-salt$stored-hash",
    verifyPassword: async (_hash, password) => password === "correct horse battery staple",
    reserveAttempt: async ({ accountBucketHash, clientBucketHash }) => {
      calls.reserved.push(accountBucketHash, clientBucketHash);
      return { allowed: true, windowExpiresAt: WINDOW_END };
    },
    clearFailures: async ({ accountBucketHash, clientBucketHash }) => {
      calls.cleared.push(accountBucketHash, clientBucketHash);
    },
    findAdministrator: async () => ({ administratorId: "admin-1" }),
    createSession: async (input) => {
      calls.sessions.push(input);
      return { status: "created" };
    },
    issueSessionToken: () => "a".repeat(64),
    ...overrides,
  };
  return { deps, calls };
}

async function responseBytes(response: Response) {
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    location: response.headers.get("location"),
    cookie: response.headers.get("set-cookie"),
    body: await response.text(),
  };
}

describe("fixed-account administrator password login", () => {
  it("accepts only the fixed normalized email and configured password", async () => {
    const { deps, calls } = dependencies();
    const response = await handleAdminPasswordLogin(
      request({
        email: "  BOARD@VIGAVASHON.ORG ",
        password: "correct horse battery staple",
      }),
      deps,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ authenticated: true });
    expect(response.headers.get("set-cookie")).toMatch(
      /^ff_admin_session=[a-f0-9]{64}; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=43200$/,
    );
    expect(calls.sessions).toEqual([
      {
        tokenHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        administratorId: "admin-1",
        issuedAt: NOW,
      },
    ]);
    expect(calls.cleared).toHaveLength(2);
  });

  it("returns one byte-identical refusal for every public failure", async () => {
    const cases: Array<[string, Request, Partial<AdminPasswordLoginDeps>]> = [
      ["wrong email", request({ email: "other@example.org", password: "correct horse battery staple" }), {}],
      ["wrong password", request({ email: FIXED_ADMIN_EMAIL, password: "wrong" }), {}],
      ["missing field", request({ email: FIXED_ADMIN_EMAIL }), {}],
      ["malformed body", request("not-json", "text/plain"), {}],
      ["throttled", request({ email: FIXED_ADMIN_EMAIL, password: "correct horse battery staple" }), {
        reserveAttempt: async () => ({ allowed: false }),
      }],
      ["revoked authority", request({ email: FIXED_ADMIN_EMAIL, password: "correct horse battery staple" }), {
        findAdministrator: async () => null,
      }],
      ["malformed verifier", request({ email: FIXED_ADMIN_EMAIL, password: "correct horse battery staple" }), {
        verifyPassword: async () => { throw new Error("unsupported verifier"); },
      }],
    ];

    const observed = [];
    for (const [, req, override] of cases) {
      const { deps } = dependencies(override);
      observed.push(await responseBytes(await handleAdminPasswordLogin(req, deps)));
    }
    for (const result of observed) expect(result).toEqual(observed[0]);
    expect(observed[0]).toEqual({
      status: 401,
      contentType: "application/json",
      location: null,
      cookie: null,
      body: '{"authenticated":false}',
    });
  });

  it("reserves the durable bucket before verifying and releases only its own success", async () => {
    const order: string[] = [];
    const { deps } = dependencies({
      reserveAttempt: async () => {
        order.push("reserve");
        return { allowed: true, windowExpiresAt: WINDOW_END };
      },
      verifyPassword: async () => {
        order.push("verify");
        return true;
      },
      findAdministrator: async () => {
        order.push("authority");
        return { administratorId: "admin-1" };
      },
      createSession: async () => {
        order.push("session");
        return { status: "created" };
      },
      clearFailures: async () => {
        order.push("clear");
      },
    });
    await handleAdminPasswordLogin(
      request({ email: FIXED_ADMIN_EMAIL, password: "correct horse battery staple" }),
      deps,
    );
    expect(order).toEqual(["reserve", "verify", "authority", "session", "clear"]);
  });

  it("runs the verifier and authority read for a syntactically valid wrong email", async () => {
    const order: string[] = [];
    const { deps } = dependencies({
      verifyPassword: async () => {
        order.push("verify");
        return true;
      },
      findAdministrator: async () => {
        order.push("authority");
        return { administratorId: "admin-1" };
      },
    });
    const response = await handleAdminPasswordLogin(
      request({ email: "other@example.org", password: "correct horse battery staple" }),
      deps,
    );
    expect(response.status).toBe(401);
    expect(order).toEqual(["verify", "authority"]);
  });
});

describe("administrator login screen", () => {
  it("minimizes typing and exposes password-manager and accessible states", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ authenticated: false }, { status: 401 }),
    );
    render(<LoginForm />);

    const email = screen.getByLabelText("Email address") as HTMLInputElement;
    expect(email.value).toBe(FIXED_ADMIN_EMAIL);
    expect(email.readOnly).toBe(true);
    expect(email.autocomplete).toBe("username");

    const password = screen.getByLabelText("Password") as HTMLInputElement;
    expect(password.type).toBe("password");
    expect(password.autocomplete).toBe("current-password");
    expect(screen.getByRole("button", { name: "Sign in" })).toBeEnabled();

    fireEvent.change(password, { target: { value: "wrong" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/could not sign in/i));
    expect(password).toHaveFocus();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/login",
      expect.objectContaining({ method: "POST" }),
    );
    fetchMock.mockRestore();
  });

  it("keeps a native no-JavaScript form path", () => {
    render(<LoginForm />);
    const form = screen.getByRole("button", { name: "Sign in" }).closest("form");
    expect(form).toHaveAttribute("method", "post");
    expect(form).toHaveAttribute("action", "/api/auth/login");
  });
});
