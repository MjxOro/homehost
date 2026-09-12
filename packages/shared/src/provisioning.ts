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
