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
    const text = strings.join("?").replace(/\s+/g, " ").trim();
    queries.push(text);
    // B-011: the first-time JOIN guard is an `insert ... on conflict do nothing returning`,
    // so an EMPTY result means "someone else already holds the record". A stub that returned
    // `[]` for this query would report every first-time sender as already-enrolled. The
    // default fixture is a sender with no consent row, so the insert wins and returns one.
    if (text.includes("insert into sms_consents")) {
      return Promise.resolve([{ state: "active" }]);
    }
    // The default fixture is a sender with NO consent history, so the watermark and the
    // existing-record probe are empty. Stated per-query rather than by returning `rows`,
    // because `rows` is the caller's fixture for the ONE table their test is about — an
    // invitation row answering the watermark select made a first-time sender look like one
    // with a prior transition, and the ordering guard then read a missing `occurred_at`.
    if (
      text.includes("from consent_transition_watermarks") ||
      text.includes("from sms_consents")
    ) {
      return Promise.resolve([]);
    }
    return Promise.resolve(rows);
  };

  // The real transactions run against real Postgres in routing.integration.test.ts. Here
  // `begin` only has to let the chosen handler run far enough to record WHICH tables it
  // touched — routing order is what these tests own.
  //
  // GL-005: `begin` is attached to the recorder BEFORE any cast, and the single widening to
  // `Db["sql"]` happens once, at the boundary. It used to be written as
  // `record as unknown as Db["sql"] & { begin: … }` followed by `sql.begin = …`, which named
  // an intersection nothing can inhabit: the driver's real `begin` is overloaded, and no
  // one-argument function is assignable to it, so the assignment could never typecheck.
  // Casting the finished stub states the honest thing — this is a stand-in, deliberately
  // narrower than the driver — instead of claiming it satisfies a signature it does not.
  const stub = Object.assign(record, {
    begin: (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = record as unknown as { json: (v: unknown) => unknown };
      tx.json = (value: unknown) => value;
      return fn(tx);
    },
  });

  const sql = stub as unknown as Db["sql"];
  return { db: { sql, orm: {}, close: async () => {} } as unknown as Db, queries };
}

/**
 * A pager that must never be called except on an actual paging word (F-046). Same device as
 * `forbiddenFreeText`: the default detonates, so "MORE never shadows STOP or a confirmation
 * token" fails loudly instead of being asserted about after the fact.
 */
function forbiddenNextPage(): RouteDeps["nextPage"] {
  return async () => {
    throw new Error("PAGER REACHED on a non-paging path — Golden Rule #2 violated");
  };
}

function forbiddenFarmerTarget(): RouteDeps["farmerTarget"] {
  return async () => {
    throw new Error("TARGET HANDLER REACHED on a non-targeting path");
  };
}

function forbiddenStandSelection(): RouteDeps["selectStand"] {
  return async () => {
    throw new Error("STAND SELECTION REACHED on a non-selection path");
  };
}

function forbiddenScheduledSame(): RouteDeps["scheduledSame"] {
  return async () => {
    throw new Error("SAME HANDLER REACHED on a non-SAME path");
  };
}

function deps(overrides: Partial<RouteDeps> = {}): RouteDeps {
  const { db } = recordingDb();
  return {
    db,
    clock: new FixedClock(T0),
    // F-040. A configured origin, because a farmer's standing link is built against it and
    // must never come from a request header.
    publicBaseUrl: "https://farmfriend.example",
    publicMapUrl: "https://www.vigavashon.org/farm-stand-map",
    freeText: forbiddenFreeText(),
    nextPage: forbiddenNextPage(),
    farmerTarget: forbiddenFarmerTarget(),
    selectStand: forbiddenStandSelection(),
    scheduledSame: forbiddenScheduledSame(),
    ...overrides,
  };
}

describe("SAME routing (F-052)", () => {
  it("calls only the deterministic scheduled handler for exact SAME", async () => {
    const scheduledSame = vi.fn(async () => ({ status: "published", replies: [] }));
    const result = await routeInboundMessage(deps({ scheduledSame }), event("SAME"));
    expect(result.outcome).toEqual({ kind: "confirmation", status: "published" });
    expect(scheduledSame).toHaveBeenCalledWith({
      senderHash: "a".repeat(64),
      occurredAt: T0,
      providerEventId: "evt-1",
    });
  });
});

describe("MAP routing (F-057)", () => {
  it("returns only the configured public-map URL without reaching a model", async () => {
    const result = await routeInboundMessage(deps(), event(" MAP. "));

    expect(result.outcome).toEqual({ kind: "map" });
    expect(result.replies).toEqual([
      {
        body: "https://www.vigavashon.org/farm-stand-map",
        category: "inquiry_reply",
        logicalKey: "map-evt-1",
      },
    ]);
  });

  it("still returns the link for a stale event because MAP has no conversation state", async () => {
    const result = await routeInboundMessage(
      deps(),
      { ...event("MAP"), isStale: true },
    );

    expect(result.outcome).toEqual({ kind: "map" });
    expect(result.replies[0]?.body).toBe("https://www.vigavashon.org/farm-stand-map");
  });
});

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
        deps({ db }),
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
      deps({ db }),
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
        deps({ db }),
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
      expect(result.replies[1]?.body).toMatch(/ask what is available/i);
      expect(result.replies[1]?.category).toBe("inquiry_reply");
    }
  });

  // B-011 — JOIN from someone who already has a record must not claim consent, and must say
  // the word that actually works.
  //
  // Telnyx keeps its own opt-out list and enforces it at the carrier layer; only START
  // clears it. A `join` four minutes after a `stop` still 409'd while a `start` between them
  // was accepted (verified 2026-07-27), so a JOIN that "restored" consent would record
  // `active` for a farmer the carrier blocks.
  //
  // The `sms_consents` row is what `applyConsentTransition` consults for the first-time
  // rule, so returning one here is what makes this an already-enrolled sender. The real
  // transaction runs against Postgres in the integration suite; this owns the ROUTING
  // consequence — which copy the sender gets.
  describe("JOIN after a record exists (B-011)", () => {
    /** A Db whose `sms_consents` lookup finds an existing row. */
    function dbWithConsentRow(state: "active" | "stopped") {
      const queries: string[] = [];
      const record = (strings: TemplateStringsArray) => {
        const text = strings.join("?").replace(/\s+/g, " ").trim();
        queries.push(text);
        // The already-enrolled shape: the guard's `insert ... on conflict do nothing
        // returning` finds a conflict and returns NOTHING, and the follow-up select reads
        // the existing state. The watermark select must stay empty, or the transition would
        // be refused as `stale` instead — that is the other branch and a different test.
        if (text.includes("insert into sms_consents")) return Promise.resolve([]);
        if (text.includes("from sms_consents")) return Promise.resolve([{ state }]);
        return Promise.resolve([]);
      };
      // Attached before the cast, then widened once — see `recordingDb` above (GL-005).
      const sql = Object.assign(record, {
        begin: (fn: (tx: unknown) => Promise<unknown>) => {
          const tx = record as unknown as { json: (v: unknown) => unknown };
          tx.json = (value: unknown) => value;
          return fn(tx);
        },
      }) as unknown as Db["sql"];
      return {
        db: { sql, orm: {}, close: async () => {} } as unknown as Db,
        queries,
      };
    }

    for (const state of ["stopped", "active"] as const) {
      it(`tells a ${state} sender to reply START, and enrolls nobody`, async () => {
        const { db, queries } = dbWithConsentRow(state);
        const result = await routeInboundMessage(
          deps({ db }),
          event("JOIN"),
        );

        // THE ASSERTION: they are told the carrier's word, not the opt-in confirmation.
        expect(result.replies[0]?.body).toMatch(/reply START to restart/i);
        expect(result.replies[0]?.body).not.toMatch(/agreed to receive/i);
        // `required_reply` is what lets this reach a `stopped` sender at all.
        expect(result.replies[0]?.category).toBe("required_reply");
        // Nothing was enrolled.
        expect(result.outcome).toMatchObject({ kind: "consent", applied: false });
        // The guard IS an `insert ... on conflict do nothing`, so an insert statement does
        // run — it is how the database, rather than a racy read, decides who holds the
        // record. What must not happen is a WRITE, and the conflict is what prevents it;
        // asserting "no insert statement" would now contradict the design.
        //
        // The watermark is the load-bearing assertion here: a JOIN with no consent
        // consequence must not advance it, or it could mask a later legitimate START
        // arriving at an earlier provider time.
        expect(
          queries.some((q) => q.includes("insert into consent_transition_watermarks")),
        ).toBe(false);
      });
    }

    it("still enrolls a genuine first-time sender with the registered copy", async () => {
      // The control. No consent row exists, so JOIN works exactly as before — this is what
      // proves the rule narrowed the right case rather than breaking opt-in outright.
      const { db, queries } = recordingDb();
      const result = await routeInboundMessage(
        deps({ db }),
        event("JOIN"),
      );

      expect(result.outcome).toMatchObject({ kind: "consent", applied: true });
      expect(result.replies[0]?.body).toMatch(/agreed to receive/i);
      expect(result.replies[1]?.body).toMatch(/ask what is available/i);
      expect(queries.some((q) => q.includes("consent_transition_watermarks"))).toBe(true);
    });

    it("does not give the already-joined answer to a merely STALE join", async () => {
      // The distinction the `refusal` field exists for, and the reason routing keys on the
      // REASON rather than on `!applied`. A JOIN refused by the watermark is an older event
      // arriving late — it says nothing about the sender having a record, so answering it
      // with "reply START to restart" would be a non-sequitur.
      //
      // Caught by sabotage: keying on `!applied.applied` passed this entire file until this
      // case existed, because no fixture produced a stale refusal.
      const queries: string[] = [];
      const record = (strings: TemplateStringsArray) => {
        const text = strings.join("?").replace(/\s+/g, " ").trim();
        queries.push(text);
        // A NEWER watermark already exists, so this JOIN loses on provider time. No
        // `sms_consents` row, so the first-time rule itself would have allowed it.
        if (text.includes("from consent_transition_watermarks")) {
          return Promise.resolve([
            { transition: "start", occurred_at: new Date(T0.getTime() + 60_000) },
          ]);
        }
        return Promise.resolve([]);
      };
      // Attached before the cast, then widened once — see `recordingDb` above (GL-005).
      const sql = Object.assign(record, {
        begin: (fn: (tx: unknown) => Promise<unknown>) => {
          const tx = record as unknown as { json: (v: unknown) => unknown };
          tx.json = (value: unknown) => value;
          return fn(tx);
        },
      }) as unknown as Db["sql"];
      const db = { sql, orm: {}, close: async () => {} } as unknown as Db;

      const result = await routeInboundMessage(
        deps({ db }),
        event("JOIN"),
      );

      expect(result.outcome).toMatchObject({ kind: "consent", applied: false });
      // Registered copy, NOT the already-joined answer.
      expect(result.replies[0]?.body).toMatch(/agreed to receive/i);
      expect(result.replies[0]?.body).not.toMatch(/reply START to restart/i);
    });

    it("does not give the already-joined answer to START", async () => {
      // START must reach the carrier from any state — it is the one word that lifts a block
      // we cannot see. It gets the registered opt-in copy, never "reply START".
      const { db } = dbWithConsentRow("stopped");
      const result = await routeInboundMessage(
        deps({ db }),
        event("START"),
      );

      expect(result.outcome).toMatchObject({ kind: "consent", applied: true });
      expect(result.replies[0]?.body).toMatch(/agreed to receive/i);
    });
  });

  it("answers HELP/INFO with the registered help copy and changes no consent", async () => {
    for (const word of ["HELP", "INFO"]) {
      const { db, queries } = recordingDb();
      const result = await routeInboundMessage(
        deps({ db }),
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
      deps({ db }),
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
        deps({ db }),
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
      deps({ db, freeText }),
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

  // F-040 / F-080 — the farmer keywords. Routed like every other deterministic keyword:
  // upstream of the model, which the throwing seam proves.
  describe("farmer keywords (F-040, F-080)", () => {
    const INVITE = "b".repeat(64);

    it("SIGNUP is no longer routed at all — it reaches the model as free text", async () => {
      // F-080's routing half. `SIGNUP` was the sole writer of `farmer_onboarding_requests`,
      // so this asserts it no longer writes one: the outcome must not be a farmer command,
      // and nothing may be inserted on its behalf.
      const { db, queries } = recordingDb();
      const freeText = vi.fn(async () => ({ replies: [], handled: "none" as const }));
      const result = await routeInboundMessage(deps({ db, freeText }), event("SIGNUP"));

      expect(result.outcome.kind).not.toBe("farmer");
      expect(
        queries.some((q) => q.includes("insert into farmer_onboarding_requests")),
      ).toBe(false);
      expect(freeText).toHaveBeenCalled();
    });

    it("JOIN <token> NO LONGER REDEEMS — it reaches the model as free text", async () => {
      // The grammar is gone (max 2026-08-07). It made the farmer hand-copy 64 hex characters,
      // and every slip failed silently. This asserts the routing half: no onboarding request
      // is opened, and the message reaches the model like any other sentence.
      const { db, queries } = recordingDb([{ id: "invite-1" }]);
      const freeText = vi.fn(async () => ({ replies: [], handled: "none" as const }));
      const result = await routeInboundMessage(
        deps({ db, freeText }),
        event(`JOIN ${INVITE}`),
      );

      expect(result.outcome.kind).not.toBe("farmer");
      expect(
        queries.some((q) => q.includes("insert into farmer_onboarding_requests")),
      ).toBe(false);
      expect(freeText).toHaveBeenCalled();
    });

    it("a bare START COMPLETES onboarding when an invitation expects that phone", async () => {
      // The replacement, at the routing layer. START is matched against the phone the farmer
      // stated on the form, so the message carries nothing to mistype.
      const { db, queries } = recordingDb([{ id: "invite-1" }]);
      const result = await routeInboundMessage(deps({ db }), event("START"));

      // Still a consent outcome — START's carrier meaning is unchanged and comes first.
      expect(result.outcome).toMatchObject({ kind: "consent", transition: "start" });
      // ...and it looked for an invitation waiting on this handset.
      expect(queries.some((q) => q.includes("pending_phone_hash"))).toBe(true);
      expect(
        queries.some((q) => q.includes("insert into farmer_onboarding_requests")),
      ).toBe(true);
    });

    it("matches the invitation by phone HASH, never by a raw number", async () => {
      // Golden Rule #5 at the match. The raw column exists for the send path alone, so the
      // matcher must never appear in a query beside it.
      const { db, queries } = recordingDb([{ id: "invite-1" }]);
      await routeInboundMessage(deps({ db }), event("START"));

      const match = queries.find((q) => q.includes("pending_phone_hash"));
      expect(match).toBeDefined();
      expect(match).not.toContain("pending_phone_e164");
    });

    it("does NOT complete onboarding on a bare JOIN", async () => {
      // B-011. JOIN cannot clear the carrier's own opt-out list, so setting a farmer up on it
      // would authorize someone whose messages the carrier silently refuses — the exact dead
      // end that rule closed. Only START may complete onboarding.
      const { db, queries } = recordingDb([{ id: "invite-1" }]);
      const result = await routeInboundMessage(deps({ db }), event("JOIN"));

      expect(result.outcome).toMatchObject({ kind: "consent", transition: "start" });
      expect(queries.some((q) => q.includes("pending_phone_hash"))).toBe(false);
      expect(
        queries.some((q) => q.includes("insert into farmer_onboarding_requests")),
      ).toBe(false);
    });

    it("BARE JOIN still routes to compliance — the registered opt-in keeps working", async () => {
      // The routing half of the safety argument the parser makes. A bare `JOIN` is the
      // carrier-registered opt-in: it must reach `routeCompliance` and enroll.
      const { db } = recordingDb();
      const result = await routeInboundMessage(deps({ db }), event("JOIN"));

      expect(result.outcome).toMatchObject({ kind: "consent", transition: "start" });
    });

    it("acknowledges a START without claiming an un-set-up farmer is ready", async () => {
      // A request grants nothing on its own. Copy that read as a yes would send a farmer to
      // their stand expecting to publish. The invitation here was never ticked, so nothing
      // was authorized.
      const { db } = recordingDb([{ id: "invite-1", agreed_to_sms_at: null }]);
      const result = await routeInboundMessage(deps({ db }), event("START"));

      expect(result.replies.length).toBeGreaterThan(0);
      for (const reply of result.replies) {
        expect(reply.body.toLowerCase()).not.toContain("you're all set");
        expect(reply.body.toLowerCase()).not.toContain("approved");
      }
    });

    it("establishes consent through the SAME writer bare JOIN uses, never a second one", async () => {
      // The launch blocker's fix, and the property F-080 most had to preserve. An invited
      // JOIN whose agreement box was ticked opts the farmer in — but only through
      // `applyConsentTransition`'s existing rules, inside the redemption transaction. A
      // second consent writer would be a second set of rules for one fact.
      //
      // Now that START owns both the carrier transition and the redemption, "one writer" is
      // what stops the same message enrolling twice under two sets of rules.
      const { db, queries } = recordingDb([
        { id: "invite-1", agreed_to_sms_at: new Date(T0.getTime() - 60_000) },
      ]);
      await routeInboundMessage(deps({ db }), event("START"));

      expect(queries.some((q) => q.includes("insert into sms_consents"))).toBe(true);
      expect(
        queries.some((q) => q.includes("insert into consent_transition_watermarks")),
      ).toBe(true);
    });

    it("establishes NO consent for an invitation whose box was never ticked", async () => {
      // VIGA creating an invitation cannot opt a farmer in. Only the farmer's own tick,
      // followed by their own inbound message, can.
      //
      // The REDEMPTION writes no consent when `agreed_to_sms_at` is null. START's own carrier
      // transition is a separate, unconditional write — which is why this asserts on the
      // redemption's guarded insert rather than on there being no consent write at all.
      const { db, queries } = recordingDb([{ id: "invite-1", agreed_to_sms_at: null }]);
      await routeInboundMessage(deps({ db }), event("START"));

      expect(queries.some((q) => q.includes("insert into farmer_authorizations"))).toBe(false);
    });

    it("does not re-enroll a number that texted STOP, by redeeming an invitation", async () => {
      // The property `firstTimeOnly` exists for, re-proved after the rename because a rename
      // is exactly when a flag gets dropped silently. A person who opted out must not be
      // opted back in by an administrator minting them an invitation — the consent write
      // refuses when ANY record exists, stopped ones included.
      //
      // Asserted at the CALL: `firstTimeOnly` must be requested. The rule itself is enforced
      // and tested inside `applyConsentTransitionIn`'s lock.
      const { db, queries } = recordingDb([
        { id: "invite-1", agreed_to_sms_at: new Date(T0.getTime() - 60_000) },
      ]);
      await routeInboundMessage(deps({ db }), event("START"));

      // The consent insert is guarded by an existence check rather than being unconditional.
      const consentWrite = queries.find((q) => q.includes("insert into sms_consents"));
      expect(consentWrite).toBeDefined();
      expect(
        queries.some((q) => q.includes("from sms_consents") || q.includes("for update")),
      ).toBe(true);
    });

    it("writes NO authorization for an UN-TICKED invitation — a text is not a grant", async () => {
      // THE property. An invitation with no agreement authorizes nobody: without the
      // farmer's own tick there is no informed opt-in, and setting them up here would
      // grant publishing rights off a message alone.
      const { db, queries } = recordingDb([{ id: "invite-1", agreed_to_sms_at: null }]);
      await routeInboundMessage(deps({ db }), event("START"));

      expect(
        queries.some((q) => q.includes("insert into farmer_authorizations")),
      ).toBe(false);
    });

    it("refuses LINK for a sender who is not an authorized farmer, minting nothing", async () => {
      const { db, queries } = recordingDb();
      const farmerTarget = vi.fn(async () => ({
        status: "not_authorized",
        replies: [{
          body: "We passed your request to a coordinator.",
          category: "required_reply" as const,
          logicalKey: "link-refused",
        }],
      }));
      const result = await routeInboundMessage(
        deps({ db, farmerTarget }),
        event("LINK"),
      );

      expect(result.outcome).toEqual({
        kind: "farmer",
        keyword: "LINK",
        status: "not_authorized",
      });
      expect(queries.some((q) => q.includes("insert into farmer_links"))).toBe(false);
      // Nothing in the reply is a link.
      expect(result.replies[0]?.body).not.toMatch(/https?:\/\//);
    });

    it("delegates LINK to the deterministic target handler", async () => {
      const farmerTarget = vi.fn(async () => ({ status: "menu", replies: [] }));
      const result = await routeInboundMessage(
        deps({ farmerTarget }),
        event("LINK"),
      );

      expect(result.outcome).toMatchObject({ kind: "farmer", keyword: "LINK" });
      expect(farmerTarget).toHaveBeenCalledWith(expect.objectContaining({ keyword: "LINK" }));
    });

    it("sends a LINK as a PROACTIVE category, so consent still gates it", async () => {
      // Handing over a durable credential is Farm Friend speaking first. A `required_reply`
      // here would deliver a standing key to someone with no consent basis.
      const farmerTarget = vi.fn(async () => ({
        status: "issued",
        replies: [{
          body: "private link",
          category: "inventory_prompt" as const,
          logicalKey: "link-issued",
        }],
      }));
      const result = await routeInboundMessage(deps({ farmerTarget }), event("LINK"));

      expect(result.replies[0]?.category).toBe("inventory_prompt");
    });

    it("never reaches the model for any farmer keyword", async () => {
      // The structural claim, stated once more where it is cheapest to check: the seam in
      // `deps()` throws, so any model call fails these outright rather than being asserted
      // about afterwards.
      for (const word of ["LINK", "link", "STAND", "SETTINGS"]) {
        const { db } = recordingDb([{ id: "invite-1" }]);
        const farmerTarget = vi.fn(async () => ({ status: "menu", replies: [] }));
        await expect(
          routeInboundMessage(deps({ db, farmerTarget }), event(word)),
        ).resolves.toMatchObject({ outcome: { kind: "farmer" } });
      }
    });
  });

  // F-046 part 3 — MORE, routed like every other deterministic keyword. The seam in `deps()`
  // throws, so "paging reaches no model" is proven by these tests surviving rather than by a
  // comment claiming it.
  describe("the MORE paging keyword (F-046)", () => {
    it("routes MORE to the pager, never to a model", async () => {
      const nextPage = vi.fn(async () => ({
        body: "page two",
        status: "paged" as const,
      }));
      const result = await routeInboundMessage(
        deps({ nextPage }),
        event("MORE"),
      );

      expect(nextPage).toHaveBeenCalledOnce();
      expect(result.outcome).toEqual({ kind: "paging", status: "paged" });
      expect(result.replies).toHaveLength(1);
      expect(result.replies[0]?.body).toBe("page two");
      // Answering the customer's own message, so it rides on that message rather than on a
      // standing consent basis.
      expect(result.replies[0]?.category).toBe("inquiry_reply");
    });

    it("answers MORE with no pending list honestly, and still calls no model", async () => {
      // Case 6. The pager reports that nothing was pending; the words are code's, and the
      // customer is never met with silence.
      const nextPage = vi.fn(async () => ({
        body: "I don't have a list going right now. What are you looking for?",
        status: "no_pending_list" as const,
      }));
      const result = await routeInboundMessage(
        deps({ nextPage }),
        event("MORE"),
      );

      expect(result.outcome).toEqual({ kind: "paging", status: "no_pending_list" });
      expect(result.replies).toHaveLength(1);
      expect(result.replies[0]?.body).toMatch(/looking for/i);
    });

    it("accepts NEXT as the same paging request", async () => {
      const nextPage = vi.fn(async () => ({
        body: "page two",
        status: "paged" as const,
      }));
      await routeInboundMessage(deps({ nextPage }), event("NEXT"));
      expect(nextPage).toHaveBeenCalledOnce();
    });

    it("keys the reply to the provider event, so a replay reuses the outbox row", async () => {
      const nextPage = vi.fn(async () => ({
        body: "page two",
        status: "paged" as const,
      }));
      const result = await routeInboundMessage(
        deps({ nextPage }),
        event("MORE", "evt-paging-7"),
      );
      expect(result.replies[0]?.logicalKey).toContain("evt-paging-7");
    });

    // Golden Rule #2. MORE is ordered AFTER STOP and can never shadow it — asserted by
    // giving the router a pager that detonates, so a STOP reaching paging fails outright.
    it("never lets paging shadow an opt-out", async () => {
      const explodingPager = async () => {
        throw new Error("PAGING REACHED on a compliance path — Golden Rule #2 violated");
      };
      for (const word of ["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"]) {
        const { db } = recordingDb();
        const result = await routeInboundMessage(
          deps({ db, nextPage: explodingPager }),
          event(word),
        );
        expect(result.outcome, word).toMatchObject({
          kind: "consent",
          transition: "stop",
        });
      }
    });

    it("never lets paging swallow a confirmation token", async () => {
      // max, 2026-07-31 — direction ONE of "both work": YES/NO still reach the confirmation
      // path with the paging branch present. A pager that throws proves it structurally.
      const explodingPager = async () => {
        throw new Error("PAGING REACHED for a confirmation token");
      };
      for (const token of ["YES", "NO"]) {
        const { db } = recordingDb([]);
        const result = await routeInboundMessage(
          deps({ db, nextPage: explodingPager }),
          event(token),
        );
        expect(result.outcome, token).toEqual({
          kind: "confirmation",
          status: "no_open_proposal",
        });
      }
    });

    it("never lets a MORE reach the confirmation path", async () => {
      // Direction TWO: paging must not consume, expire, or answer an open confirmation. The
      // db stub records every statement, so a proposal lookup on this path is visible.
      const { db, queries } = recordingDb([{ id: "proposal-1" }]);
      const nextPage = vi.fn(async () => ({
        body: "page two",
        status: "paged" as const,
      }));
      const result = await routeInboundMessage(
        deps({ db, nextPage }),
        event("MORE"),
      );

      expect(result.outcome).toMatchObject({ kind: "paging" });
      expect(
        queries.some((q) => q.includes("inventory_publication_proposals")),
      ).toBe(false);
      expect(queries.some((q) => q.includes("insert into inventory_revisions"))).toBe(
        false,
      );
    });

    it("treats a paging word inside a sentence as free text", async () => {
      // "any more eggs?" is a QUESTION. Swallowing it as paging would answer with the wrong
      // list, or with "I don't have a list going" to someone who asked a real question.
      const freeText = vi.fn(async () => ({ replies: [], handled: "none" as const }));
      const explodingPager = async () => {
        throw new Error("PAGING REACHED for a sentence containing 'more'");
      };
      await routeInboundMessage(
        deps({ freeText, nextPage: explodingPager }),
        event("any more eggs?"),
      );
      expect(freeText).toHaveBeenCalledOnce();
    });

    it("refuses a STALE MORE, because paging advances conversation state", async () => {
      // The offset is conversation state: a delayed MORE arriving after a newer question
      // would page a list the customer has already replaced.
      const explodingPager = async () => {
        throw new Error("PAGING REACHED for a stale event");
      };
      const result = await routeInboundMessage(
        deps({ nextPage: explodingPager }),
        { ...event("MORE"), isStale: true },
      );
      expect(result.outcome).toEqual({
        kind: "stale",
        failureCode: "stale_conversation_event",
      });
      expect(result.replies).toEqual([]);
    });
  });

  describe("stand targeting commands (F-051)", () => {
    it("routes STAND and SETTINGS to code before any model call", async () => {
      for (const keyword of ["STAND", "SETTINGS"] as const) {
        const farmerTarget = vi.fn(async () => ({
          status: "menu",
          replies: [{
            body: "Choose a stand",
            category: "inquiry_reply" as const,
            logicalKey: `target-${keyword}`,
          }],
        }));
        const result = await routeInboundMessage(
          deps({ farmerTarget }),
          event(keyword),
        );

        expect(farmerTarget).toHaveBeenCalledWith({
          senderHash: "a".repeat(64),
          keyword,
          occurredAt: T0,
          providerEventId: "evt-1",
        });
        expect(result.outcome).toEqual({ kind: "farmer", keyword, status: "menu" });
      }
    });

    it("routes a standalone menu number to code, never inquiry or inventory models", async () => {
      const selectStand = vi.fn(async () => ({
        status: "selected",
        replies: [{
          body: "Using Harbor Stand.",
          category: "inquiry_reply" as const,
          logicalKey: "stand-selected",
        }],
      }));
      const result = await routeInboundMessage(deps({ selectStand }), event("2"));

      expect(selectStand).toHaveBeenCalledWith({
        senderHash: "a".repeat(64),
        optionNumber: 2,
        occurredAt: T0,
        providerEventId: "evt-1",
      });
      expect(result.outcome).toEqual({ kind: "stand_selection", status: "selected" });
      expect(result.replies[0]?.body).toContain("Harbor Stand");
    });

    it("keeps STOP and confirmation ahead of targeting handlers", async () => {
      for (const body of ["STOP", "YES", "NO"]) {
        const { db } = recordingDb([]);
        await expect(routeInboundMessage(deps({ db }), event(body))).resolves.toBeDefined();
      }
    });

    it("keeps targeting after commitment and before paging/free text", async () => {
      const farmerTarget = vi.fn(async () => ({ status: "selected", replies: [] }));
      const nextPage = vi.fn(async () => ({ body: "page", status: "paged" as const }));
      const freeText = vi.fn(async () => ({ replies: [], handled: "none" as const }));

      await routeInboundMessage(
        deps({ farmerTarget, nextPage, freeText }),
        event("STAND"),
      );

      expect(farmerTarget).toHaveBeenCalledOnce();
      expect(nextPage).not.toHaveBeenCalled();
      expect(freeText).not.toHaveBeenCalled();
    });
  });
});
