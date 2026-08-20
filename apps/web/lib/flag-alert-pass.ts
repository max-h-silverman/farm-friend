import type { EmailDispatchOutcome } from "@farm-friend/core";
import type { Db, FlagAlertRow } from "@farm-friend/db";

/**
 * F-123 — email VIGA when a `FLAG` or a texted issue report arrives.
 *
 * **Why a scheduled pass rather than a send at the moment the flag is written.** The flag is
 * created inside the SMS webhook, which must answer the carrier fast; a slow or unreachable mail
 * server there would delay a farmer's reply or a customer's answer. The cron route already owns
 * this shape — "a new scheduled job adds its call below, one mechanism, not a second cron surface
 * per job" — so the alert lands within a minute and never sits in the request path.
 *
 * **One email per flag** (max, 2026-08-19), not a digest: a single alert is easy to overlook
 * inside a batch, and this is a safety rail.
 *
 * **The claim is the once-only guarantee, and it is the database's.** `claimFlagsToAlert` marks
 * and returns in one statement, so concurrent passes cannot both take one flag. This module owns
 * only what happens after: send, then either commit the claim or release it.
 *
 * **A failed send releases the flag.** An alert lost to one hiccup is precisely the failure this
 * feature exists to prevent, so the flag returns to the queue and the next pass retries. The
 * reverse ordering — mark, then send — would lose the alert instead.
 */

/** What the pass needs, all injected, so the sending seam is testable without a mail server. */
export interface FlagAlertPassDeps {
  db: Db;
  clock: { now: () => Date };
  /**
   * Where alerts go. **Configuration, never a literal** — a hard-coded address is one nobody can
   * change without a deploy, and VIGA's operator address is theirs to decide.
   */
  recipient: string | undefined;
  /** Where the operator goes to read it. The email never restates the message itself. */
  consoleUrl: string;
  claim: (db: Db, input: { limit: number }) => Promise<FlagAlertRow[]>;
  markAlerted: (db: Db, input: { flagId: string; occurredAt: Date }) => Promise<void>;
  releaseClaim: (db: Db, input: { flagId: string }) => Promise<void>;
  /**
   * The mail seam, or `null` when this deployment has no email configured.
   *
   * Null rather than a throwing stub: an unconfigured deployment is SUPPORTED (F-078), and the
   * pass must then claim nothing at all — claiming would mark flags alerted that were never sent.
   */
  send:
    | ((input: {
        toEmail: string;
        subject: string;
        text: string;
        idempotencyKey: string;
      }) => Promise<EmailDispatchOutcome>)
    | null;
}

export interface FlagAlertPassResult {
  sent: number;
  failed: number;
}

/** How many alerts one pass will send, so a backlog cannot become an unbounded mail run. */
const MAX_ALERTS_PER_PASS = 25;

/**
 * What kind of alert this is, in words.
 *
 * `sender_flagged` and `issue_reported` are storage vocabulary; a volunteer reading an inbox on a
 * phone needs the subject line to say what happened. An unknown code falls back to the neutral
 * wording rather than printing the code itself.
 */
function describeReason(reasonCode: string): { subject: string; opening: string } {
  if (reasonCode === "issue_reported") {
    return {
      subject: "Farm Friend: someone reported an issue",
      opening: "Someone texted Farm Friend to report an issue.",
    };
  }
  if (reasonCode === "sender_flagged") {
    return {
      subject: "Farm Friend: someone asked for a person (FLAG)",
      opening: "Someone texted FLAG to ask for a person.",
    };
  }
  return {
    subject: "Farm Friend: a message needs review",
    opening: "A message arrived that needs someone to read it.",
  };
}

/**
 * The email body.
 *
 * **Says WHAT arrived and links to the console; it never restates the message.** The inbound text
 * is short-lived by retention policy and carries whatever a stranger typed, so copying it into a
 * mailbox would both outlive its retention and put untrusted text in VIGA's inbox. The mask is
 * the only sender material permitted (Golden Rule #5) — never the number, never the hash.
 */
function renderAlert(flag: FlagAlertRow, consoleUrl: string): string {
  const { opening } = describeReason(flag.reasonCode);
  return [
    opening,
    "",
    `From: ${flag.senderMask}`,
    `Arrived: ${flag.createdAt.toISOString()}`,
    "",
    "Read it and record what you decided here:",
    consoleUrl,
    "",
    "This is an automatic notice from Farm Friend. The message itself is not included —",
    "open the console to read it.",
  ].join("\n");
}

export async function runFlagAlertPass(
  deps: FlagAlertPassDeps,
): Promise<FlagAlertPassResult> {
  // Nothing to send with, or nowhere to send: claim NOTHING. A pass that consumed its queue
  // without sending would mark flags alerted that nobody was ever told about.
  if (deps.send === null || deps.recipient === undefined || deps.recipient === "") {
    return { sent: 0, failed: 0 };
  }
  const send = deps.send;
  const recipient = deps.recipient;

  const claimed = await deps.claim(deps.db, { limit: MAX_ALERTS_PER_PASS });
  let sent = 0;
  let failed = 0;

  for (const flag of claimed) {
    const { subject } = describeReason(flag.reasonCode);
    try {
      const result = await send({
        toEmail: recipient,
        subject,
        text: renderAlert(flag, deps.consoleUrl),
        // The flag's own id: a retry after a failure is the SAME alert, not a new one.
        idempotencyKey: `flag-alert-${flag.flagId}`,
      });
      /*
        AN AMBIGUOUS SEND IS NOT RETRIED. The relay may already have accepted it, and
        `EmailDispatchOutcome` says so explicitly: releasing the claim here would mail VIGA the
        same alert again on the next pass. The claim stands, so the alert is delivered at most
        once — for an operator notice, a possible silent miss on an ambiguous relay error is the
        right trade against mailing a duplicate every minute until it happens to succeed.

        A DEFINITIVE rejection is different: the relay certainly did not take it, so the flag
        goes back in the queue.
      */
      if (result.outcome === "ambiguous") {
        failed += 1;
        continue;
      }
      if (result.outcome !== "accepted") {
        await deps.releaseClaim(deps.db, { flagId: flag.flagId });
        failed += 1;
        continue;
      }
      await deps.markAlerted(deps.db, { flagId: flag.flagId, occurredAt: deps.clock.now() });
      sent += 1;
    } catch {
      /*
        A thrown transport is the same outcome as a refusal, and it must not escape: this pass
        runs alongside inbound routing, prompting, dispatch, delivery and retention in ONE cron
        request, and an exception here would abort the ones that follow it.

        One flag's failure also must not strand the others — hence the release-and-continue
        rather than a break.
      */
      await deps.releaseClaim(deps.db, { flagId: flag.flagId });
      failed += 1;
    }
  }

  return { sent, failed };
}
