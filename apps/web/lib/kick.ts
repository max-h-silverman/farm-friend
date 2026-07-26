import type { WorkerPassResult } from "./workers";

// The low-latency kick (B-004, docs/RUNBOOK.md §"Scheduled work").
//
// Vercel Cron's finest granularity is one minute, so polling alone cannot get an SMS reply
// under the ~10s an exchange needs. This module lets the webhook START that sender's work
// immediately, AFTER it has acknowledged Telnyx.
//
// It adds NO durable mechanism. It calls the same two passes the cron route calls, scoped
// to one sender, and every guarantee still lives where it already lived: the claim is
// `claimNextInboundEvent`'s row lock, deduplication is the inbox's unique provider event
// ID, the consent recheck is `authorizeDispatch`'s. The kick only makes those run sooner.
//
// Consequently the kick is BEST-EFFORT, and deliberately so. Cron remains the durable
// guarantee — it recovers anything a kick missed because the invocation crashed, the claim
// lapsed, or the process died mid-pass — and it stays the ONLY trigger for F-026's
// retention purge, which is never latency-sensitive and must not run on every message.
//
// That is why every failure here is swallowed. A kick that could reject would turn an
// ingress whose durable commit already SUCCEEDED into a failed invocation, and Telnyx would
// retry a message Farm Friend has already accepted. Losing latency on a broken kick costs a
// minute; failing the acknowledgement costs correctness.

/**
 * How long one kick may run before it is abandoned to the recovery net.
 *
 * A pass that has not settled by now is wedged on something external — a model or provider
 * call — and waiting longer only risks the runtime killing the invocation at an arbitrary
 * point instead. Abandoning it is safe: an abandoned claim lapses and `releaseAbandonedClaims`
 * recovers it on the next cron pass, which is the same path a crashed invocation takes.
 */
const DEFAULT_KICK_BUDGET_MS = 10_000;

/**
 * The two passes a kick runs, injected rather than imported so this module needs no
 * database, model, or SMS capability of its own — and so the tests above can drive a
 * throwing or hanging pass directly.
 */
export interface KickDeps {
  runInbound(senderHashes: string[]): Promise<WorkerPassResult>;
  runOutbound(): Promise<{ sent: number; suppressed: number; ambiguous: number }>;
}

export interface KickOptions {
  budgetMs?: number;
}

/** Run `work`, resolving on rejection and on exceeding the budget. */
async function withinBudget(
  work: () => Promise<unknown>,
  budgetMs: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, budgetMs);
  });

  try {
    // `work()` is invoked inside the try so a synchronous throw is caught too.
    await Promise.race([work().then(() => undefined), budget]);
  } catch {
    // Swallowed by design — see the note above. The failed work is still durable and
    // still recoverable; only its latency is lost.
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Start one sender's inbound routing and outbound dispatch immediately.
 *
 * Inbound first, then outbound: the inbound pass queues the outbox row that the outbound
 * pass dispatches, so this order is what lets a SINGLE kick carry a message all the way to
 * a sent reply. Reversed, the reply would wait for cron and the kick would buy nothing.
 *
 * The passes are budgeted independently so a wedged inbound pass does not also strand
 * outbox work an earlier pass already queued.
 *
 * Never rejects, and never resolves to a value: the caller has already sent its response
 * and has nothing to do with the outcome.
 */
export async function kickSenderPasses(
  deps: KickDeps,
  senderHash: string,
  options: KickOptions = {},
): Promise<void> {
  const budgetMs = options.budgetMs ?? DEFAULT_KICK_BUDGET_MS;

  // Scoped to the one sender whose message just arrived. Enumerating every pending sender
  // is the cron pass's job; doing it on each webhook would multiply work under load.
  await withinBudget(() => deps.runInbound([senderHash]), budgetMs);
  await withinBudget(() => deps.runOutbound(), budgetMs);
}
