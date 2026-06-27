import { createHash } from "node:crypto";

export function normalizePhone(raw: string): string {
  const trimmed = raw.trim();
  const cleaned = trimmed.replace(/[^\d+]/g, "");

  if (cleaned.startsWith("+")) return cleaned;
  if (cleaned.length === 10) return `+1${cleaned}`;
  if (cleaned.length === 11 && cleaned.startsWith("1")) return `+${cleaned}`;
  return `+${cleaned}`;
}

export function hashPhone(raw: string, salt: string): string {
  if (!salt) throw new Error("phone hash salt is required");

  return createHash("sha256")
    .update(`${salt}:${normalizePhone(raw)}`)
    .digest("hex")
    .slice(0, 32);
}

export function redactPhone(raw: string): string {
  const normalized = normalizePhone(raw);
  if (normalized.length < 7) return "****";
  return `${normalized.slice(0, 5)}****${normalized.slice(-2)}`;
}
