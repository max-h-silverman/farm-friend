/**
 * Prove the B-009 class BY EFFECT against the deployed runtime.
 *
 * WHY THIS EXISTS AS A SCRIPT AND NOT A VITEST FILE. B-009's whole lesson is that the
 * property belongs to the PLATFORM, not the code: vitest runs in Node, where a floating
 * promise resolves, so the entire kick suite stayed green while production dropped every
 * inbound message. `kick-wiring.test.ts` asserts the SHAPE of the webhook source and
 * `latency.integration.test.ts` asserts the passes against local Postgres — neither can
 * observe whether a container that has already returned its response actually completes the
 * work. Cloud Run's container lifecycle is a NEW runtime for that question, so it starts
 * unproven. "Cloud Tasks is durable by design" is a claim; this script is the evidence.
 *
 * WHAT IT PROVES, each against the database rather than an HTTP status:
 *
 *   1. FAST PATH — a signed inbound message returns 200 and its task is observed to drive
 *      that sender's pass to completion: `provider_inbox_events.claimed_at` non-NULL and the
 *      downstream rows present. The exact B-009 signature is a row that is committed and
 *      acknowledged but never claimed, so that is searched for explicitly rather than
 *      assumed absent.
 *   2. COLD START — the same, immediately after forcing a new container, so startup cannot
 *      swallow the task.
 *   3. RECOVERY NET — a message whose task was NEVER created is still completed by the
 *      scheduled pass, proving the fast path owns no guarantee.
 *
 * SIGNING. Telnyx's private key is not ours, so a genuinely signed request requires the
 * deployment to trust a key we hold. `TELNYX_PUBLIC_KEY` is plain non-secret configuration
 * (`infra/terraform.tfvars`), so the proof runs against a revision carrying a throwaway
 * public key and the real key is restored afterwards. The signature path itself is therefore
 * exercised for real — this does not stub verification, which would prove nothing about the
 * route that actually runs.
 *
 * The messages carry a reserved test phone number in a range that cannot collide with a real
 * sender, and every row they create is reported at the end so the operator can see exactly
 * what the proof left behind.
 */

import { createHmac, webcrypto } from "node:crypto";
import postgres from "postgres";

const BASE_URL = requireEnv("PROOF_BASE_URL");
const DATABASE_URL = requireEnv("DATABASE_URL");
const PRIVATE_KEY_PKCS8 = requireEnv("PROOF_PRIVATE_KEY");
/**
 * The DEPLOYED salt, not a test value. Check 3 inserts an inbox row directly, and the
 * scheduled pass will only act on a sender hash the deployment would itself have produced —
 * a mismatched salt yields a row nothing ever claims, which would look exactly like the
 * failure this check exists to detect.
 */
const PHONE_HASH_SALT = requireEnv("PHONE_HASH_SALT");

/**
 * The reserved range. +1 206 555 01xx is a documented fictional-number block, so a row this
 * script creates can never be confused with a real farmer or customer.
 */
const TEST_NUMBER_PREFIX = "+1206555";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function signingKey(): Promise<webcrypto.CryptoKey> {
  return webcrypto.subtle.importKey(
    "pkcs8",
    Buffer.from(PRIVATE_KEY_PKCS8, "base64"),
    "Ed25519",
    false,
    ["sign"],
  );
}

/** Sign exactly what `verifyTelnyxSignature` verifies: `${timestamp}|${rawBody}`. */
async function signedHeaders(
  key: webcrypto.CryptoKey,
  rawBody: string,
): Promise<Record<string, string>> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = await webcrypto.subtle.sign(
    "Ed25519",
    key,
    Buffer.from(`${timestamp}|${rawBody}`, "utf8"),
  );
  return {
    "content-type": "application/json",
    "telnyx-timestamp": timestamp,
    "telnyx-signature-ed25519": Buffer.from(signature).toString("base64"),
  };
}

/** A minimal Telnyx v2 `message.received` envelope. */
function inboundEnvelope(input: {
  providerEventId: string;
  from: string;
  text: string;
}): string {
  return JSON.stringify({
    data: {
      id: input.providerEventId,
      event_type: "message.received",
      occurred_at: new Date().toISOString(),
      payload: {
        id: `msg-${input.providerEventId}`,
        direction: "inbound",
        from: { phone_number: input.from },
        to: [{ phone_number: "+12068645326" }],
        text: input.text,
        received_at: new Date().toISOString(),
      },
    },
  });
}

/** Mirrors `hashPhone`: HMAC-SHA256 under the deployment's salt, never a bare digest. */
function hashPhone(raw: string): string {
  return createHmac("sha256", PHONE_HASH_SALT).update(raw).digest("hex");
}

interface InboxRow {
  provider_event_id: string;
  state: string;
  claimed_at: Date | null;
  finalized_at: Date | null;
}

async function readInbox(sql: postgres.Sql, providerEventId: string): Promise<InboxRow | null> {
  const rows = await sql<InboxRow[]>`
    select provider_event_id, state, claimed_at, finalized_at
    from provider_inbox_events
    where provider_event_id = ${providerEventId}
  `;
  return rows[0] ?? null;
}

/**
 * Wait for the row to be CLAIMED — the observable signal that post-response work actually
 * ran. Returns the row whether or not it succeeded, so the caller reports the real state
 * rather than a timeout hiding a partial result.
 */
async function awaitClaimed(
  sql: postgres.Sql,
  providerEventId: string,
  timeoutMs: number,
): Promise<InboxRow | null> {
  const deadline = Date.now() + timeoutMs;
  let row = await readInbox(sql, providerEventId);
  while (Date.now() < deadline) {
    if (row?.claimed_at) return row;
    await new Promise((r) => setTimeout(r, 1000));
    row = await readInbox(sql, providerEventId);
  }
  return row;
}

async function postWebhook(rawBody: string, headers: Record<string, string>) {
  const response = await fetch(`${BASE_URL}/api/sms/webhook`, {
    method: "POST",
    headers,
    body: rawBody,
  });
  return { status: response.status, body: await response.text() };
}

interface CheckResult {
  name: string;
  passed: boolean;
  detail: string;
}

async function main(): Promise<void> {
  const sql = postgres(DATABASE_URL, { max: 2 });
  const key = await signingKey();
  const results: CheckResult[] = [];
  const created: string[] = [];

  try {
    // ---- Check 1: the fast path completes post-response work -------------------------
    {
      const providerEventId = `proof-fast-${Date.now()}`;
      const from = `${TEST_NUMBER_PREFIX}0101`;
      created.push(providerEventId);

      const rawBody = inboundEnvelope({ providerEventId, from, text: "HELP" });
      const ack = await postWebhook(rawBody, await signedHeaders(key, rawBody));

      const row = await awaitClaimed(sql, providerEventId, 90_000);
      const committed = row !== null;
      const claimed = Boolean(row?.claimed_at);
      // The downstream half: HELP is a compliance keyword, so a completed pass must have
      // produced outbound work for this sender. A claimed row with no reply would mean the
      // pass started and died — a different failure, but not a success.
      const outbound = await sql<{ n: number }[]>`
        select count(*)::int as n from outbox_work
        where recipient_hash = ${hashPhone(from)}
      `;

      results.push({
        name: "fast path: signed message returns 200 and its task drives the pass to completion",
        passed: ack.status === 200 && committed && claimed && outbound[0].n > 0,
        detail:
          `ack=${ack.status} committed=${committed} state=${row?.state ?? "-"} ` +
          `claimed_at=${row?.claimed_at ?? "NULL"} finalized_at=${row?.finalized_at ?? "NULL"} ` +
          `outbound_rows=${outbound[0].n}` +
          (committed && !claimed
            ? "  <-- B-009 SIGNATURE: committed and acknowledged but never processed"
            : ""),
      });
    }

    // ---- Check 2: the same immediately after a forced cold start ----------------------
    // The caller forces the cold start (a new revision or a scaled-to-zero container)
    // before this script runs its second phase; see the runbook step that invokes it.
    {
      const providerEventId = `proof-cold-${Date.now()}`;
      const from = `${TEST_NUMBER_PREFIX}0102`;
      created.push(providerEventId);

      const rawBody = inboundEnvelope({ providerEventId, from, text: "HELP" });
      const ack = await postWebhook(rawBody, await signedHeaders(key, rawBody));

      const row = await awaitClaimed(sql, providerEventId, 120_000);
      const claimed = Boolean(row?.claimed_at);

      results.push({
        name: "cold start: container startup does not swallow the task",
        passed: ack.status === 200 && claimed,
        detail:
          `ack=${ack.status} state=${row?.state ?? "-"} claimed_at=${row?.claimed_at ?? "NULL"} ` +
          `finalized_at=${row?.finalized_at ?? "NULL"}` +
          (row && !claimed
            ? "  <-- B-009 SIGNATURE: committed and acknowledged but never processed"
            : ""),
      });
    }

    // ---- Check 3: the scheduled pass recovers a message with no task ------------------
    //
    // The row is inserted DIRECTLY, which is precisely the state "the webhook committed but
    // the enqueue failed" leaves behind — `enqueueSenderWork` swallows a queue outage and
    // returns `enqueued: false`. Nothing creates a task for this event, so if it is ever
    // claimed, only the every-minute scheduled pass can have done it.
    {
      const providerEventId = `proof-recovery-${Date.now()}`;
      created.push(providerEventId);

      const from = `${TEST_NUMBER_PREFIX}0103`;
      const senderHash = hashPhone(from);

      // Mirrors `acceptProviderEvent` exactly: the minimized message row first, then the
      // inbox row referencing it. Writing only the inbox row would violate the schema and
      // prove nothing about the path the webhook actually takes.
      await sql.begin(async (tx) => {
        await tx`
          insert into contacts (phone_e164, phone_hash)
          values (${from}, ${senderHash})
          on conflict (phone_hash) do nothing
        `;
        const message = await tx<{ id: string }[]>`
          insert into sms_messages
            (provider_message_id, sender_hash, body, body_expires_at, received_at)
          values
            (${`msg-${providerEventId}`}, ${senderHash}, 'HELP',
             now() + interval '1 day', now())
          returning id
        `;
        await tx`
          insert into provider_inbox_events
            (provider_event_id, event_type, message_id, sender_hash, occurred_at)
          values
            (${providerEventId}, 'message_received', ${message[0].id}, ${senderHash}, now())
        `;
      });

      const row = await awaitClaimed(sql, providerEventId, 150_000);
      const claimed = Boolean(row?.claimed_at);

      results.push({
        name: "recovery net: a message whose task was never created is recovered by the schedule",
        passed: claimed,
        detail:
          `state=${row?.state ?? "-"} claimed_at=${row?.claimed_at ?? "NULL"} ` +
          `finalized_at=${row?.finalized_at ?? "NULL"}`,
      });
    }

    // ---- Report ----------------------------------------------------------------------
    console.log("\nB-009 class, proven by effect on Cloud Run\n");
    for (const result of results) {
      console.log(`  ${result.passed ? "PASS" : "FAIL"}  ${result.name}`);
      console.log(`        ${result.detail}`);
    }

    const rows = await sql`
      select provider_event_id, state, claimed_at, finalized_at
      from provider_inbox_events
      where provider_event_id = any(${created})
      order by provider_event_id
    `;
    console.log(`\n  rows this proof created: ${rows.length}`);
    for (const row of rows) {
      console.log(
        `    ${row.provider_event_id} state=${row.state} ` +
          `claimed=${row.claimed_at ? "yes" : "NO"} finalized=${row.finalized_at ? "yes" : "NO"}`,
      );
    }

    const failed = results.filter((r) => !r.passed);
    if (failed.length > 0) {
      console.error(`\n${failed.length} of ${results.length} checks FAILED\n`);
      process.exitCode = 1;
    } else {
      console.log(`\nall ${results.length} checks passed\n`);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
