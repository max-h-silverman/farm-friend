import { hash, verify, argon2id } from "argon2";
import { randomBytes } from "node:crypto";
export { FIXED_ADMIN_EMAIL } from "./admin-identity";
export const ADMIN_PASSWORD_MIN_LENGTH = 12;
export const ADMIN_PASSWORD_MAX_LENGTH = 1024;

const PHC = /^\$argon2id\$v=(\d+)\$([mtp]=\d+,[mtp]=\d+,[mtp]=\d+)\$([A-Za-z0-9+/]+={0,2})\$([A-Za-z0-9+/]+={0,2})$/;

/**
 * Validate the verifier before it can reach the expensive password check. Restricting the
 * algorithm, version, and work parameters prevents a malformed secret from silently selecting
 * a weak mode or turning one login request into unbounded CPU/memory work.
 */
export function isSupportedAdminPasswordHash(value: string): boolean {
  const match = PHC.exec(value);
  if (match === null) return false;
  const parameters = Object.fromEntries(
    match[2]!.split(",").map((parameter) => parameter.split("=")),
  );
  if (Object.keys(parameters).length !== 3) return false;
  const version = Number(match[1]);
  const memoryCost = Number(parameters.m);
  const timeCost = Number(parameters.t);
  const parallelism = Number(parameters.p);
  const saltBytes = Buffer.from(match[3]!, "base64").byteLength;
  const hashBytes = Buffer.from(match[4]!, "base64").byteLength;
  return (
    version === 19 &&
    memoryCost >= 19_456 && memoryCost <= 262_144 &&
    timeCost >= 2 && timeCost <= 10 &&
    parallelism >= 1 && parallelism <= 4 &&
    saltBytes >= 16 && saltBytes <= 64 &&
    hashBytes >= 16 && hashBytes <= 64
  );
}

export function resolveAdminPasswordHash(
  env: Record<string, string | undefined> = process.env,
): string {
  const value = env.ADMIN_PASSWORD_HASH;
  if (value === undefined || !isSupportedAdminPasswordHash(value.trim())) {
    throw new Error("ADMIN_PASSWORD_HASH must be a supported Argon2id PHC verifier");
  }
  return value.trim();
}

/** Maintained Argon2's verifier owns the constant-time comparison. */
export async function verifyAdminPassword(
  passwordHash: string,
  password: string,
): Promise<boolean> {
  if (!isSupportedAdminPasswordHash(passwordHash)) return false;
  if (password.length < 1 || password.length > ADMIN_PASSWORD_MAX_LENGTH) return false;
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

/** Used only by the non-echoing provisioning utility. */
export async function hashAdminPassword(password: string): Promise<string> {
  if (password.length < ADMIN_PASSWORD_MIN_LENGTH || password.length > ADMIN_PASSWORD_MAX_LENGTH) {
    throw new Error(
      `Password must be ${ADMIN_PASSWORD_MIN_LENGTH}–${ADMIN_PASSWORD_MAX_LENGTH} characters`,
    );
  }
  return hash(password, {
    type: argon2id,
    version: 0x13,
    memoryCost: 65_536,
    timeCost: 3,
    parallelism: 1,
    hashLength: 32,
    salt: randomBytes(16),
  });
}
