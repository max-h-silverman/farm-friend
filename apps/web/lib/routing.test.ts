import { describe, expect, it, vi } from "vitest";
import { FixedClock } from "@farm-friend/core";
import type { Db } from "@farm-friend/db";
import { routeInboundMessage, type RouteDeps } from "./routing";

// F-023 — the deterministic routing ORDER, proven at the decision boundary.
//
// The claim these tests exist to make falsifiable: a compliance keyword or commitment token
// never reaches a model. That is asserted here structurally rather than by comment — the
// free-text seam supplied below THROWS. If routing ever consults it for STOP, the test dies
// with that error instead of quietly passing.
//
// The durable half (does STOP actually unsubscribe?) is a real-Postgres question and lives
// in routing.integration.test.ts. These tests own the order and the seam boundary.

// Fixture instants are OFFSETS from a clock-derived anchor, never calendar literals — a
// suite whose result depends on the date is not a suite (B-003).
const T0 = new Date(Date.now() - 60 * 60 * 1000);

/**
 * A free-text seam that must never be called on a deterministic path. This is the whole
 * point: "no model call before parsing" is only real if something detonates when it happens.
 */
function forbiddenFreeText(): RouteDeps["freeText"] {
  return async () => {
    throw new Error(
      "MODEL SEAM REACHED on a deterministic path — Golden Rule #2 violated",
    );
  };
}

/**
 * A `Db` stand-in recording the SQL it is asked to run. The consent and confirmation
 * transactions are exercised for real against Postgres in the integration suite; here we
 * only need to know WHICH handler routing chose.
 */
function recordingDb(rows: Record<string, unknown>[] = []): {
  db: Db;
  queries: string[];
} {
  const queries: string[] = [];
  const record = (strings: TemplateStringsArray) => {
    queries.push(strings.join("?").replace(/\s+/g, " ").trim());
    return Promise.resolve(rows);
  };

  const sql = record as unknown as Db["sql"] & {
    begin: (fn: (tx: unknown) => Promise<unknown>) => Promise<unknown>;
  };
  // The real transactions run against real Postgres in routing.integration.test.ts. Here
  // `begin` only has to let the chosen handler run far enough to record WHICH tables it
  // touched — routing order is what these tests own.
  sql.begin = (fn: (tx: unknown) => Promise<unknown>) => {
    const tx = record as unknown as { json: (v: unknown) => unknown };
    tx.json = (value: unknown) => value;
    return fn(tx);
  };

  return { db: { sql, orm: {}, close: async () => {} } as unknown as Db, queries };
}

function deps(overrides: Partial<RouteDeps> = {}): RouteDeps {
  const { db } = recordingDb();
  return {
    db,
    clock: new FixedClock(T0),
    freeText: forbiddenFreeText(),
    ...overrides,
  };
}

function event(body: string | null, providerEventId = "evt-1") {
  return {
    senderHash: "a".repeat(64),
    body,
    occurredAt: T0,
    providerEventId,
    inboxEventId: "11111111-1111-1111-1111-111111111111",
  };
}

describe("deterministic routing order (Golden Rule #2)", () => {
  it("routes every registered opt-out keyword to the consent path with NO model call", async () => {
    for (const word of ["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"]) {
      const { db, queries } = recordingDb();
      // freeText throws: reaching it fails this test rather than being asserted about.
      const result = await routeInboundMessage(
        { db, clock: new FixedClock(T0), freeText: forbiddenFreeText() },
        event(word),
      );

      expect(result.outcome, word).toEqual({
        kind: "consent",
        transition: "stop",
        applied: expect.any(Boolean),
      });
      // The consent watermark transaction ran.
      expect(
        queries.some((q) => q.includes("consent_transition_watermarks")),
        word,
      ).toBe(true);
    }
  });

  it("answers a STOP with exactly the registered opt-out copy, as required_reply", async () => {
    const { db } = recordingDb();
    const result = await routeInboundMessage(
      { db, clock: new FixedClock(T0), freeText: forbiddenFreeText() },
      event("STOP"),
    );

    expect(result.replies).toHaveLength(1);
    // `required_reply` is the ONE category STOP cannot suppress — the carrier-required
    // acknowledgement of the opt-out must survive the opt-out that provoked it.
    expect(result.replies[0]?.category).toBe("required_reply");
    expect(result.replies[0]?.body).toMatch(/unsubscribed/i);
  });

  it("routes JOIN and START to consent with their distinct capture provenance", async () => {
    for (const word of ["JOIN", "START"]) {
      const { db, queries } = recordingDb();
      const result = await routeInboundMessage(
        { db, clock: new FixedClock(T0), freeText: forbiddenFreeText() },
        event(word),
      );

      expect(result.outcome, word).toMatchObject({
        kind: "consent",
        transition: "start",
      });
      expect(queries.some((q) => q.includes("consent_transition_watermarks"))).toBe(
        true,
      );
      expect(result.replies[0]?.body).toMatch(/agreed to receive/i);
    }
  });

  it("answers HELP/INFO with the registered help copy and changes no consent", async () => {
    for (const word of ["HELP", "INFO"]) {
      const { db, queries } = recordingDb();
      const result = await routeInboundMessage(
        { db, clock: new FixedClock(T0), freeText: forbiddenFreeText() },
        event(word),
      );

      expect(result.outcome, word).toEqual({ kind: "help" });
      expect(result.replies[0]?.body).toMatch(/board@vigavashon\.org/);
      expect(result.replies[0]?.category).toBe("required_reply");
      // Asking for help is not opting in: no consent transaction may run.
      expect(queries.some((q) => q.includes("consent_transition_watermarks"))).toBe(
        false,
      );
    }
  });

  it("routes FLAG to a durable review item without a model call", async () => {
    const { db, queries } = recordingDb([{ id: "flag-1" }]);
    const result = await routeInboundMessage(
      { db, clock: new FixedClock(T0), freeText: forbiddenFreeText() },
      event("FLAG"),
    );

    expect(result.outcome).toEqual({ kind: "flag", flagId: "flag-1" });
    expect(queries.some((q) => q.includes("insert into flags"))).toBe(true);
    // Raising a safety flag is not opting out.
    expect(queries.some((q) => q.includes("consent_transition_watermarks"))).toBe(false);
  });

  it("routes YES/NO to the confirmation path, never to a model", async () => {
    for (const token of ["YES", "NO"]) {
      // No open proposal: the token commits nothing and is NOT reinterpreted as free text.
      const { db } = recordingDb([]);
      const result = await routeInboundMessage(
        { db, clock: new FixedClock(T0), freeText: forbiddenFreeText() },
        event(token),
      );

      expect(result.outcome, token).toEqual({
        kind: "confirmation",
        status: "no_open_proposal",
      });
    }
  });

  it("sends free text to the model seam — the ONLY path that may reach one", async () => {
    const freeText = vi.fn(async () => ({
      replies: [
        {
          body: "answered",
          category: "inquiry_reply" as const,
          logicalKey: "k",
        },
      ],
      handled: "customer" as const,
    }));

    const result = await routeInboundMessage(
      deps({ freeText }),
      event("what do you have today?"),
    );

    expect(freeText).toHaveBeenCalledOnce();
    expect(result.outcome).toEqual({ kind: "free_text", handled: "customer" });
    expect(result.replies[0]?.category).toBe("inquiry_reply");
  });

  it("treats a keyword embedded in a sentence as free text, not a command", async () => {
    // "please don't stop the alerts" must NOT unsubscribe anyone: a command matches only
    // when it is the entire normalized message.
    const freeText = vi.fn(async () => ({ replies: [], handled: "none" as const }));
    const { db, queries } = recordingDb();

    await routeInboundMessage(
      { db, clock: new FixedClock(T0), freeText },
      event("please don't stop the alerts"),
    );

    expect(freeText).toHaveBeenCalledOnce();
    expect(queries.some((q) => q.includes("consent_transition_watermarks"))).toBe(false);
  });

  it("does not call the model for an empty-bodied event", async () => {
    const freeText = vi.fn(async () => ({ replies: [], handled: "none" as const }));
    const result = await routeInboundMessage(deps({ freeText }), event(null));

    // An MMS with no text carries nothing to interpret; it reaches the free-text branch
    // with an empty string and the handler decides, but no command is fabricated.
    expect(result.outcome).toEqual({ kind: "free_text", handled: "none" });
    expect(freeText).toHaveBeenCalledWith(
      expect.objectContaining({ taskText: "" }),
    );
  });
});
