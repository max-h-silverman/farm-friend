import { hashEmail, type EmailSendInput } from "@farm-friend/core";
import type { Db } from "@farm-friend/db";

// F-078 — the send path, and the ONLY reader of `farm_emails.email`.
//
// The mirror of `packages/sms/src/delivery.ts`: an email cannot be sent to a hash, so exactly
// one place resolves a hash to the single stored raw address, immediately before the send.
// Everything else — lookups, logs, audit — stays hash-only (Golden Rule #5).

export interface FarmEmailRecipient {
  farmId: string;
  /** The raw address, for dialing only. Never returned to a caller that logs. */
  email: string;
  emailHash: string;
}

/**
 * Resolve every address on file for a farm.
 *
 * Returns the raw address because the send path needs it, and this is the one function
 * permitted to. Several rows per farm is the NORMAL case — five of VIGA's 32 farms list more
 * than one address — so this returns a list rather than a single row.
 */
export async function resolveFarmEmailsForDelivery(
  db: Db,
  farmId: string,
): Promise<FarmEmailRecipient[]> {
  const rows = (await db.sql`
    select farm_id, email, email_hash from farm_emails where farm_id = ${farmId}
    order by added_at asc
  `) as unknown as Array<{ farm_id: string; email: string; email_hash: string }>;

  return rows.map((row) => ({
    farmId: row.farm_id,
    email: row.email,
    emailHash: row.email_hash,
  }));
}

/**
 * Find the farm an address belongs to, BY HASH.
 *
 * The verification lookup. The submitted address is hashed and the hash is compared — the raw
 * value is never used as a query predicate, so a submitted address never appears in a query
 * log. Measured against the real corpus: no address is shared between two farms, so this is
 * unambiguous.
 */
export async function findFarmByEmail(
  db: Db,
  submittedEmail: string,
  salt: string,
): Promise<string | null> {
  const rows = (await db.sql`
    select farm_id from farm_emails where email_hash = ${hashEmail(submittedEmail, salt)}
    limit 1
  `) as unknown as Array<{ farm_id: string }>;

  return rows[0]?.farm_id ?? null;
}

/** Build the send input for one recipient, carrying the hash for logs and never the address. */
export function sendInputFor(
  recipient: FarmEmailRecipient,
  message: { subject: string; text: string },
  idempotencyKey: string,
): EmailSendInput {
  return {
    toEmail: recipient.email,
    recipientHash: recipient.emailHash,
    subject: message.subject,
    text: message.text,
    idempotencyKey,
  };
}
