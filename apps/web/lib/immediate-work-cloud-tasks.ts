import type { ImmediateWorkQueue, SenderWorkTask } from "./immediate-work";

// The Cloud Tasks adapter: the one place that knows how to talk to Google's queue.
//
// WHY REST RATHER THAN `@google-cloud/tasks`. The official client is 11.6 MB unpacked and
// depends on `google-gax`, which brings gRPC and protobuf runtimes — tens of megabytes more,
// all of it landing in a container whose cold-start time sits directly on the SMS reply path,
// in order to make one POST to one documented endpoint. The repo's standing rule is few
// concepts, each load-bearing, and a dependency of that weight for a single call does not
// earn its place. The trade is that the request shape is ours to get right, which is what
// `immediate-work-cloud-tasks.test.ts` pins.
//
// Both seams are injected — the HTTP call and the token mint — so this module needs no
// network, no credential, and no mock of Google's SDK to test.

export interface CloudTasksConfig {
  readonly project: string;
  readonly location: string;
  readonly queue: string;
  /** The worker's `/api/internal/kick` URL. */
  readonly targetUrl: string;
  /** The service account Cloud Tasks mints an OIDC token for. */
  readonly invokerServiceAccount: string;
}

/** The subset of `fetch` this adapter uses, injected so tests need no network. */
export type CloudTasksTransport = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface CloudTasksDeps {
  transport: CloudTasksTransport;
  /**
   * Mint an access token for the Cloud Tasks API. On Cloud Run this reads the metadata
   * server, which returns a token for the revision's own service account.
   */
  accessToken: () => Promise<string>;
}

const CLOUD_TASKS_HOST = "https://cloudtasks.googleapis.com/v2";
const METADATA_TOKEN_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";

/**
 * Read an access token from the Cloud Run metadata server.
 *
 * Available to any workload on Cloud Run with no credential file and no key to rotate, which
 * is why the plan specifies Workload Identity and no service-account key anywhere.
 */
export async function metadataAccessToken(): Promise<string> {
  const response = await fetch(METADATA_TOKEN_URL, {
    headers: { "Metadata-Flavor": "Google" },
  });
  if (!response.ok) {
    throw new Error(`metadata server returned ${response.status}`);
  }
  const payload = (await response.json()) as { access_token?: string };
  if (typeof payload.access_token !== "string") {
    throw new Error("metadata server returned no access_token");
  }
  return payload.access_token;
}

/**
 * Build the queue capability.
 *
 * Every failure here THROWS, and that is deliberate: classifying failures is
 * `enqueueSenderWork`'s job, and it is the only caller. Keeping the policy in one place means
 * the swallow-versus-succeed decision cannot drift between the adapter and the seam — an
 * ALREADY_EXISTS this adapter chose to swallow would look identical to a successful enqueue,
 * and nothing would report that deduplication had stopped working.
 */
export function createCloudTasksQueue(
  config: CloudTasksConfig,
  deps: CloudTasksDeps,
): ImmediateWorkQueue {
  const queuePath =
    `projects/${config.project}/locations/${config.location}/queues/${config.queue}`;

  return {
    async enqueue(task: SenderWorkTask): Promise<void> {
      const token = await deps.accessToken();

      // The minimal projection, base64-encoded as the API requires. Two opaque identifiers:
      // the worker looks up everything else from the database it already trusts.
      const payload = JSON.stringify({
        senderHash: task.senderHash,
        providerEventId: task.providerEventId,
      });

      const body = JSON.stringify({
        task: {
          // Fully qualified, or Cloud Tasks assigns a random name and the deterministic
          // deduplication this design depends on silently stops working.
          name: `${queuePath}/tasks/${task.name}`,
          httpRequest: {
            url: config.targetUrl,
            httpMethod: "POST",
            headers: { "Content-Type": "application/json" },
            body: Buffer.from(payload, "utf8").toString("base64"),
            // The worker requires IAM. Without this the task arrives 403 and the fast path
            // is dead while the scheduler quietly carries all the traffic — a degradation
            // that looks like nothing at all from the outside.
            oidcToken: {
              serviceAccountEmail: config.invokerServiceAccount,
              audience: config.targetUrl,
            },
          },
        },
      });

      const response = await deps.transport(`${CLOUD_TASKS_HOST}/${queuePath}/tasks`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body,
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        const error = new Error(
          `cloud tasks responded ${response.status}`,
        ) as Error & { code?: number };
        // Carried so `enqueueSenderWork` can recognize the duplicate case. 409 is what the
        // REST transport returns where gRPC would say ALREADY_EXISTS.
        error.code = response.status;
        if (response.status === 409 || /ALREADY_EXISTS/.test(detail)) {
          error.code = 409;
        }
        throw error;
      }
    },
  };
}
