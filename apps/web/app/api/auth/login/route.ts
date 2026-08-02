import { issueSessionToken } from "@farm-friend/core";
import {
  clearAdminLoginFailures,
  createAdminSession,
  findAdministratorByEmail,
  reserveAdminLoginAttempt,
} from "@farm-friend/db";
import {
  adminLoginRefusalResponse,
  handleAdminPasswordLogin,
} from "../../../../lib/admin-password-login";
import {
  FIXED_ADMIN_EMAIL,
  resolveAdminPasswordHash,
  verifyAdminPassword,
} from "../../../../lib/admin-password";
import { publicReadContext } from "../../../../lib/public-context";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const signalSalt = process.env.PHONE_HASH_SALT;
  let passwordHash: string;
  try {
    passwordHash = resolveAdminPasswordHash();
    if (signalSalt === undefined || signalSalt.trim() === "") throw new Error("missing salt");
  } catch {
    return adminLoginRefusalResponse(req);
  }

  const { db, clock } = publicReadContext();
  return handleAdminPasswordLogin(req, {
    clock,
    signalSalt,
    passwordHash,
    verifyPassword: verifyAdminPassword,
    reserveAttempt: (input) => reserveAdminLoginAttempt(db, input),
    clearFailures: (input) => clearAdminLoginFailures(db, input),
    findAdministrator: () => findAdministratorByEmail(db, FIXED_ADMIN_EMAIL),
    createSession: (input) => createAdminSession(db, input),
    issueSessionToken,
  });
}
