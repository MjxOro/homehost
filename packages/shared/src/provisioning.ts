/** Flat wildcard-safe request hostnames. No DNS or provider I/O. */

function slug(s: string, limit: number): string {
  const cleaned = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, limit)
    .replace(/^-+|-+$/g, "");
  return cleaned || "srv";
}

/** The API supplies a UUID; all 128 bits survive the 63-character DNS label limit. */
export function toSubdomain(
  serverName: string,
  owner: string,
  baseDomain: string,
  requestId: string,
): string {
  return `${slug(serverName, 20)}-${slug(owner, 9)}-${requestId.replaceAll("-", "")}.${baseDomain}`;
}

/**
 * Desktop hostname for one request's GUI VM: `<label>-vnc.<baseDomain>`.
 * Pure: appends `-vnc` to the first DNS label of a `toSubdomain` output.
 * The suffix costs 4 chars, so the label is truncated to 59 chars to keep
 * the desktop label within the 63-char DNS limit. Flat single level, so the
 * existing LE wildcard DNS-01 cert covers it.
 * Injective over distinct `toSubdomain` outputs up to the retained UUID
 * prefix: truncation keeps the full server/owner slugs plus the first 28 of
 * the 32 UUID hex chars, so two outputs collide only on a 112-bit
 * UUID-prefix match.
 */
export function toDesktopHostname(subdomain: string): string {
  const dot = subdomain.indexOf(".");
  const label = dot === -1 ? subdomain : subdomain.slice(0, dot);
  const rest = dot === -1 ? "" : subdomain.slice(dot);
  const base = label.length === 0 ? "srv" : label.slice(0, 59);
  return `${base}-vnc${rest}`;
}

/** Public TCP pool for per-box SSH DNAT. Single range keeps firewall rules auditable. */
export const SSH_PORT_MIN = 22000;
export const SSH_PORT_MAX = 22999;

/**
 * Lowest free port in the pool, or null when exhausted. Pure so the worker
 * can retry on unique-violation races without re-reading the table.
 */
export function pickFreePort(taken: Iterable<number>): number | null {
  const used = new Set(taken);
  for (let port = SSH_PORT_MIN; port <= SSH_PORT_MAX; port++) {
    if (!used.has(port)) return port;
  }
  return null;
}

/**
 * Stable public address for one box inside the routed /64. Derived from the
 * request UUID, so relaunches converge without coordination. Reserved
 * interface IDs (gateway, tunnel endpoint, bridge) are skipped by bumping
 * the last group. Null when no prefix is configured (v4-only hosts).
 */
export function ipv6ForInstance(
  prefix: string,
  requestId: string,
): string | null {
  const clean = prefix.trim().replace(/:+$/, "");
  if (!/^[0-9a-fA-F]{1,4}(:[0-9a-fA-F]{1,4}){3}$/.test(clean)) return null;
  const hex = requestId.replaceAll("-", "");
  if (!/^[0-9a-f]{32}$/.test(hex)) return null;
  const tail = hex.slice(-16);
  const groups: [string, string, string, string] = [
    tail.slice(0, 4),
    tail.slice(4, 8),
    tail.slice(8, 12),
    tail.slice(12, 16),
  ];
  const last = Number.parseInt(groups[3], 16);
  if (last === 0x0001 || last === 0x0002 || last === 0xffff) {
    groups[3] = (last + 1).toString(16).padStart(4, "0");
  }
  return `${clean}:${groups[0]}:${groups[1]}:${groups[2]}:${groups[3]}`;
}
