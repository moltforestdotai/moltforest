/**
 * SSRF protection for fetching attacker-controlled agentURIs (constraint C7).
 *
 * Every hostname is resolved and ALL resolved addresses must be public unicast.
 * The check runs inside the socket's DNS lookup, so the address that is checked
 * is the address that is connected to (no DNS-rebinding window). IP literals
 * skip DNS, so they are checked separately via `assertPublicHost`.
 */
import dns, { type LookupAddress, type LookupOptions } from "node:dns";
import ipaddr from "ipaddr.js";

export class BlockedHostError extends Error {
  readonly code = "EBLOCKED";
}

/** True only for globally routable unicast addresses (no private, loopback, link-local, CGNAT, multicast, reserved…). */
export function isPublicAddress(address: string): boolean {
  if (!ipaddr.isValid(address)) return false;
  let ip = ipaddr.parse(address);
  if (ip.kind() === "ipv6") {
    const v6 = ip as ipaddr.IPv6;
    if (v6.isIPv4MappedAddress()) ip = v6.toIPv4Address();
  }
  return ip.range() === "unicast";
}

function hostLiteral(hostname: string): string | null {
  const h = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  return ipaddr.isValid(h) ? h : null;
}

/** Rejects IP-literal hosts that are not public. Hostnames are checked at connect time. */
export function assertPublicHost(hostname: string): void {
  const literal = hostLiteral(hostname);
  if (literal !== null && !isPublicAddress(literal)) {
    throw new BlockedHostError(`blocked: ${hostname} is not a public address`);
  }
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/** Drop-in `lookup` for net/tls connect options that refuses non-public destinations. */
export function guardedLookup(hostname: string, options: LookupOptions, callback: LookupCallback): void {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, "");
    const list = addresses as LookupAddress[];
    const bad = list.find((a) => !isPublicAddress(a.address));
    if (list.length === 0 || bad) {
      return callback(new BlockedHostError(`blocked: ${hostname} resolves to non-public address ${bad?.address ?? "(none)"}`), "");
    }
    if (options.all) return callback(null, list);
    callback(null, list[0]!.address, list[0]!.family);
  });
}
