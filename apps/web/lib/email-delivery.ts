import { resolveEmailConfig, type EmailConfig, type EmailTransport } from "@farm-friend/core";

import { createEmailSimulatorTransport } from "./email-simulator-transport";
import { createSmtpTransport } from "./smtp-transport";

// F-079 — which mail path a deployment gets.
//
// One place answers "how does mail leave", so the route reads a single result instead of
// branching on provider knobs itself. The shape mirrors `resolveEmailConfig`: unavailable is a
// SUPPORTED state, not an error, because a deployment without email is legitimate — everything
// except farmer email verification runs fine.
//
// The refusals are the substance. A local mail sink that outranked a configured relay would
// take farmer verification down while every log line read "accepted", so:
//   - the simulator is opt-in, never a default;
//   - it cannot construct under NODE_ENV=production (enforced in the transport itself);
//   - simulator AND real SMTP together is a startup error, not a silent precedence rule.
// A typo in the knob is likewise an error rather than a quiet fall back to "no email".

/**
 * Where the local mail sink writes. Git-ignored; safe to delete at any time.
 *
 * Overridable because the default is relative to the PROCESS working directory, and that
 * differs by how the app was started — `next dev` runs from `apps/web`, the test suites from
 * the repo root. Set `SIMULATED_MAIL_DIR` to an absolute path to pin it.
 */
export function simulatedMailDirectory(env: Record<string, string | undefined>): string {
  const override = env.SIMULATED_MAIL_DIR?.trim();
  return override !== undefined && override !== "" ? override : ".mail";
}

export type EmailDelivery =
  | { available: false }
  | {
      available: true;
      kind: "smtp" | "simulator";
      config: EmailConfig;
      transport: EmailTransport;
    };

/**
 * The From identity the simulator reports. Local-only and obviously fake: it must never be
 * mistaken for VIGA's real sending address when reading a captured message.
 */
const SIMULATED_CONFIG: EmailConfig = {
  host: "simulator",
  port: 0,
  username: "simulator",
  password: "",
  fromAddress: "simulator@localhost",
  fromName: "Farm Friend (local simulator)",
};

export function resolveEmailDelivery(env: Record<string, string | undefined>): EmailDelivery {
  const provider = env.EMAIL_PROVIDER?.trim();
  const smtp = resolveEmailConfig(env);

  if (provider !== undefined && provider !== "") {
    if (provider !== "simulator") {
      throw new Error(
        `EMAIL_PROVIDER="${provider}" is not a known provider (expected "simulator", or unset ` +
          "to use the SMTP_* configuration).",
      );
    }

    // Both configured is ambiguous, and both plausible readings are bad: honouring the
    // simulator silences a working relay, honouring SMTP makes the opt-in a lie.
    if (smtp.ok) {
      throw new Error(
        "EMAIL_PROVIDER=simulator and the SMTP_* variables are both set. Unset one — the " +
          "simulator writes mail to a local file and sends nothing, so leaving both configured " +
          "hides which one is actually delivering.",
      );
    }

    return {
      available: true,
      kind: "simulator",
      config: SIMULATED_CONFIG,
      // Throws under NODE_ENV=production. That refusal is the load-bearing barrier: it holds
      // even if this whole function is reached with the wrong environment on a server.
      transport: createEmailSimulatorTransport({
        directory: simulatedMailDirectory(env),
        nodeEnv: env.NODE_ENV,
      }),
    };
  }

  if (!smtp.ok) return { available: false };

  return {
    available: true,
    kind: "smtp",
    config: smtp.config,
    transport: createSmtpTransport(smtp.config),
  };
}
