/**
 * Clean-room reset for testing periods: every tenant instance, request,
 * job, event, route and per-VM AAAA goes away.
 *
 * Keeps: users/personas/invites/sessions (identity layer — wiping those
 * would brick demo logins, and migrations never re-seed), the panel route,
 * host/prod DNS records, and the `default` Incus project.
 *
 * Usage: bun run test:reset [--yes]
 */
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { $ } from "bun";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

async function sh(
  cmd: string[],
  opts: { sudo?: boolean } = {},
): Promise<{ ok: boolean; out: string }> {
  const full = opts.sudo ? ["sudo", "-n", ...cmd] : cmd;
  const proc = Bun.spawn(full, {
    stdout: "pipe",
    stderr: "pipe",
    cwd: ROOT,
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { ok: code === 0, out: (out + err).trim() };
}

function envFileValue(path: string, key: string): string {
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
      if (match?.[1] === key) return match[2].trim();
    }
  } catch {
    /* missing file means the step is skipped, not fatal */
  }
  return "";
}

async function confirm(question: string): Promise<boolean> {
  if (process.argv.includes("--yes")) return true;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise<string>((resolve) =>
      rl.question(`${question} [y/N] `, resolve),
    );
    return answer.trim().toLowerCase() === "y";
  } finally {
    rl.close();
  }
}

const CF_API = "https://api.cloudflare.com/client/v4";

async function cleanDns(token: string): Promise<number> {
  if (!token) {
    console.log("  DNS: no CF_DNS_API_TOKEN, skipping AAAA cleanup");
    return 0;
  }
  const auth = { Authorization: `Bearer ${token}` };
  const zones = (await (
    await fetch(`${CF_API}/zones?name=risktozero.sh`, { headers: auth })
  ).json()) as { result?: Array<{ id?: unknown }> };
  const zone = zones.result?.[0]?.id;
  if (typeof zone !== "string") throw new Error("cf zone lookup failed");
  const list = (await (
    await fetch(`${CF_API}/zones/${zone}/dns_records?type=AAAA&per_page=100`, {
      headers: auth,
    })
  ).json()) as { result?: Array<{ id?: unknown; name?: unknown }> };
  let removed = 0;
  for (const record of list.result ?? []) {
    if (
      typeof record.id !== "string" ||
      typeof record.name !== "string" ||
      !record.name.endsWith(".homehost.risktozero.sh")
    ) {
      continue;
    }
    const deleted = await fetch(
      `${CF_API}/zones/${zone}/dns_records/${record.id}`,
      { method: "DELETE", headers: auth },
    );
    if (!deleted.ok) throw new Error(`cf delete failed for ${record.name}`);
    removed++;
  }
  return removed;
}

async function main(): Promise<void> {
  // Inventory first so the confirm gate states exact blast radius.
  const projects = (
    await sh(["incus", "project", "list", "--format", "csv"])
  ).out
    .split("\n")
    .map((l) => l.split(",")[0].replace(" (current)", "").trim())
    .filter((p) => p.startsWith("tenant-"));
  const instances: string[] = [];
  for (const project of projects) {
    const listed = await sh([
      "incus",
      "list",
      "--project",
      project,
      "--format",
      "csv",
    ]);
    for (const line of listed.out.split("\n")) {
      const name = line.split(",")[0]?.trim();
      if (name) instances.push(`${project}/${name}`);
    }
  }
  console.log(
    `Reset will delete ${instances.length} instance(s) in ${projects.length} tenant project(s), ` +
      `all requests/jobs/events and per-VM AAAA records.`,
  );
  console.log("Keeps: users, invites, sessions, panel route, host DNS.");
  if (!(await confirm("Proceed?"))) {
    console.log("Aborted.");
    process.exitCode = 1;
    return;
  }

  for (const entry of instances) {
    const [project, name] = entry.split("/");
    const deleted = await sh([
      "incus",
      "delete",
      name,
      "--project",
      project,
      "--force",
    ]);
    console.log(`  instance ${entry}: ${deleted.ok ? "deleted" : "FAILED"}`);
    if (!deleted.ok) throw new Error(`could not delete ${entry}`);
  }

  const db = await sh([
    "docker",
    "compose",
    "-f",
    "infra/compose.yml",
    "exec",
    "-T",
    "postgres",
    "psql",
    "-U",
    "homehost",
    "-d",
    "homehost",
    "-c",
    "TRUNCATE provision_jobs, activity_events, server_requests;",
  ]);
  console.log(`  database lifecycle tables: ${db.ok ? "truncated" : "FAILED"}`);
  if (!db.ok) throw new Error("database truncate failed");

  const token = envFileValue(
    `${ROOT}/infra/private/traefik.env`,
    "CF_DNS_API_TOKEN",
  );
  const dns = await cleanDns(token);
  console.log(`  per-VM AAAA records removed: ${dns}`);
  console.log("Reset complete.");
}

await main();
