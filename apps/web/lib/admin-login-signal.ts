import { createHmac } from "node:crypto";
import ipaddr from "ipaddr.js";

function opaque(value: string, salt: string): string {
  return createHmac("sha256", salt).update(value).digest("hex");
}

function observedHop(headers: Headers): string | null {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded === null) return null;
  const hops = forwarded.split(",");
  for (let index = hops.length - 1; index >= 0; index -= 1) {
    const value = hops[index]?.trim() ?? "";
    if (value !== "") return value;
  }
  return null;
}

/** IPv4 /24 or IPv6 /64: enough separation without retaining a durable device address. */
function coarseNetwork(raw: string | null): string {
  if (raw === null || !ipaddr.isValid(raw)) return "unknown";
  const address = ipaddr.process(raw);
  const bytes = address.toByteArray();
  const prefix = address.kind() === "ipv4" ? bytes.slice(0, 3) : bytes.slice(0, 8);
  return `${address.kind()}:${Buffer.from(prefix).toString("hex")}`;
}

export function adminLoginBucketsFor(
  headers: Headers,
  salt: string,
): { accountBucketHash: string; clientBucketHash: string } {
  return {
    accountBucketHash: opaque("admin-login:account", salt),
    clientBucketHash: opaque(
      `admin-login:client:${coarseNetwork(observedHop(headers))}`,
      salt,
    ),
  };
}
