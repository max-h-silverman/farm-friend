import {
  parseCommand,
  consentTransitionFor,
  ALREADY_JOINED_RESPONSE,
  FARMER_ONBOARDING_REQUEST_ACKNOWLEDGEMENT,
  renderContactCardOffer,
  CUSTOMER_WELCOME,
  REGISTERED_HELP_AUTO_RESPONSE,
  REGISTERED_OPT_IN_AUTO_RESPONSE,
  REGISTERED_OPT_OUT_AUTO_RESPONSE,
  renderClarificationRequest,
  renderPublicStringRefusal,
  invitedJoinReplyBodies,
  type Clock,
  type ComplianceKeyword,
  type FarmerKeyword,
  type LaunchMessageCategory,
} from "@farm-friend/core";
import {
  applyConsentTransition,
  confirmInventoryPublication,
  openFarmerOnboardingRequest,
  type Db,
} from "@farm-friend/db";
import type { PagingStatus } from "./paging";

// Deterministic inbound routing (F-023, docs/ARCHITECTURE.md §"Deterministic routing").
//
// This module is the composition that was missing: every handler below already existed and
// was proven, and nothing called any of them. It adds NO new mechanism — it decides, in one
// small fixed order, which existing handler owns a claimed inbound event.
//
// The order is Golden Rule #2 and is not negotiable:
//
//   1. compliance keywords   — STOP/START/JOIN/HELP/INFO, by CODE, before any model call
//   2. MAP                   — configured public-map URL, no state or model
//   3. FLAG                  — the human-handoff safety rail, also upstream of the model
//   4. commitment YES/NO     — context- and version-bound to the sender's ONE open proposal
//   5. SAME                  — only the exact active scheduled full-snapshot subject
//   6. farmer keywords       — LINK/STAND/SETTINGS, upstream of the model
//   7. MORE                  — the next page of the sender's pending result list (F-046)
//   8. stand menu number     — exact server-bound authorization+location selection
//   9. free text             — only here may a model seam run
//
// Steps 1-7 are `parseCommand` output, which takes the body and NOTHING else: no
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
  | { kind: "map" }
  | { kind: "flag"; flagId: string }
  | { kind: "confirmation"; status: string }
  /**
   * A farmer product keyword (F-040). `status` says what became of it — an onboarding
   * request opened or already open, a link issued, or a refusal for a sender who is not an
   * authorized farmer.
   */
  | { kind: "farmer"; keyword: FarmerKeyword; status: string }
  | { kind: "stand_selection"; status: string }
  /**
   * A `MORE` (F-046). `paged` served the next page of the sender's pending list;
   * `no_pending_list` is the honest reply when there is nothing to page — never asked,
   * expired, or exhausted.
   */
  | { kind: "paging"; status: PagingStatus }
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
  /** The validated canonical URL returned by the stateless MAP command. */
  publicMapUrl: string;
  /**
   * Handle a message that is NOT any deterministic keyword or token. Invoked only after
   * `parseCommand` returns `kind: "none"`; this is the only path on which a model may run.
   */
  freeText(input: {
    senderHash: string;
    taskText: string;
    providerEventId: string;
    inboxEventId: string;
    occurredAt: Date;
  }): Promise<{ replies: RoutedReply[]; handled: "farmer" | "customer" | "none" }>;
  /**
   * Serve the next page of the sender's pending result list (F-046).
   *
   * A callback for the same reason `freeText` is one — this module owns the deterministic
   * ORDER and nothing else, so retrieval and rendering stay outside it. Unlike `freeText`,
   * the handler behind this one takes no model dependency at all: `MORE` is code end to end.
   */
  nextPage(input: {
    senderHash: string;
    occurredAt: Date;
  }): Promise<{ body: string; status: PagingStatus }>;
  /** Handle LINK/STAND/SETTINGS with deterministic, code-owned target resolution. */
  farmerTarget(input: {
    senderHash: string;
    keyword: "LINK" | "STAND" | "SETTINGS";
    occurredAt: Date;
    providerEventId: string;
  }): Promise<{ replies: RoutedReply[]; status: string }>;
  /** Consume one context-bound stand menu number. No model dependency belongs here. */
  selectStand(input: {
    senderHash: string;
    optionNumber: number;
    occurredAt: Date;
    providerEventId: string;
  }): Promise<{ replies: RoutedReply[]; status: string }>;
  /** Confirm only the exact active typed scheduled snapshot. No model dependency belongs here. */
  scheduledSame(input: {
    senderHash: string;
    occurredAt: Date;
    providerEventId: string;
  }): Promise<{ replies: RoutedReply[]; status: string }>;
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

  // STEP 1-4 — deterministic parsing, before any model call.
  const command = parseCommand(body);

  // Compliance keywords are exempt from conversation staleness (see the contract above) and
  // are therefore checked BEFORE it — the ordering that makes a delayed STOP reach consent.
  if (command.kind === "compliance") {
    return routeCompliance(deps, input, command.keyword);
  }

  // F-057. MAP has no conversation state to corrupt, so like compliance it remains useful
  // for a delayed carrier event. It is still ordered after every compliance command: a STOP
  // always records the opt-out, and dispatch will suppress this inquiry reply for a stopped
  // sender. The body is configuration, never model or sender data.
  if (command.kind === "map") {
    return {
      outcome: { kind: "map" },
      replies: [{
        body: deps.publicMapUrl,
        category: "inquiry_reply",
        logicalKey: `map-${input.providerEventId}`,
      }],
    };
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

  if (command.kind === "scheduled_same") {
    const confirmed = await deps.scheduledSame({
      senderHash: input.senderHash,
      occurredAt: input.occurredAt,
      providerEventId: input.providerEventId,
    });
    return {
      outcome: { kind: "confirmation", status: confirmed.status },
      replies: confirmed.replies,
    };
  }

  // F-040 — the farmer keywords, still upstream of any model call. None grants anything by
  // itself: LINK/STAND/SETTINGS are refused unless the sender is ALREADY an authorized farmer.
  //
  // `JOIN <token>` used to be handled here. It is gone (max 2026-08-07) — onboarding completes
  // with a bare `START`, which `routeCompliance` owns. That keeps the invited path to ONE
  // consent writer, as it always had, but the branch that owns it moved.
  if (command.kind === "farmer") {
    const targeted = await deps.farmerTarget({
      senderHash: input.senderHash,
      keyword: command.keyword,
      occurredAt: input.occurredAt,
      providerEventId: input.providerEventId,
    });
    return {
      outcome: { kind: "farmer", keyword: command.keyword, status: targeted.status },
      replies: targeted.replies,
    };
  }

  // F-046 — MORE. Ordered AFTER the compliance keywords and the commitment tokens, which is
  // what makes "paging can never shadow an opt-out" structural: reaching here means the
  // message matched neither. It is still upstream of the model, and the handler behind it has
  // no model to reach.
  //
  // Deliberately does NOT touch the sender's open confirmation (max, 2026-07-31). A farmer
  // with a proposal open can page and keep it; the two are different words with no overlap,
  // so blocking either would solve a collision that does not exist.
  if (command.kind === "paging") {
    const page = await deps.nextPage({
      senderHash: input.senderHash,
      occurredAt: input.occurredAt,
    });
    return {
      outcome: { kind: "paging", status: page.status },
      replies: [
        {
          body: page.body,
          // Answering the customer's own message, so it rides on that message rather than on
          // a standing consent basis.
          category: "inquiry_reply",
          logicalKey: `paging-${input.providerEventId}`,
        },
      ],
    };
  }

  if (command.kind === "stand_selection") {
    const selected = await deps.selectStand({
      senderHash: input.senderHash,
      optionNumber: command.optionNumber,
      occurredAt: input.occurredAt,
      providerEventId: input.providerEventId,
    });
    return {
      outcome: { kind: "stand_selection", status: selected.status },
      replies: selected.replies,
    };
  }

  // STEP 6 — and only now may a model run.
  const handled = await deps.freeText({
    senderHash: input.senderHash,
    taskText: body,
    providerEventId: input.providerEventId,
    inboxEventId: input.inboxEventId,
    occurredAt: input.occurredAt,
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

  /*
    START COMPLETES ONBOARDING when an invitation is waiting for this handset.

    This replaces `JOIN <token>` (max 2026-08-07): the farm identity now travels on the
    onboarding form as a stated phone rather than in the message body, so the farmer's message
    is one carrier-registered word with nothing to copy.

    **Attempted AFTER the consent write above, never instead of it.** `START` is the carrier's
    own keyword and its consent effect is unconditional — a farmer whose invitation has already
    been spent, or who never had one, must still be enrolled and unblocked by it. Ordering it
    second is what keeps this a redemption bolted onto `START` rather than a second meaning for
    the word.

    **Only for `START`, never for bare `JOIN`.** JOIN cannot clear the carrier's own opt-out
    list (B-011), so completing onboarding on it would set a farmer up whose messages the
    carrier silently refuses — the dead end that rule exists to close.

    The match is by sender HASH against unredeemed invitations. A sender with no invitation
    gets `invalid_invitation` and nothing happens, which is the ordinary case for every
    customer who ever texts START.
  */
  const redeemed =
    keyword === "START"
      ? await openFarmerOnboardingRequest(deps.db, {
          contactHash: input.senderHash,
          occurredAt: input.occurredAt,
          pendingPhoneHash: input.senderHash,
          providerEventId: input.providerEventId,
          publicBaseUrl: deps.publicBaseUrl,
        })
      : { status: "invalid_invitation" as const };

  // B-011: a JOIN refused because a record already exists gets told the word that actually
  // works. Keyed on the explicit refusal reason, NOT on `!applied` — a JOIN refused by the
  // watermark (an older event arriving late) is not a returning farmer, and answering it
  // with "reply START" would be a non-sequitur.
  const replyBody =
    applied.refusal === "already_enrolled" ? ALREADY_JOINED_RESPONSE : autoResponse;

  /*
    WHICH follow-up the sender gets, and why a farmer must not get the customer welcome.

    The customer welcome points at the public map — the right thing for a stranger who just
    opted in, and the wrong thing for a farmer who just finished onboarding, whose next step is
    their own stand. So a completed redemption replaces it rather than adding to it.

    THREE cases, not two (B-043). A redemption that opened a request but authorized NOBODY —
    an invitation whose SMS agreement was never ticked, or one naming no farm — used to fall
    through to the customer welcome, or to nothing at all. That farmer did exactly what the
    onboarding form told them to do and received only the carrier opt-in receipt: a compliance
    notice saying nothing about their farm, with no acknowledgement and no sign anyone would
    act. A farmer who tries once and hears nothing does not try again.

    They are waiting on a coordinator, which is CORRECT — a missing tick means no informed
    opt-in, and authorizing on it would set someone up for messages they never agreed to. The
    defect was never telling them so.
  */
  const onboarded = redeemed.status === "opened" && redeemed.authorizationId !== null;
  const awaitingCoordinator = redeemed.status === "opened" && redeemed.authorizationId === null;
  const welcomeReply = onboarded
    ? invitedJoinReplyBodies({
        consentEstablished: redeemed.status === "opened" && redeemed.consentEstablished,
        hadConsent: redeemed.status === "opened" && redeemed.hadConsentRecord,
        authorized: true,
      }).map((body, index) => ({
        body,
        category: "required_reply" as const,
        logicalKey: `farmer-onboarded-${index}-${input.providerEventId}`,
      }))
    : awaitingCoordinator
      ? [{
          // The one honest thing to say: VIGA has the request and will be in touch. It claims
          // no outcome, which is exactly why this copy already exists — a request grants
          // nothing. `FARMER_JOIN_INSTRUCTION` is deliberately NOT used here: it says "to get
          // texts about your farm, reply START" to a sender who just texted START.
          body: FARMER_ONBOARDING_REQUEST_ACKNOWLEDGEMENT,
          category: "required_reply" as const,
          logicalKey: `farmer-awaiting-${input.providerEventId}`,
        }]
      : (keyword === "JOIN" || keyword === "START") && applied.applied
        ? [{
            body: CUSTOMER_WELCOME,
            category: "inquiry_reply" as const,
            logicalKey: `customer-welcome-${input.providerEventId}`,
          }]
        : [];

  /*
    THE CONTACT CARD, as its own message (max 2026-08-08).

    It used to be a trailing fragment on the customer welcome — "Save us:" and a raw API path,
    after the opt-out instruction — where it read as plumbing rather than an offer.

    Sent to EVERYONE this message establishes or restores messaging for, farmer and customer
    alike. The farmer needs it more, if anything: the scheduled prompts and stock-out alerts
    they will get for months all arrive from an unnamed number otherwise.

    An `inquiry_reply`, riding on the sender's own inbound JOIN/START — it creates no consent
    and asks for nothing, and saving a contact is device-local. STOP still suppresses it, which
    is correct: someone opting out has no use for our number.
  */
  const contactCardReply =
    (keyword === "JOIN" || keyword === "START") && applied.applied
      ? [{
          body: renderContactCardOffer(deps.publicBaseUrl),
          category: "inquiry_reply" as const,
          logicalKey: `contact-card-${input.providerEventId}`,
        }]
      : [];

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
          ...welcomeReply,
          ...contactCardReply,
        ]
      : [...welcomeReply, ...contactCardReply],
  };
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
            body:
              result.status === "unsafe_public_text"
                ? renderPublicStringRefusal(result.prohibited)
                : renderClarificationRequest(),
            category: "inquiry_reply",
            logicalKey: `confirm-${result.status}-${input.providerEventId}`,
          },
        ];

  return {
    outcome: { kind: "confirmation", status: result.status },
    replies,
  };
}
