import {
  parseCommand,
  consentTransitionFor,
  farmerLinkUrl,
  renderFarmerLinkMessage,
  ALREADY_JOINED_RESPONSE,
  FARMER_ONBOARDING_REQUEST_ACKNOWLEDGEMENT,
  REGISTERED_HELP_AUTO_RESPONSE,
  REGISTERED_OPT_IN_AUTO_RESPONSE,
  REGISTERED_OPT_OUT_AUTO_RESPONSE,
  renderClarificationRequest,
  type Clock,
  type ComplianceKeyword,
  type FarmerKeyword,
  type LaunchMessageCategory,
} from "@farm-friend/core";
import {
  applyConsentTransition,
  confirmInventoryPublication,
  issueFarmerLink,
  openFarmerOnboardingRequest,
  type Db,
} from "@farm-friend/db";

// Deterministic inbound routing (F-023, docs/ARCHITECTURE.md §"Deterministic routing").
//
// This module is the composition that was missing: every handler below already existed and
// was proven, and nothing called any of them. It adds NO new mechanism — it decides, in one
// small fixed order, which existing handler owns a claimed inbound event.
//
// The order is Golden Rule #2 and is not negotiable:
//
//   1. compliance keywords   — STOP/START/JOIN/HELP/INFO, by CODE, before any model call
//   2. FLAG                  — the human-handoff safety rail, also upstream of the model
//   3. commitment YES/NO     — context- and version-bound to the sender's ONE open proposal
//   4. free text             — only here may a model seam run
//
// Steps 1-3 are `parseCommand` output, which takes the body and NOTHING else: no
// conversation state exists for it to consult, so no state can reinterpret a STOP. The
// model seams are reached through `freeText`, a callback this module invokes only after
// `parseCommand` returns `kind: "none"` — so "no model call on the compliance path" is a
// structural property of this function, not a convention. `routing.test.ts` proves it by
// passing a seam that throws.
//
// Every reply this module produces is queued as outbox work; nothing here sends. Dispatch,
// and therefore the consent recheck, belongs to `authorizeDispatch` at the dispatch claim.

/** A reply this routing decision owes the sender, queued rather than sent. */
export interface RoutedReply {
  body: string;
  category: LaunchMessageCategory;
  /**
   * Idempotency key for the outbox row. Derived from the provider event so a replayed or
   * recovered event reuses the row rather than queueing a second identical SMS.
   */
  logicalKey: string;
}

export type RouteOutcome =
  | { kind: "consent"; transition: "start" | "stop"; applied: boolean }
  | { kind: "help" }
  | { kind: "flag"; flagId: string }
  | { kind: "confirmation"; status: string }
  /**
   * A farmer product keyword (F-040). `status` says what became of it — an onboarding
   * request opened or already open, a link issued, or a refusal for a sender who is not an
   * authorized farmer.
   */
  | { kind: "farmer"; keyword: FarmerKeyword; status: string }
  | { kind: "free_text"; handled: "farmer" | "customer" | "none" }
  /**
   * A stale event this router declined to act on. The caller finalizes it as `rejected`
   * with this code; see `routeInboundMessage` for why the decision lives here.
   */
  | { kind: "stale"; failureCode: "stale_conversation_event" };

export interface RouteResult {
  outcome: RouteOutcome;
  replies: RoutedReply[];
}

/**
 * What the router needs to route ONE claimed event. The free-text branch is a callback so
 * that the model-backed half stays out of this module entirely: this file imports no model
 * seam, and a test can supply a hostile one.
 */
export interface RouteDeps {
  db: Db;
  clock: Clock;
  /**
   * The CONFIGURED public origin a farmer's standing link is built against (F-040). Never
   * derived from the request: a `Host:` header an attacker controls would otherwise let this
   * text a farmer a link pointing at the attacker's origin, which is a credential-harvesting
   * primitive against the one credential that has no password behind it.
   */
  publicBaseUrl: string;
  /**
   * Handle a message that is NOT any deterministic keyword or token. Invoked only after
   * `parseCommand` returns `kind: "none"`; this is the only path on which a model may run.
   */
  freeText(input: {
    senderHash: string;
    taskText: string;
    providerEventId: string;
    inboxEventId: string;
  }): Promise<{ replies: RoutedReply[]; handled: "farmer" | "customer" | "none" }>;
}

export interface RouteInput {
  senderHash: string;
  body: string | null;
  occurredAt: Date;
  providerEventId: string;
  inboxEventId: string;
  /**
   * True when this event is older than the sender's accepted CONVERSATION watermark.
   *
   * Deliberately advisory rather than a veto the caller applies: which messages that fact
   * may refuse is a routing decision, and routing decisions live in this module. See
   * `routeInboundMessage`.
   */
  isStale?: boolean;
}

/** The auto-response a registered compliance keyword owes its sender. */
function complianceAutoResponse(keyword: ComplianceKeyword): string | null {
  switch (keyword) {
    case "STOP":
      return REGISTERED_OPT_OUT_AUTO_RESPONSE;
    case "JOIN":
    case "START":
      return REGISTERED_OPT_IN_AUTO_RESPONSE;
    case "HELP":
    case "INFO":
      return REGISTERED_HELP_AUTO_RESPONSE;
    case "FLAG":
      // FLAG's acknowledgement is not carrier-registered copy; it is rendered below.
      return null;
  }
}

/**
 * The code-rendered acknowledgement for the FLAG safety rail. Deliberately promises only
 * what launch delivers — a person will look — and claims no timeline.
 */
export const FLAG_ACKNOWLEDGEMENT =
  "Thanks — a VIGA coordinator will review this message. " +
  "Reply STOP to opt out at any time.";

/**
 * Route one claimed inbound event to its owning handler.
 *
 * The caller (`runInboundPass`) owns the claim and the finalize; this owns only the
 * decision and the durable consequence of it.
 *
 * ## Why staleness is decided HERE and not by the caller (GL-002)
 *
 * `runInboundPass` used to reject every stale event before calling this function. That was
 * a real compliance defect: a `STOP` delayed in the carrier network, arriving after a newer
 * ordinary message had advanced the sender's conversation watermark, was discarded as
 * `stale_conversation_event` and never reached `applyConsentTransition`. The sender had
 * opted out; Farm Friend recorded them as still subscribed. A coordinator at a desk does not
 * throw away an opt-out because a later letter was opened first.
 *
 * The staleness rule is sound, but it is about CONVERSATION state — "an out-of-order event
 * must not mutate newer state." Its scope is therefore exactly the messages that mutate
 * conversation state:
 *
 *   - **Free text** mutates it (proposals, inquiries, interpretation) → still refused.
 *   - **Confirmation tokens** are bound to a specific open proposal version → still refused.
 *   - **Compliance keywords own no conversation state.** Consent orders itself on
 *     `consent_transition_watermarks`, an independent watermark where an older START can
 *     never undo a newer STOP and STOP wins an exact tie. FLAG is an append-only safety
 *     rail. Neither can corrupt newer state by arriving late, so neither is refused.
 *
 * So this is not an exception carved out for STOP — it is the staleness rule applied to the
 * state it actually protects. Consent ordering stays where it always was, in
 * `applyConsentTransition`, under its own lock; nothing here re-implements it.
 */
export async function routeInboundMessage(
  deps: RouteDeps,
  input: RouteInput,
): Promise<RouteResult> {
  // A message with no body (e.g. an MMS-only payload) is not a command and carries no text
  // to interpret. Nothing is the honest consequence.
  const body = input.body ?? "";

  // STEP 1-3 — deterministic parsing, before any model call.
  const command = parseCommand(body);

  // Compliance keywords are exempt from conversation staleness (see the contract above) and
  // are therefore checked BEFORE it — the ordering that makes a delayed STOP reach consent.
  if (command.kind === "compliance") {
    return routeCompliance(deps, input, command.keyword);
  }

  // Everything below mutates conversation state, so a stale event fails closed here.
  if (input.isStale === true) {
    return {
      outcome: { kind: "stale", failureCode: "stale_conversation_event" },
      replies: [],
    };
  }

  if (command.kind === "commitment") {
    return routeCommitment(deps, input, command.token);
  }

  // F-040 — the farmer product keywords, still upstream of any model call. Neither grants
  // anything: SIGNUP opens a queue entry VIGA acts on, and LINK is refused unless the sender
  // is ALREADY an authorized farmer.
  if (command.kind === "farmer") {
    return routeFarmerKeyword(deps, input, command.keyword);
  }

  // STEP 4 — and only now may a model run.
  const handled = await deps.freeText({
    senderHash: input.senderHash,
    taskText: body,
    providerEventId: input.providerEventId,
    inboxEventId: input.inboxEventId,
  });
  return {
    outcome: { kind: "free_text", handled: handled.handled },
    replies: handled.replies,
  };
}

async function routeCompliance(
  deps: RouteDeps,
  input: RouteInput,
  keyword: ComplianceKeyword,
): Promise<RouteResult> {
  const autoResponse = complianceAutoResponse(keyword);

  if (keyword === "FLAG") {
    // The human-handoff safety rail: a durable review item, upstream of any model call.
    const inserted = await deps.db.sql`
      insert into flags (contact_hash, inbox_event_id, reason_code, status, created_at)
      values (
        ${input.senderHash}, ${input.inboxEventId}, 'sender_flagged', 'open',
        ${input.occurredAt}
      )
      returning id
    `;
    return {
      outcome: { kind: "flag", flagId: inserted[0]?.id as string },
      replies: [
        {
          body: FLAG_ACKNOWLEDGEMENT,
          // Answering the sender's own message, so it rides on that message.
          category: "required_reply",
          logicalKey: `flag-ack-${input.providerEventId}`,
        },
      ],
    };
  }

  // B-011: JOIN may establish consent only for a first-time sender, because only START
  // clears the carrier's own opt-out list.
  //
  // The record check does NOT happen here. `consentTransitionFor` is pure and cannot see
  // stored state, and a read in this function followed by a write would be a race — two
  // concurrent JOINs could both observe "no record" and both enroll. So this asks for the
  // transition as if unconditional, and `applyConsentTransition` enforces the first-time
  // rule inside the `for update` lock that already serializes these commands.
  const firstTimeOnly = keyword === "JOIN";
  const transition = consentTransitionFor(keyword, null);

  if (transition === null) {
    // HELP/INFO: an answer is owed, but consent is untouched — asking for help is not
    // opting in, and the registered help copy is what the carrier approved.
    return {
      outcome: { kind: "help" },
      replies: autoResponse
        ? [
            {
              body: autoResponse,
              category: "required_reply",
              logicalKey: `help-${input.providerEventId}`,
            },
          ]
        : [],
    };
  }

  // STOP/START/JOIN apply on their OWN provider-time watermark, independent of conversation
  // ordering: an older delayed START can never undo a newer STOP, and STOP wins an exact tie.
  const applied = await applyConsentTransition(deps.db, {
    recipientHash: input.senderHash,
    transition: transition.transition,
    occurredAt: input.occurredAt,
    providerEventId: input.providerEventId,
    ...(transition.captureSource !== undefined
      ? { captureSource: transition.captureSource }
      : {}),
    ...(firstTimeOnly ? { firstTimeOnly: true } : {}),
  });

  // B-011: a JOIN refused because a record already exists gets told the word that actually
  // works. Keyed on the explicit refusal reason, NOT on `!applied` — a JOIN refused by the
  // watermark (an older event arriving late) is not a returning farmer, and answering it
  // with "reply START" would be a non-sequitur.
  const replyBody =
    applied.refusal === "already_enrolled" ? ALREADY_JOINED_RESPONSE : autoResponse;

  return {
    outcome: {
      kind: "consent",
      transition: transition.transition,
      applied: applied.applied,
    },
    replies: replyBody
      ? [
          {
            body: replyBody,
            // `required_reply` is the one category STOP itself cannot suppress — otherwise
            // the carrier-required opt-out confirmation could never be delivered. It is also
            // what lets the already-joined answer go out to a `stopped` sender.
            category: "required_reply",
            logicalKey: `consent-${input.providerEventId}`,
          },
        ]
      : [],
  };
}

/**
 * The farmer product keywords (F-040), handled deterministically and upstream of the model.
 *
 * **Neither keyword grants anything**, and that is the property to preserve if this is ever
 * extended:
 *
 *   - `SIGNUP` writes a row in a table with no grant column. VIGA always approves, because a
 *     phone proves possession of a phone rather than ownership of a farm. The reply says the
 *     ask was passed on, and deliberately does not read as a yes.
 *   - `LINK` mints a standing link ONLY for a sender who is already an authorized farmer.
 *     A stranger texting LINK gets the same nothing they started with — the authorization is
 *     the gate, and this path cannot create one.
 *
 * The link reply is `inventory_prompt`, a proactive category: Farm Friend is handing over a
 * durable credential, so it rides on the same consent gate as every other proactive message
 * rather than on the inbound message that asked for it.
 */
async function routeFarmerKeyword(
  deps: RouteDeps,
  input: RouteInput,
  keyword: FarmerKeyword,
): Promise<RouteResult> {
  if (keyword === "SIGNUP") {
    const opened = await openFarmerOnboardingRequest(deps.db, {
      contactHash: input.senderHash,
      occurredAt: input.occurredAt,
    });

    // The same acknowledgement either way. A farmer who texts twice because nothing visibly
    // happened is told the same true thing, and the reply never reveals queue state.
    return {
      outcome: { kind: "farmer", keyword, status: opened.status },
      replies: [
        {
          body: FARMER_ONBOARDING_REQUEST_ACKNOWLEDGEMENT,
          // Answering the sender's own message, so it rides on that message.
          category: "required_reply",
          logicalKey: `signup-ack-${input.providerEventId}`,
        },
      ],
    };
  }

  // LINK. The authorization is the gate: this resolves the sender's OWN live authorization
  // and refuses if there is none. Nothing here can create one.
  const authorization = await findLiveFarmerAuthorization(deps.db, input.senderHash);
  if (authorization === null) {
    // Not an authorized farmer. Answered with the signup path rather than silence, because
    // a farmer who texts LINK before being set up is asking the right question at the wrong
    // time — and a customer who texts it learns nothing about who is authorized.
    return {
      outcome: { kind: "farmer", keyword, status: "not_authorized" },
      replies: [
        {
          body: FARMER_ONBOARDING_REQUEST_ACKNOWLEDGEMENT,
          category: "required_reply",
          logicalKey: `link-refused-${input.providerEventId}`,
        },
      ],
    };
  }

  const issued = await issueFarmerLink(deps.db, {
    authorizationId: authorization.authorizationId,
    occurredAt: input.occurredAt,
  });
  if (issued.status !== "issued") {
    // The authorization was revoked between the read and the write. Nothing was minted.
    return {
      outcome: { kind: "farmer", keyword, status: issued.status },
      replies: [],
    };
  }

  return {
    outcome: { kind: "farmer", keyword, status: "issued" },
    replies: [
      {
        body: renderFarmerLinkMessage(
          farmerLinkUrl(deps.publicBaseUrl, issued.token),
        ),
        // Proactive: this hands over a durable credential, so it rides on the standing
        // consent gate rather than on the inbound message that asked for it.
        category: "inventory_prompt",
        // Bound to the LINK row, so a replayed inbound event reuses the outbox row rather
        // than texting a second credential.
        logicalKey: `farmer-link-${input.providerEventId}`,
      },
    ],
  };
}

/** The sender's own live authorization, or null. Code's decision, never a model's. */
async function findLiveFarmerAuthorization(
  db: Db,
  senderHash: string,
): Promise<{ authorizationId: string } | null> {
  const rows = await db.sql`
    select auth.id
    from farmer_authorizations as auth
    join contacts as contact on contact.id = auth.contact_id
    where contact.phone_hash = ${senderHash} and auth.revoked_at is null
    order by auth.authorized_at asc
  `;
  // A sender authorized for several farms is not guessed at: which farm a link opens decides
  // whose listing a holder can change. `resolveFarmerLink` refuses a multi-stand farm for the
  // same reason, one layer down.
  if (rows.length !== 1) return null;
  return { authorizationId: rows[0]?.id as string };
}

async function routeCommitment(
  deps: RouteDeps,
  input: RouteInput,
  token: "YES" | "NO",
): Promise<RouteResult> {
  // A commitment token is meaningful ONLY against the sender's one open proposal. It is
  // never global: with nothing open there is nothing to commit, and the token must not be
  // reinterpreted as inventory text or an inquiry.
  const open = await deps.db.sql`
    select id from inventory_publication_proposals
    where sender_hash = ${input.senderHash} and state = 'open'
  `;
  const proposalId = open[0]?.id as string | undefined;

  if (!proposalId) {
    return {
      outcome: { kind: "confirmation", status: "no_open_proposal" },
      replies: [],
    };
  }

  // The transaction re-reads version, activation, expiry, base revision, farmer authority
  // and VIGA approval under lock, and consumes the proposal exactly once. A token that
  // predates its current prompt is refused THERE, not here.
  const result = await confirmInventoryPublication(deps.db, {
    proposalId,
    senderHash: input.senderHash,
    token: token === "YES" ? "yes" : "no",
    occurredAt: input.occurredAt,
    providerEventId: input.providerEventId,
    clock: deps.clock,
  });

  // `published` and `declined` queue their own confirmation replies inside that
  // transaction, committed atomically with the state they describe. Every other status is a
  // refusal to commit, and the sender is told to resend rather than left silent.
  const replies: RoutedReply[] =
    result.status === "published" || result.status === "declined"
      ? []
      : [
          {
            body: renderClarificationRequest(),
            category: "inquiry_reply",
            logicalKey: `confirm-${result.status}-${input.providerEventId}`,
          },
        ];

  return {
    outcome: { kind: "confirmation", status: result.status },
    replies,
  };
}
