/** Subdomain + game-port allocation. Pure logic, no I/O. */

function slug(s: string): string {
  const cleaned = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return cleaned || "srv";
}

/** Flat single-level name under the wildcard: `<server>-<owner>.<base>`. */
export function toSubdomain(serverName: string, owner: string, baseDomain: string): string {
  return `${slug(serverName)}-${slug(owner)}.${baseDomain}`;
}

/** Contiguous port pool with reuse on release. Throws when exhausted. */
export class PortPool {
  private free: number[];
  private used: Record<number, true> = {};

  constructor(
    private from = 31000,
    private to = 31999,
  ) {
    this.free = Array.from({ length: to - from + 1 }, (_, i) => from + i);
  }

  allocate(): number {
    const port = this.free.shift();
    if (port === undefined) throw new Error("port pool exhausted");
    this.used[port] = true;
    return port;
  }

  release(port: number): void {
    if (this.used[port]) {
      delete this.used[port];
      this.free.push(port);
      this.free.sort((a, b) => a - b);
    }
  }

  get available(): number {
    return this.free.length;
  }
}
