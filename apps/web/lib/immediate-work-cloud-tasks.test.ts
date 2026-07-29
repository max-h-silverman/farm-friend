import { describe, expect, it, vi } from "vitest";
import {
  createCloudTasksQueue,
  type CloudTasksConfig,
} from "./immediate-work-cloud-tasks";
import { enqueueSenderWork, taskNameFor } from "./immediate-work";

// The Cloud Tasks adapter (docs/GCP_MIGRATION_PLAN.md §"Immediate and scheduled work").
//
// WHY REST AND NOT `@google-cloud/tasks`. The official client is 11.6 MB unpacked and pulls
// in `google-gax` — gRPC plus protobuf runtimes, tens of megabytes more. All of that lands
// in a container whose cold-start time sits directly on the SMS reply path, to make one
// POST to one documented endpoint. The repo's standing rule is few concepts, each
// load-bearing; a dependency of that weight for a single call does not earn its place.
//
// The cost of this choice is that the request shape is ours to get right, which is exactly
// what these tests pin. `transport` is injected so none of this needs a network.

const config: CloudTasksConfig = {
  project: "farm-friend-vashon",
  location: "us-west1",
  queue: "inbound-work",
  targetUrl: "https://farm-friend-worker-abc-uw.a.run.app/api/internal/kick",
  invokerServiceAccount: "farm-friend-invoker@farm-friend-vashon.iam.gserviceaccount.com",
};

const task = {
  name: taskNameFor("evt-1"),
  senderHash: "b".repeat(64),
  providerEventId: "evt-1",
};

function okTransport() {
  return vi.fn(async () => ({ ok: true, status: 200, text: async () => "{}" }));
}

describe("the request Cloud Tasks receives", () => {
  it("posts to the fully qualified queue path", async () => {
    const transport = okTransport();
    const queue = createCloudTasksQueue(config, {
      transport,
      accessToken: async () => "token-abc",
    });

    await queue.enqueue(task);

    const call = transport.mock.calls[0] as unknown as [string, { body: string }];
    expect(call[0]).toBe(
      "https://cloudtasks.googleapis.com/v2/projects/farm-friend-vashon/" +
        "locations/us-west1/queues/inbound-work/tasks",
    );
  });

  it("names the task so the queue itself deduplicates", async () => {
    // The deterministic name must reach the API as a fully qualified resource name, or
    // Cloud Tasks assigns a random one and every webhook retry creates another task.
    const transport = okTransport();
    const queue = createCloudTasksQueue(config, {
      transport,
      accessToken: async () => "token-abc",
    });

    await queue.enqueue(task);

    const call = transport.mock.calls[0] as unknown as [string, { body: string }];
    const body = JSON.parse(call[1].body) as { task: { name: string } };
    expect(body.task.name).toBe(
      `projects/farm-friend-vashon/locations/us-west1/queues/inbound-work/tasks/${task.name}`,
    );
  });

  it("carries an OIDC token so the worker can require IAM", async () => {
    // The worker runs with internal ingress AND IAM authentication. Without an OIDC token
    // naming the invoker service account, every task would arrive 403 and the fast path
    // would be silently dead while the scheduler quietly carried all the traffic.
    const transport = okTransport();
    const queue = createCloudTasksQueue(config, {
      transport,
      accessToken: async () => "token-abc",
    });

    await queue.enqueue(task);

    const call = transport.mock.calls[0] as unknown as [string, { body: string }];
    const body = JSON.parse(call[1].body) as {
      task: { httpRequest: { oidcToken: { serviceAccountEmail: string } } };
    };
    expect(body.task.httpRequest.oidcToken.serviceAccountEmail).toBe(
      config.invokerServiceAccount,
    );
  });

  it("sends only the sender hash and provider event id in the payload", async () => {
    // A task body is stored by the queue and visible in operational surfaces, so it is a
    // minimal projection like every other seam: no phone, no message body, no envelope.
    const transport = okTransport();
    const queue = createCloudTasksQueue(config, {
      transport,
      accessToken: async () => "token-abc",
    });

    await queue.enqueue(task);

    const call = transport.mock.calls[0] as unknown as [string, { body: string }];
    const body = JSON.parse(call[1].body) as { task: { httpRequest: { body: string } } };
    const payload = JSON.parse(
      Buffer.from(body.task.httpRequest.body, "base64").toString("utf8"),
    ) as Record<string, unknown>;

    expect(payload).toEqual({
      senderHash: task.senderHash,
      providerEventId: task.providerEventId,
    });
  });

  it("never puts a raw phone number in the task", async () => {
    // Golden Rule #5 stated as an assertion over the whole serialized request, so a future
    // field cannot smuggle one in.
    const transport = okTransport();
    const queue = createCloudTasksQueue(config, {
      transport,
      accessToken: async () => "token-abc",
    });

    await queue.enqueue(task);

    const serialized = JSON.stringify(transport.mock.calls[0]);
    expect(serialized).not.toMatch(/\+1\d{10}/);
  });
});

describe("failure behaviour", () => {
  it("throws ALREADY_EXISTS in the shape the seam recognizes", async () => {
    // The adapter's job on a duplicate is to fail in a way `enqueueSenderWork` classifies
    // as success. This asserts the two halves agree — a contract between two modules that
    // no single-module test can see.
    const transport = vi.fn(async () => ({
      ok: false,
      status: 409,
      text: async () => JSON.stringify({ error: { status: "ALREADY_EXISTS" } }),
    }));
    const queue = createCloudTasksQueue(config, {
      transport,
      accessToken: async () => "token-abc",
    });

    const result = await enqueueSenderWork(queue, {
      senderHash: task.senderHash,
      providerEventId: task.providerEventId,
    });

    expect(result).toEqual({ enqueued: true, duplicate: true });
  });

  it("surfaces other failures to the seam, which swallows them", async () => {
    // End-to-end through the real seam: a 503 from Cloud Tasks must not become an exception
    // that could fail an ingress whose durable commit already succeeded.
    const transport = vi.fn(async () => ({
      ok: false,
      status: 503,
      text: async () => "backend unavailable",
    }));
    const queue = createCloudTasksQueue(config, {
      transport,
      accessToken: async () => "token-abc",
    });

    const result = await enqueueSenderWork(queue, {
      senderHash: task.senderHash,
      providerEventId: task.providerEventId,
    });

    expect(result).toEqual({ enqueued: false, duplicate: false });
  });

  it("does not fail ingress when the metadata server cannot mint a token", async () => {
    // A token failure at container startup is a real Cloud Run condition. It must degrade
    // to "no fast path", never to a failed webhook.
    const queue = createCloudTasksQueue(config, {
      transport: okTransport(),
      accessToken: async () => {
        throw new Error("metadata server unreachable");
      },
    });

    const result = await enqueueSenderWork(queue, {
      senderHash: task.senderHash,
      providerEventId: task.providerEventId,
    });

    expect(result).toEqual({ enqueued: false, duplicate: false });
  });
});
