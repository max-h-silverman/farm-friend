import { describe, expect, it } from "vitest";

import { resolveEmailDelivery, simulatedMailDirectory } from "./email-delivery";

/**
 * Which mail path a deployment gets, and — more importantly — which one it must NOT get.
 *
 * The precedence question is the whole test: with `EMAIL_PROVIDER=simulator` set AND real
 * SMTP configured, the deployment is misconfigured and the answer must be the safe one. A
 * sink that quietly wins over a working relay is the GL-019 failure with farmer verification
 * as the casualty.
 */
describe("resolveEmailDelivery", () => {
  const smtp = {
    SMTP_HOST: "smtp.example.com",
    SMTP_PORT: "587",
    SMTP_USERNAME: "user",
    SMTP_PASSWORD: "pass",
    SMTP_FROM_ADDRESS: "board@vigafarms.org",
  };
  const gmail = {
    EMAIL_PROVIDER: "gmail",
    GMAIL_SENDER_ADDRESS: "board@vigafarms.org",
    GMAIL_OAUTH_CLIENT_ID: "client-id.apps.googleusercontent.com",
    GMAIL_OAUTH_CLIENT_SECRET: "client-secret",
    GMAIL_OAUTH_REFRESH_TOKEN: "refresh-token",
  };

  it("is unavailable when nothing is configured, exactly as before", () => {
    const delivery = resolveEmailDelivery({});
    expect(delivery.available).toBe(false);
  });

  it("uses SMTP when SMTP is configured", () => {
    const delivery = resolveEmailDelivery({ ...smtp });
    expect(delivery.available).toBe(true);
    if (delivery.available) expect(delivery.kind).toBe("smtp");
  });

  it("uses Gmail's HTTPS API when explicitly selected", () => {
    const delivery = resolveEmailDelivery(gmail);
    expect(delivery.available).toBe(true);
    if (delivery.available) {
      expect(delivery.kind).toBe("gmail");
      expect(delivery.config.fromAddress).toBe("board@vigafarms.org");
    }
  });

  it("REFUSES a Gmail selection with missing OAuth material", () => {
    const { GMAIL_OAUTH_REFRESH_TOKEN: _refreshToken, ...missingToken } = gmail;
    expect(() => resolveEmailDelivery(missingToken)).toThrow(/GMAIL_OAUTH_REFRESH_TOKEN/);
  });

  it("REFUSES to let Gmail silently displace configured SMTP", () => {
    expect(() => resolveEmailDelivery({ ...smtp, ...gmail })).toThrow(/both/i);
  });

  it("uses the simulator when opted in locally with no SMTP", () => {
    const delivery = resolveEmailDelivery({
      EMAIL_PROVIDER: "simulator",
      NODE_ENV: "development",
    });
    expect(delivery.available).toBe(true);
    if (delivery.available) expect(delivery.kind).toBe("simulator");
  });

  it("REFUSES the simulator under NODE_ENV=production even when opted in", () => {
    expect(() =>
      resolveEmailDelivery({ EMAIL_PROVIDER: "simulator", NODE_ENV: "production" }),
    ).toThrow(/never be used on a deployment/i);
  });

  it("REFUSES to let the simulator silently displace configured SMTP", () => {
    // Both set is a misconfiguration. Failing loudly beats picking either one quietly.
    expect(() =>
      resolveEmailDelivery({ ...smtp, EMAIL_PROVIDER: "simulator", NODE_ENV: "development" }),
    ).toThrow(/both/i);
  });

  it("ignores an unset EMAIL_PROVIDER rather than treating absence as opt-in", () => {
    const delivery = resolveEmailDelivery({ NODE_ENV: "development" });
    expect(delivery.available).toBe(false);
  });

  it("defaults the mail directory but lets an absolute path pin it", () => {
    // The default is relative to the process working directory, which differs between
    // `next dev` (apps/web) and the suites (repo root) — hence the override.
    expect(simulatedMailDirectory({})).toBe(".mail");
    expect(simulatedMailDirectory({ SIMULATED_MAIL_DIR: "/tmp/ff-mail" })).toBe("/tmp/ff-mail");
    expect(simulatedMailDirectory({ SIMULATED_MAIL_DIR: "  " })).toBe(".mail");
  });

  it("rejects an unrecognized EMAIL_PROVIDER instead of falling back", () => {
    // A typo must be loud: silently falling back to "unavailable" is how a deployment ends up
    // believing mail is configured while nothing sends.
    expect(() => resolveEmailDelivery({ EMAIL_PROVIDER: "simluator" })).toThrow(
      /EMAIL_PROVIDER/,
    );
  });
});
