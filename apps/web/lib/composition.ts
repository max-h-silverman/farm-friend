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
import type { InventoryInterpreter } from "@farm-friend/core";
import {
  createDb,
  type Db,
} from "@farm-friend/db";
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
  const db = createDb(config.databaseUrl);

  const transport =
    config.sms.provider === "telnyx"
      ? createTelnyxTransport(config.sms)
      : createSimulatorTransport();

  // The provider receives no database or repository capability — only what a projection
  // hands it at call time.
  const provider = new StubLLMProvider({});

  return {
    config,
    db,
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
