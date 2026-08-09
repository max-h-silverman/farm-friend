import { hashAdminPassword } from "../apps/web/lib/admin-password";

/**
 * Print an Argon2id verifier for a LOCAL development password.
 *
 * Deliberately separate from `apps/web/scripts/provision-admin-password.ts`, which is the
 * deployed path: that one demands a private interactive TTY, never echoes the password, and
 * writes the result straight into Secret Manager. Those properties are exactly right for a
 * real credential and exactly wrong for a throwaway local one that a setup script has to be
 * able to generate unattended.
 *
 * Both call the same `hashAdminPassword`, so the local verifier is the real shape rather than
 * a weaker stand-in — the login path being exercised locally is the deployed login path.
 *
 * The output goes to stdout so a caller can capture it into an ENVIRONMENT VARIABLE:
 *
 *   ADMIN_PASSWORD_HASH="$(npx tsx scripts/dev-admin-hash.ts localdevpassword)" \
 *     npm run dev --workspace @farm-friend/web
 *
 * **Do not write the result into a .env file.** Next expands `$NAME` inside .env values, and
 * a PHC verifier is a run of `$`-delimited segments; the server then reads a shorter, different
 * string than the file holds and refuses every sign-in with the same message it gives a wrong
 * password. Quoting the value does not prevent it.
 *
 * Never use this for a deployed environment: the password is a command-line argument, which
 * lands in shell history and in the process table.
 */
async function main(): Promise<number> {
  const password = process.argv[2];
  if (password === undefined || process.argv.length > 3) {
    process.stderr.write("usage: dev-admin-hash.ts <password>\n");
    return 2;
  }
  // Matches the login route's own floor, so a password that hashes here can actually sign in.
  if (password.length < 12) {
    process.stderr.write("password must be at least 12 characters\n");
    return 2;
  }
  process.stdout.write(await hashAdminPassword(password));
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  },
);
