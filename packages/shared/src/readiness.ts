/**
 * Pure pieces of the worker's "reachable before running" gate: IPv6 text
 * comparison, Cloudflare DoH answer parsing, and a poll-with-deadline helper.
 * Kept free of node/DOM imports so the web bundle can still import shared.
 */

/**
 * Canonical (fully expanded, lowercase) form of an IPv6 address, or null when
 * the text is not plain IPv6. Embedded IPv4 (`::ffff:1.2.3.4`), zones and
 * brackets are rejected: tenant addresses never use them.
 */
export function normalizeIpv6(input: string): string | null {
  const text = input.trim().toLowerCase();
  if (!/^[0-9a-f:]+$/.test(text)) return null;
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string | undefined): string[] | null => {
    if (part === undefined || part === "") return [];
    const groups = part.split(":");
    return groups.every((g) => /^[0-9a-f]{1,4}$/.test(g)) ? groups : null;
  };
  const head = parse(halves[0]);
  const tail = parse(halves[1]);
  if (head === null || tail === null) return null;
  const compressed = halves.length === 2;
  const count = head.length + tail.length;
  if (compressed ? count > 7 : count !== 8) return null;
  const fill = compressed ? Array<string>(8 - count).fill("0") : [];
  return [...head, ...fill, ...tail].map((g) => g.padStart(4, "0")).join(":");
}

/** True when two IPv6 spellings name the same address. Invalid text never matches. */
export function sameIpv6(a: string, b: string): boolean {
  const left = normalizeIpv6(a);
  return left !== null && left === normalizeIpv6(b);
}

const DNS_TYPE_AAAA = 28;

/**
 * Whether a Cloudflare DoH JSON response (`application/dns-json`) answers an
 * AAAA query with the expected address. NXDOMAIN, NOERROR with no answers,
 * CNAME-only answers and malformed bodies are all "not visible".
 */
export function dohHasAaaa(body: unknown, expected: string): boolean {
  if (typeof body !== "object" || body === null) return false;
  const { Status, Answer } = body as { Status?: unknown; Answer?: unknown };
  if (Status !== 0 || !Array.isArray(Answer)) return false;
  return Answer.some((record: unknown) => {
    if (typeof record !== "object" || record === null) return false;
    const { type, data } = record as { type?: unknown; data?: unknown };
    return (
      type === DNS_TYPE_AAAA &&
      typeof data === "string" &&
      sameIpv6(data, expected)
    );
  });
}

export interface ReadinessCheck {
  /** Message used in the timeout error when this check never passed. */
  failure: string;
  run: () => Promise<boolean>;
}

export interface PollOptions {
  timeoutMs: number;
  intervalMs: number;
  /** Injectable for deterministic tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Runs every check each round until all have passed. A passed check is not
 * re-run. A check that throws counts as not passed. Always makes at least one
 * round; when the budget is gone, throws naming only the checks still failing.
 */
export async function pollChecks(
  checks: ReadinessCheck[],
  options: PollOptions,
): Promise<void> {
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const deadline = now() + options.timeoutMs;
  let pending = checks;
  for (;;) {
    const results = await Promise.all(
      pending.map(async (check) => ({
        check,
        ok: await check.run().catch(() => false),
      })),
    );
    pending = results.filter((r) => !r.ok).map((r) => r.check);
    if (pending.length === 0) return;
    const remaining = deadline - now();
    if (remaining <= 0) {
      throw new Error(pending.map((check) => check.failure).join("; "));
    }
    await sleep(Math.min(options.intervalMs, remaining));
  }
}
