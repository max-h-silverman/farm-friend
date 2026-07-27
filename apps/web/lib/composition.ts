import {
  assertProviderApproved,
  createInquiryModel,
  createInventoryInterpreter,
  createStockOutModel,
  StubLLMProvider,
  type InquiryModel,
  type ProviderDataHandling,
  type StockOutModel,
} from "@farm-friend/ai";
import {
  createPublicActionThrottle,
  createUnconfiguredMailSender,
  type Clock,
  type InventoryInterpreter,
  type MailSender,
  type PublicActionThrottle,
} from "@farm-friend/core";
import { type Db } from "@farm-friend/db";
import { sharedClock, sharedDb } from "./public-context";
import {
  createLastMileSender,
  resolveSmsConfig,
  type PhoneResolver,
  type ProviderTransport,
  type SmsConfig,
} from "@farm-friend/sms";

// The single composition root (docs/ARCHITECTURE.md §package layout).
//
// Every adapter is constructed here and injected into the authoritative workflows.
// Configuration fails CLOSED: selecting live Telnyx without the webhook public
// verification key or delivery credentials is a startup error, never a silent
// degradation to an unverified webhook.

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

export interface AppConfig {
  databaseUrl: string;
  phoneSalt: string;
  /**
   * Shared secret guarding the internal scheduled-worker route. Required with no default:
   * the workers apply consent transitions and send SMS, so an unauthenticated trigger is a
   * remote way to drive real messaging. There is deliberately no development bypass.
   */
  cronSecret: string;
  /**
   * Signs admin sign-in links. Required with no default: a guessable value would let anyone
   * forge a link, and the administrator lookup behind it is the only thing standing between
   * a forged link and authority over every farm's published state.
   */
  magicLinkSecret: string;
  /**
   * The public origin sign-in links are built against. CONFIGURED rather than derived from
   * the request, because a `Host:` header an attacker controls would otherwise let the
   * link-request endpoint mail a real operator a link pointing at the attacker's origin.
   */
  publicBaseUrl: string;
  sms: SmsConfig;
  model: ModelConfig;
}

export interface ModelConfig {
  /** Which provider to construct. `stub` is the deterministic test/dev provider. */
  provider: "stub";
  /** The declared data-handling terms this provider is approved under. */
  dataHandling: ProviderDataHandling;
}

/**
 * The stub provider's data handling. It makes no network call at all, so it trivially
 * satisfies the gate.
 *
 * READ THIS BEFORE COPYING IT FOR A REAL VENDOR. These fields are an ATTESTATION, not a
 * setting: writing `trainsOnData: false` does not make a vendor stop training on our data,
 * it records that someone verified the contract says so. The gate enforces the declaration;
 * it cannot verify the vendor's actual practice from inside this process. So the value here
 * is only as good as the contract review behind it — check the vendor's data-processing
 * terms first, then declare what they actually say, and cite them in the PR.
 *
 * The stub is the ONLY provider configured today; no real vendor's terms have been approved
 * through this gate yet. docs/AI_ARCHITECTURE.md §"Provider privacy gate" and
 * docs/RUNBOOK.md §"Swap a provider" carry the full procedure.
 */
const STUB_DATA_HANDLING: ProviderDataHandling = {
  trainsOnData: false,
  statefulStorage: false,
  requestLoggingDisabled: true,
  retentionDays: 0,
};

function resolveModelConfig(_env: NodeJS.ProcessEnv): ModelConfig {
  // Launch configures exactly one provider. Adding a second is a seam/provider change that
  // must re-run the privacy gate and the full eval suite (docs/RUNBOOK.md §how to extend).
  return { provider: "stub", dataHandling: STUB_DATA_HANDLING };
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === "") {
    throw new ConfigurationError(`${name} is required`);
  }
  return value;
}

/**
 * Resolve the public origin sign-in links are built against.
 *
 * Validated here rather than trusted, because every failure mode of this value is silent:
 * a malformed origin produces links that do not work, with an operator who cannot sign in
 * and nothing in the logs explaining why. Plaintext `http` is refused outside localhost
 * because the link is a bearer credential and must not travel in cleartext.
 */
function resolvePublicBaseUrl(env: NodeJS.ProcessEnv): string {
  const raw = required(env, "PUBLIC_BASE_URL").trim();

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigurationError(
      "PUBLIC_BASE_URL must be an absolute URL, e.g. https://farmfriend.example",
    );
  }

  const isLocal = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocal)) {
    throw new ConfigurationError(
      "PUBLIC_BASE_URL must use https (http is permitted only for localhost)",
    );
  }

  // Normalized so a link is never assembled with a doubled separator.
  return raw.replace(/\/+$/, "");
}

/** Resolve and validate runtime configuration, or throw before anything starts. */
export function resolveConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const sms = resolveSmsConfig(env);
  if (!sms.ok) {
    throw new ConfigurationError(
      `${sms.reason} (missing: ${sms.missing.join(", ")})`,
    );
  }

  const model = resolveModelConfig(env);
  // Fail closed before anything can call a model: an unapproved provider never constructs.
  assertProviderApproved(model.provider, model.dataHandling);

  return {
    databaseUrl: required(env, "DATABASE_URL"),
    // The phone hash is the only lookup/log key, so its salt is mandatory.
    phoneSalt: required(env, "PHONE_HASH_SALT"),
    // The scheduled-worker trigger drives consent and outbound SMS; it never runs open.
    cronSecret: required(env, "CRON_SECRET"),
    // Signs sign-in links. A guessable value forges authority over the admin surface.
    magicLinkSecret: required(env, "MAGIC_LINK_SECRET"),
    publicBaseUrl: resolvePublicBaseUrl(env),
    sms: sms.config,
    model,
  };
}

export interface AppContext {
  config: AppConfig;
  db: Db;
  /** The narrow last-mile capability; the only path to a dialable number. */
  sendSms: ReturnType<typeof createLastMileSender>;
  /**
   * The inventory seam. It is constructed over the provider ONLY — deliberately no `db`,
   * repository, or record loader, so it cannot acquire context beyond the projection the
   * workflow hands it (docs/AI_ARCHITECTURE.md §"The model provider seam").
   */
  interpreter: InventoryInterpreter;
  /** The customer inquiry seams. Constructed over the provider alone, like every seam. */
  inquiry: InquiryModel;
  /** The stock-out item parser, used only by the code-bound web/QR surface. */
  stockOut: StockOutModel;
  clock: Clock;
  /**
   * The abuse/cost throttle fronting the one public unauthenticated MODEL surface — the QR
   * stock-out form. Model-free map/listing lookup does not pass through it and is never
   * capped; SMS uses its own sender/consent/frequency controls (F-019).
   */
  publicActionThrottle: PublicActionThrottle;
  /**
   * A SEPARATE budget for sign-in link requests (F-032). Deliberately not the same instance
   * as the stock-out throttle: sharing one would let a burst of anonymous stock-out reports
   * from a shared NAT exhaust a real operator's ability to request a sign-in link, which is
   * an availability failure on the recovery path of the admin surface. One mechanism, two
   * budgets — not two mechanisms.
   */
  signInThrottle: PublicActionThrottle;
  /** Sends the one transactional message Farm Friend has. Fails closed until F-031. */
  mail: MailSender;
  close(): Promise<void>;
}

/**
 * Resolve the recipient's single stored raw E.164 for dialing only. This is the one
 * reader of that column; every other path uses the hash.
 */
function createPhoneResolver(db: Db): PhoneResolver {
  return {
    async resolveForDelivery(recipientHash) {
      const rows = await db.sql`
        select phone_e164 from contacts where phone_hash = ${recipientHash}
      `;
      return (rows[0]?.phone_e164 as string | undefined) ?? null;
    },
  };
}

function createTelnyxTransport(config: {
  apiKey: string;
  messagingProfileId: string;
  fromNumber: string;
}): ProviderTransport {
  return async ({ toPhone, body, idempotencyKey }) => {
    const response = await fetch("https://api.telnyx.com/v2/messages", {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        "content-type": "application/json",
        // Telnyx idempotency is keyed by the outbox row, never by a phone number.
        "idempotency-key": idempotencyKey,
      },
      body: JSON.stringify({
        from: config.fromNumber,
        to: toPhone,
        text: body,
        messaging_profile_id: config.messagingProfileId,
      }),
    });

    if (!response.ok) {
      const error = new Error(`telnyx responded ${response.status}`) as Error & {
        status?: number;
      };
      error.status = response.status;
      throw error;
    }

    const payload = (await response.json()) as {
      data?: { id?: string };
    };
    const providerMessageId = payload.data?.id;
    if (typeof providerMessageId !== "string") {
      // A missing ID means we cannot correlate delivery: treat as possibly accepted.
      throw new Error("telnyx accepted without a message id");
    }
    return { providerMessageId };
  };
}

/** In-process transport for local development and the SMS simulator. */
function createSimulatorTransport(): ProviderTransport {
  return async ({ idempotencyKey }) => ({
    providerMessageId: `simulated-${idempotencyKey}`,
  });
}

/** Construct the application context. Throws if configuration is incomplete. */
export function createAppContext(env: NodeJS.ProcessEnv = process.env): AppContext {
  const config = resolveConfig(env);
  // The same pool and clock the public read surface uses — one mechanism, two consumers.
  const db = sharedDb(config.databaseUrl);

  const transport =
    config.sms.provider === "telnyx"
      ? createTelnyxTransport(config.sms)
      : createSimulatorTransport();

  // The provider receives no database or repository capability — only what a projection
  // hands it at call time.
  const provider = new StubLLMProvider({});
  const clock = sharedClock();

  return {
    config,
    db,
    clock,
    // Deliberately generous: a real reporter standing at a stand submits once, maybe twice
    // after a typo. This bites a script, not a customer.
    publicActionThrottle: createPublicActionThrottle({
      clock,
      limit: 5,
      windowMs: 60_000,
    }),
    // Tighter than the stock-out budget and over a longer window. Requesting a sign-in link
    // is a rare, deliberate act — an operator does it once and reads their mail — so a low
    // ceiling costs a real user nothing while making inbox flooding and address probing
    // expensive. A separate instance, so stock-out traffic cannot exhaust it.
    signInThrottle: createPublicActionThrottle({
      clock,
      limit: 3,
      windowMs: 15 * 60_000,
    }),
    // Fails closed until F-031 selects a provider and records its attested data handling.
    // Nothing here claims a vendor's terms; the seam simply refuses to send.
    mail: createUnconfiguredMailSender(),
    sendSms: createLastMileSender({
      resolver: createPhoneResolver(db),
      transport,
    }),
    interpreter: createInventoryInterpreter(provider),
    inquiry: createInquiryModel(provider),
    stockOut: createStockOutModel(provider),
    close: () => db.close(),
  };
}

let cached: AppContext | undefined;

/** The process-wide context, constructed once per runtime. */
export function appContext(): AppContext {
  cached ??= createAppContext();
  return cached;
}
