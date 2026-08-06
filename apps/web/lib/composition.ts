import {
  assertProviderApproved,
  createDeepInfraProvider,
  createFarmerMessageIntentModel,
  createInquiryModel,
  createInventoryInterpreter,
  createStockOutModel,
  DEEPINFRA_ATTESTED_DATA_HANDLING,
  DEEPINFRA_THIRD_PARTY_ROUTED_MODEL_PREFIXES,
  StubLLMProvider,
  type FarmerMessageIntentModel,
  type InquiryModel,
  type ProviderDataHandling,
  type StockOutModel,
} from "@farm-friend/ai";
import {
  createPublicActionThrottle,
  type Clock,
  type InventoryInterpreter,
  type PublicActionThrottle,
} from "@farm-friend/core";
import { type Db } from "@farm-friend/db";
import { sharedClock, sharedDb } from "./public-context";
import {
  createNoopImmediateWork,
  type ImmediateWorkQueue,
} from "./immediate-work";
import {
  createCloudTasksQueue,
  metadataAccessToken,
} from "./immediate-work-cloud-tasks";
import {
  createLastMileSender,
  resolveSmsConfig,
  summarizeProviderError,
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

/**
 * What configuration resolution actually reads: named variables that are strings or absent.
 *
 * Deliberately NOT `NodeJS.ProcessEnv` (GL-005). Nothing below does anything with `env`
 * beyond `env[name]`, but `ProcessEnv` demands `NODE_ENV` be present, so an honest test
 * fixture listing exactly the variables under test did not typecheck — and the only way to
 * satisfy it was to add a variable the code never reads, or to cast the lie away. Thirty-two
 * such errors sat in `apps/web` unseen while the root typecheck did not reference that
 * workspace.
 *
 * A function should demand the narrowest thing it consumes. `process.env` still satisfies
 * this, so every production caller is unchanged, while a fixture can now name only the
 * variables the case is about. `resolveSmsConfig` in `@farm-friend/sms` already took exactly
 * this shape — this makes the two agree rather than adding a third convention.
 */
export type EnvVars = Record<string, string | undefined>;

export interface AppConfig {
  databaseUrl: string;
  phoneSalt: string;
  /**
   * The public origin farmer links are built against. CONFIGURED rather than derived from
   * the request, because a `Host:` header an attacker controls would otherwise create a
   * credential URL on the attacker's origin.
   */
  publicBaseUrl: string;
  /** The canonical customer-facing map URL, returned by the deterministic MAP command. */
  publicMapUrl: string;
  /**
   * F-069 — the Google Geocoding key for the onboarding DRAFT pin lookup.
   *
   * OPTIONAL, and absent is a supported state: with no key the onboarding form falls back to
   * pin-dropping, which was the only behaviour before F-069 and is still the authority. The
   * farmer's tap decides where the stand is; the geocoder only saves them the work of finding it.
   *
   * Read server-side only. A geocoding key in client JavaScript is a published key, and this one
   * bills per call.
   */
  geocodingApiKey?: string;
  sms: SmsConfig;
  model: ModelConfig;
}

export interface ModelConfig {
  /** Which provider to construct. `stub` is the deterministic test/dev provider. */
  provider: "stub" | "deepinfra";
  /** The declared data-handling terms this provider is approved under. */
  dataHandling: ProviderDataHandling;
  /** Live-provider credentials. Absent for the stub, which makes no network call. */
  deepinfra?: { apiKey: string; model: string };
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
 * DeepInfra's attestation below is the one real vendor approved through this gate.
 * docs/AI_ARCHITECTURE.md §"Provider privacy gate" and docs/RUNBOOK.md §"Swap a provider"
 * carry the full procedure.
 */
const STUB_DATA_HANDLING: ProviderDataHandling = {
  trainsOnData: false,
  statefulStorage: false,
  requestLoggingDisabled: true,
  retentionDays: 0,
};

/**
 * Select the provider from configuration.
 *
 * `LLM_PROVIDER` is now REAL. It previously appeared in `.env.example` while this function
 * hard-coded the stub and never read the environment — a knob that looked live and did
 * nothing, which is worse than no knob at all (F-024).
 *
 * An unrecognized value is an error rather than a fallback: a typo in a production
 * environment variable must not silently run the scripted test double against real farmers.
 *
 * ## There is no default, and no environment sniffing (GL-019)
 *
 * `LLM_PROVIDER` used to default to `"stub"` when absent. Production had no `LLM_PROVIDER`
 * set at all, so the live deployment ran the deterministic test double against real traffic:
 * every model-backed journey degraded into a clarification, while health checks, the
 * webhook, and every suite stayed green. Nothing anywhere reported a problem, because from
 * the code's point of view nothing was wrong — the default had been chosen.
 *
 * So the selection is simply REQUIRED, exactly like `PHONE_HASH_SALT`.
 * Deliberately not "required in production": a rule that relaxes off-production behaves one
 * way everywhere it is tested and another way in the one place that matters, which is how
 * this defect survived. `cron-auth.test.ts` refuses the same pattern for the same reason,
 * now against the deployment-role guard that replaced the shared cron secret.
 * The cost is one line in a local `.env`; the stub is still fully available, it just has to
 * be ASKED for.
 */
function resolveModelConfig(env: EnvVars): ModelConfig {
  const selected = required(env, "LLM_PROVIDER").trim().toLowerCase();

  if (selected === "stub") {
    return { provider: "stub", dataHandling: STUB_DATA_HANDLING };
  }

  if (selected === "deepinfra") {
    const apiKey = required(env, "DEEPINFRA_API_KEY");
    const model = required(env, "DEEPINFRA_MODEL");

    // The attestation's carve-out, enforced. These namespaces route the request to a
    // third-party vendor under that vendor's unattested terms, so admitting one would make
    // the version-controlled attestation false for a reachable configuration. The
    // attestation itself — values, citations, and the review date — lives beside the
    // adapter it gates: packages/ai/src/deepinfra.ts (F-024).
    const routed = DEEPINFRA_THIRD_PARTY_ROUTED_MODEL_PREFIXES.find((prefix) =>
      model.trim().toLowerCase().startsWith(prefix),
    );
    if (routed !== undefined) {
      throw new ConfigurationError(
        `DEEPINFRA_MODEL="${model}" is routed to a third-party vendor ("${routed}" ` +
          "namespace): DeepInfra's attested no-training terms exclude Google and Anthropic " +
          "models, whose own data-handling policies apply and were never attested. " +
          "Choose a DeepInfra-hosted open-weight model, or re-read and re-attest the terms.",
      );
    }

    return {
      provider: "deepinfra",
      dataHandling: DEEPINFRA_ATTESTED_DATA_HANDLING,
      deepinfra: { apiKey, model },
    };
  }

  throw new ConfigurationError(
    `LLM_PROVIDER="${selected}" is not a known provider (expected "stub" or "deepinfra")`,
  );
}

function required(env: EnvVars, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === "") {
    throw new ConfigurationError(`${name} is required`);
  }
  return value;
}

/**
 * Resolve the public origin farmer links are built against.
 *
 * **Exported for F-040**, where the admin farmer route builds a farmer's standing link. That
 * route deliberately does NOT call `resolveConfig`: the full resolution also validates SMS
 * and model configuration, so an unrelated missing provider credential would make issuing a
 * link fail — the same reasoning that keeps `publicReadContext` out of `resolveConfig`.
 * One narrow value, resolved by the one function that validates it.
 *
 * Validated here rather than trusted, because every failure mode of this value is silent:
 * a malformed origin produces links that do not work with nothing in the logs explaining why.
 * Plaintext `http` is refused outside localhost
 * because the link is a bearer credential and must not travel in cleartext.
 */
export function resolvePublicBaseUrl(env: EnvVars): string {
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

/**
 * Resolve the customer-facing public map URL. It is deliberately a separate configured
 * value: VIGA may host the map page on its own site rather than Farm Friend's Cloud Run
 * origin, and a guessed or stale link is worse than no reply.
 */
export function resolvePublicMapUrl(env: EnvVars): string {
  const raw = required(env, "PUBLIC_MAP_URL").trim();

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigurationError(
      "PUBLIC_MAP_URL must be an absolute URL, e.g. https://www.vigavashon.org/farm-stand-map",
    );
  }

  const isLocal = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocal)) {
    throw new ConfigurationError(
      "PUBLIC_MAP_URL must use https (http is permitted only for localhost)",
    );
  }

  return raw;
}

/** Resolve and validate runtime configuration, or throw before anything starts. */
export function resolveConfig(env: EnvVars = process.env): AppConfig {
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
    publicBaseUrl: resolvePublicBaseUrl(env),
    publicMapUrl: resolvePublicMapUrl(env),
    // Optional by design: absent means the onboarding form asks the farmer to tap the map,
    // exactly as it did before F-069. An empty string is treated as absent so a blank
    // deployment variable does not become a key that fails on every call.
    geocodingApiKey: env.GEOCODING_API_KEY || undefined,
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
  /** Classifies an authorized farmer's free text before code resolves an update target. */
  farmerIntent: FarmerMessageIntentModel;
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
   * F-069 — its OWN budget for the onboarding address lookup, not the one above.
   *
   * Same general mechanism, a separate bucket: a farmer correcting a typed address makes several
   * lookups in a row, which is nothing like the "submits once, maybe twice" shape the stock-out
   * budget is tuned for. Sharing one bucket would let either surface starve the other, and the
   * two ration different bills.
   */
  addressLookupThrottle: PublicActionThrottle;
  /**
   * The durable fast path from "a message arrived" to "the reply is sent" — the Cloud Tasks
   * queue that replaced `waitUntil`. Absent configuration yields a queue that refuses, and
   * `enqueueSenderWork` turns that refusal into `enqueued: false` rather than an error: a
   * deployment with no queue runs on the scheduled pass alone, which is correct but slower.
   */
  immediateWork: ImmediateWorkQueue;
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

/**
 * The live Telnyx HTTP transport.
 *
 * Exported for `telnyx-transport.test.ts` (B-010). This function is where the provider's
 * error response is parsed, and it is precisely where the explanation used to be thrown
 * away — an untested seam is what let `error_code = '400'` stand in for "the source phone
 * number was deemed invalid by the carrier" through two long debugging sessions. It is not
 * part of the composition root's public contract; `appContext()` remains the only way to
 * obtain a wired transport.
 */
export function createTelnyxTransport(config: {
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
      // B-010: keep what Telnyx actually SAID, not just the status class it said it with.
      // `error_code = '400'` twice cost hours on 2026-07-27 while the response body held
      // "The source phone number was deemed invalid by the carrier" — the sentence that
      // names the misconfigured field. `summarizeProviderError` masks phones and bounds
      // length, and never throws, so a malformed error body cannot break the send path.
      const rawBody = await response.text().catch(() => "");
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawBody);
      } catch {
        parsed = undefined;
      }
      const summary = summarizeProviderError({ status: response.status, body: parsed });

      const error = new Error(`telnyx responded ${response.status}`) as Error & {
        status?: number;
        providerCode?: string;
        detail?: string;
      };
      error.status = response.status;
      if (summary.providerCode !== undefined) error.providerCode = summary.providerCode;
      if (summary.detail !== undefined) error.detail = summary.detail;
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

/**
 * Build the immediate-work queue from configuration.
 *
 * ALL FIVE VARIABLES OR NONE. A partially configured queue is the dangerous state: it looks
 * configured, constructs without complaint, and then fails every enqueue at runtime, leaving
 * the deployment silently dependent on the scheduled pass while an operator believes the fast
 * path is live. So a partial configuration is a startup error, and a fully absent one is the
 * legitimate "no queue here" case that local development and tests use.
 *
 * This is the same lesson as GL-019, where `LLM_PROVIDER` defaulting to `stub` let production
 * run the test double for its entire life with every check green. A missing knob must be
 * loud; only a deliberately empty one may be quiet.
 */
function resolveImmediateWork(env: EnvVars): ImmediateWorkQueue {
  const names = [
    "CLOUD_TASKS_PROJECT",
    "CLOUD_TASKS_LOCATION",
    "CLOUD_TASKS_QUEUE",
    "CLOUD_TASKS_TARGET_URL",
    "CLOUD_TASKS_INVOKER_SERVICE_ACCOUNT",
  ] as const;

  const present = names.filter((name) => (env[name] ?? "").trim() !== "");
  if (present.length === 0) return createNoopImmediateWork();

  if (present.length !== names.length) {
    const missing = names.filter((name) => !present.includes(name));
    throw new ConfigurationError(
      `the Cloud Tasks queue is partially configured (missing: ${missing.join(", ")}). ` +
        "Set all five variables or none — a partial configuration fails every enqueue at " +
        "runtime while appearing to be configured.",
    );
  }

  return createCloudTasksQueue(
    {
      project: required(env, "CLOUD_TASKS_PROJECT"),
      location: required(env, "CLOUD_TASKS_LOCATION"),
      queue: required(env, "CLOUD_TASKS_QUEUE"),
      targetUrl: required(env, "CLOUD_TASKS_TARGET_URL"),
      invokerServiceAccount: required(env, "CLOUD_TASKS_INVOKER_SERVICE_ACCOUNT"),
    },
    {
      // Resolved through `globalThis` at call time, not captured at construction — the same
      // late-binding requirement as `metadataAccessToken`, and for the same reason: a suite
      // that replaces the network boundary must actually be able to intercept this.
      transport: (url, init) => globalThis.fetch(url, init),
      accessToken: metadataAccessToken,
    },
  );
}

/** In-process transport for local development and the SMS simulator. */
function createSimulatorTransport(): ProviderTransport {
  return async ({ idempotencyKey }) => ({
    providerMessageId: `simulated-${idempotencyKey}`,
  });
}

/** Construct the application context. Throws if configuration is incomplete. */
export function createAppContext(env: EnvVars = process.env): AppContext {
  const config = resolveConfig(env);
  // The same pool and clock the public read surface uses — one mechanism, two consumers.
  const db = sharedDb(config.databaseUrl);

  const transport =
    config.sms.provider === "telnyx"
      ? createTelnyxTransport(config.sms)
      : createSimulatorTransport();

  // The provider receives no database or repository capability — only what a projection
  // hands it at call time. Which one is constructed is configuration; what either is
  // TRUSTED with is identical, because the harness owns every consequence either way.
  const provider =
    config.model.provider === "deepinfra" && config.model.deepinfra !== undefined
      ? createDeepInfraProvider(config.model.deepinfra)
      : new StubLLMProvider({});
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
    // A farmer refining an address types, looks, retypes. Generous enough that nobody
    // onboarding hits it, tight enough that a loop cannot run up a geocoding bill.
    addressLookupThrottle: createPublicActionThrottle({
      clock,
      limit: 20,
      windowMs: 60_000,
    }),
    immediateWork: resolveImmediateWork(env),
    sendSms: createLastMileSender({
      resolver: createPhoneResolver(db),
      transport,
    }),
    interpreter: createInventoryInterpreter(provider),
    farmerIntent: createFarmerMessageIntentModel(provider),
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
