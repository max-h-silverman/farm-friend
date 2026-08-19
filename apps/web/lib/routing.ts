import {
  CONSENT_INVITATION_REPLY,
  requiresConsentBeforeAnswering,
  shouldInviteToConsent,
  type ConsentState,
  parseCommand,
  consentTransitionFor,
  ALREADY_JOINED_RESPONSE,
  FARMER_ONBOARDING_REQUEST_ACKNOWLEDGEMENT,
  renderContactCardOffer,
  CUSTOMER_WELCOME,
  REGISTERED_HELP_AUTO_RESPONSE,
  renderHelpGuide,
  ISSUE_REPORT_FILED,
  ISSUE_REPORT_FILED_WITH_REPLY,
  hashEmail,
  JOIN_OPT_IN_AUTO_RESPONSE,
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
  hasLiveFarmerAuthorization,
  readPendingIssueReport,
  clearPendingIssueReport,
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
//   1. compliance keywords   — STOP/START/VIGA/JOIN/HELP/INFO, by CODE, before any model call
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
  /**
   * F-121 — the sender has no active consent, so nothing substantive was answered.
   * `invited` is false for a sender who opted out: they are gated AND left alone.
   */
  | { kind: "consent_required"; invited: boolean }
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
   * The salt the reporter's email hash is derived under (B-091).
   *
   * Injected rather than read from the environment here, like every other configured value on
   * this interface: `EMAIL_HASH_SALT` must be the same salt `seller_emails` was hashed under,
   * and a module reading it directly would be a second place for that agreement to break.
   *
   * OPTIONAL because the worker — which runs the inbound pass — deliberately does not mount
   * it. With no salt an address is refused rather than stored without its lookup key.
   */
  emailSalt?: string;
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
  /**
   * The host's answer to "do you host her?" (F-117).
   *
   * Injected like every other seam so routing states the ORDER and the writer states the rule.
   * `no_open_question` is the fall-through: nothing open, or the question is no longer the last
   * message in the thread.
   */
  hostConfirmation(input: {
    senderHash: string;
    token: "YES" | "NO";
    occurredAt: Date;
  }): Promise<{ status: "confirmed" | "denied" | "no_open_question" }>;
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
      return JOIN_OPT_IN_AUTO_RESPONSE;
    case "START":
    case "VIGA":
      // Telnyx owns the start-operation receipt. Farm Friend supplies the distinct listing-live
      // completion only after redemption succeeds.
      return null;
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
 *     `consent_transition_watermarks`, an independent watermark where an older start operation can
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

  /*
    Everything below either mutates conversation state or answers the sender, so a stale event
    fails closed HERE — above the consent gate as well (F-121). A stale event must produce no
    reply at all, and an invitation is a reply; checking consent first would answer a message
    that is not supposed to be answered, and would spend a database read doing it.
  */
  if (input.isStale === true) {
    return {
      outcome: { kind: "stale", failureCode: "stale_conversation_event" },
      replies: [],
    };
  }

  /*
    F-121 — THE CONSENT GATE. Farm Friend answers nothing substantive until the sender agreed.

    max, 2026-08-18: a sender with no consent record gets ONE invitation and nothing else — the
    invitation instead of the answer, not appended to it.

    **Its POSITION is the exemption list.** Everything routed above it is a carrier-registered
    compliance keyword — the opt-out list, `JOIN`/`START`/`VIGA`, and `HELP`/`INFO` — so they
    keep working without this gate naming them. Nothing has to remember to exclude a keyword;
    the order does it. The staleness guard also sits above, so a stale event still replies
    nothing rather than being invited.

    Two that must stay above it, because forgetting either dead-ends a real journey:
      - `VIGA` completes farmer onboarding from a handset with no consent row yet. Gated, the
        farmer is told to reply `JOIN`, which can never complete onboarding.
      - Every `STOP` synonym must reach the opt-out writer rather than an invitation.

    Everything BELOW gates, deliberately including `MAP` (max named it): the map is a service
    Farm Friend provides, not a control for joining or leaving. `MAP` therefore MOVED below this
    gate — it used to sit above the staleness check so a delayed carrier event still returned a
    link, and that exemption does not survive a rule that says an unconsented sender is served
    nothing. `YES`/`NO`, the farmer keywords,
    `MORE`, a stand menu number and all free text gate too — so no model runs for a sender who
    has not agreed, which is a stricter guarantee than the routing order alone gave.

    A STOPPED sender is gated and receives NOTHING. Dispatch would suppress their reply anyway,
    and queuing an opt-in pitch at someone who texted `STOP` is what `STOP` exists to end.
  */
  const consent = await deps.db.sql`
    select state from sms_consents where recipient_hash = ${input.senderHash}
  `;
  const consentRecord = consent[0]
    ? { state: consent[0].state as ConsentState }
    : null;
  if (requiresConsentBeforeAnswering(consentRecord)) {
    return {
      outcome: { kind: "consent_required", invited: shouldInviteToConsent(consentRecord) },
      replies: shouldInviteToConsent(consentRecord)
        ? [{
            body: CONSENT_INVITATION_REPLY,
            // Answering the sender's OWN inbound message, so it rides on that message rather
            // than on a standing consent basis — which is the only reason a message to someone
            // with no consent record can be sent at all.
            category: "inquiry_reply",
            logicalKey: `consent-invite-${input.providerEventId}`,
          }]
        : [],
    };
  }

  // F-057. MAP returns only the configured canonical URL — configuration, never model or
  // sender data. Ordered after every compliance command, so a STOP always records the opt-out
  // first, and now after the consent gate too (F-121): the map is a service, not a consent
  // control, so a sender who has not agreed is invited rather than handed a link.
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

  if (command.kind === "commitment") {
    return routeCommitment(deps, input, command.token, command.email);
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
    /*
      HELP/INFO: an answer is owed, but consent is untouched — asking for help is not opting
      in, and the registered help copy is what the carrier approved.

      TWO messages, deliberately (B-091). The registered body is transcribed from live Telnyx
      console state and must stay byte-identical, so the guidance a sender can actually act on
      cannot be concatenated onto it — it rides as its own ordinary reply. Both are
      `required_reply`: HELP is answered for every sender, including one who has opted out.

      The audience is resolved from `farmer_authorizations`, the same source the free-text
      access fork reads. A farmer and a customer have different interfaces, and a list of words
      that do nothing for the reader is worse than a shorter list. A failed lookup is answered
      as a customer: that is the larger audience and the words it teaches are the ones anyone
      may use, so the wrong guess costs a farmer a line rather than misleading a customer.
    */
    const isFarmer = await hasLiveFarmerAuthorization(deps.db, {
      senderHash: input.senderHash,
      occurredAt: input.occurredAt,
    }).catch(() => false);

    return {
      outcome: { kind: "help" },
      replies: [
        ...(autoResponse
          ? [
              {
                body: autoResponse,
                category: "required_reply" as const,
                logicalKey: `help-${input.providerEventId}`,
              },
            ]
          : []),
        {
          body: renderHelpGuide(isFarmer ? "farmer" : "customer"),
          category: "required_reply" as const,
          logicalKey: `help-guide-${input.providerEventId}`,
        },
      ],
    };
  }

  // STOP/START/VIGA/JOIN apply on their OWN provider-time watermark, independent of conversation
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
    keyword === "START" || keyword === "VIGA"
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
          // nothing.
          //
          // AND NOTHING ELSE (max, 2026-08-12). This farmer is waiting on a person, so no
          // keyword reaches their problem; an instruction here would be an errand that cannot
          // succeed, handed to someone who already did what the form asked. A second message
          // naming a word used to ship beside this one — see the note in `onboarding-copy.ts`
          // where it was deleted (B-043).
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

    An `inquiry_reply`, riding on the sender's own inbound JOIN/START/VIGA — it creates no
    consent and asks for nothing, and saving a contact is device-local. STOP still suppresses
    it, which is correct: someone opting out has no use for our number.

    **VIGA belongs here and was missing.** F-100 made VIGA the word the onboarding form tells a
    farmer to text, and taught it to the redemption branch above — but not to this condition,
    which still listed the two words that predated it. So the farmer with the MOST use for a
    saved contact, the one about to receive scheduled prompts and stock-out alerts for months,
    was the only sender who never got the offer. Every keyword that establishes messaging must
    appear here.
  */
  const contactCardReply =
    (keyword === "JOIN" || keyword === "START" || keyword === "VIGA") && applied.applied
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


/**
 * Commit a pending issue report on the sender's `YES`, or release it on `NO` (B-091).
 *
 * **This is where the model's recognition becomes durable state, and code does it — not the
 * model** (Golden Rule #3). The classifier only ever produced a question; the row it left
 * behind is inert until a human confirms it here.
 *
 * The flag it files is the SAME insert `FLAG` uses, into the same queue, with the same
 * `open` status — a different `reason_code` is the only difference, and it records how the
 * item arrived rather than changing what it is. VIGA reads one review queue.
 *
 * Returns null when the sender has no pending report, so the caller falls through to its
 * ordinary "nothing open" answer.
 */
async function fileConfirmedIssueReport(
  deps: RouteDeps,
  input: RouteInput,
  token: "YES" | "NO",
  reporterEmail?: string,
): Promise<RouteResult | null> {
  const pending = await readPendingIssueReport(deps.db, {
    senderHash: input.senderHash,
    occurredAt: input.occurredAt,
  });
  if (pending === null) return null;

  // Cleared on BOTH arms. A declined report that stayed open would make the sender's next
  // unrelated YES file an issue they had already said no to.
  await clearPendingIssueReport(deps.db, { senderHash: input.senderHash });

  if (token === "NO") {
    return { outcome: { kind: "confirmation", status: "issue_report_declined" }, replies: [] };
  }

  /*
    The flag points at the event the REPORT arrived on, not at this bare `YES`. A coordinator
    opening the thread needs the sentence describing the problem; the confirmation carries no
    information on its own.
  */
  /*
    The address, when the reporter offered one (B-091). Hashed HERE rather than by the caller,
    because the raw value and its key must be written in one statement — the CHECK requires
    both columns or neither, so a hash computed somewhere else is a second place for them to
    come apart.

    Already normalized by `parseCommand`, which is what admitted the grammar at all.
  */
  const salt = deps.emailSalt;
  const storedEmail = reporterEmail !== undefined && salt !== undefined ? reporterEmail : null;
  const emailHash = storedEmail === null ? null : hashEmail(storedEmail, salt!);

  const inserted = await deps.db.sql`
    insert into flags (
      contact_hash, inbox_event_id, reason_code, status, created_at,
      reporter_email, reporter_email_hash
    )
    values (
      ${input.senderHash}, ${pending.inboxEventId}, 'issue_reported', 'open',
      ${input.occurredAt}, ${storedEmail}, ${emailHash}
    )
    returning id
  `;

  return {
    outcome: { kind: "flag", flagId: inserted[0]?.id as string },
    replies: [
      {
        // Says back what was actually recorded. A reporter who gave an address and is told
        // only "a coordinator will review this" has no way to know it landed — and the
        // address is precisely the thing they would want confirmed.
        // Promises a reply only when one is actually possible: an address the deployment
        // cannot hash was not kept, and saying otherwise would be a promise nobody can honour.
        body: storedEmail === null ? ISSUE_REPORT_FILED : ISSUE_REPORT_FILED_WITH_REPLY,
        // Answering the sender's own message, so it rides on that message.
        category: "required_reply",
        logicalKey: `issue-filed-${input.providerEventId}`,
      },
    ],
  };
}

async function routeCommitment(
  deps: RouteDeps,
  input: RouteInput,
  token: "YES" | "NO",
  reporterEmail?: string,
): Promise<RouteResult> {
  /*
    F-117 — THE HOST'S QUESTION FIRST.

    A host answering "do you host her?" and a seller answering "publish this?" both text `YES`,
    so the order has to be decided here rather than left to whichever query runs first.

    The host question is asked first because it can only be open when it is the LAST message in
    that thread — an inventory prompt to the same handset is exactly the traffic that closes it.
    So an open host question means the host question is the live one, and there is no case where
    both are genuinely open at once.
  */
  const host = await deps.hostConfirmation({
    senderHash: input.senderHash,
    token,
    occurredAt: input.occurredAt,
  });
  if (host.status !== "no_open_question") {
    return {
      outcome: { kind: "confirmation", status: host.status },
      replies: [],
    };
  }

  // A commitment token is meaningful ONLY against the sender's one open proposal. It is
  // never global: with nothing open there is nothing to commit, and the token must not be
  // reinterpreted as inventory text or an inquiry.
  const open = await deps.db.sql`
    select id from inventory_publication_proposals
    where sender_hash = ${input.senderHash} and state = 'open'
  `;
  const proposalId = open[0]?.id as string | undefined;

  if (!proposalId) {
    /*
      B-091 — THE ISSUE CONFIRMATION IS LAST, and losing is what makes it safe.

      Three things now mean `YES`: a host answering "do you host her?", a seller publishing an
      inventory update, and a sender confirming we should pass an issue to VIGA. The first two
      are consequential — they change what the island reads — so the third is only consulted
      when NEITHER is open. A sender with a live proposal who texts YES publishes their
      inventory, exactly as before; the issue question waits, and its `or tell us more` arm is
      the way back to it.

      Nothing here is reinterpreted from the token: with nothing open at all, `YES` still means
      nothing, and the sender falls through to the same `no_open_proposal` answer.
    */
    const filed = await fileConfirmedIssueReport(deps, input, token, reporterEmail);
    if (filed !== null) return filed;

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
