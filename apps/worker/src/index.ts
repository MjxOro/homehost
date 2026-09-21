import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import postgres from "postgres";
import { PLANS, ipv6ForInstance, toDesktopHostname } from "@homehost/shared";
import type { Plan, ProvisionAction } from "@homehost/shared";
import {
  appendDesktopToUserData,
  omarchyUnavailable,
  removeDesktopRoute,
  writeDesktopRoute,
} from "./desktop.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}
const pollMs = Number(process.env.WORKER_POLL_MS ?? 2000);
const provisionAttempts = Number(process.env.WORKER_PROVISION_ATTEMPTS ?? 5);
const teardownAttempts = Number(process.env.WORKER_TEARDOWN_ATTEMPTS ?? 25);
const powerAttempts = Number(process.env.WORKER_POWER_ATTEMPTS ?? 5);
const bootTimeoutMs = Number(process.env.WORKER_BOOT_TIMEOUT_MS ?? 240000);
const ipv6Prefix = process.env.IPV6_PREFIX ?? "";
const cfToken = process.env.CF_DNS_API_TOKEN ?? "";
const workerEnv = process.env.WORKER_ENV ?? "prod";
const workerBaseDomain = process.env.WORKER_BASE_DOMAIN ?? "";

const sql = postgres(databaseUrl, { max: 4 });
let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    shuttingDown = true;
  });
}

interface Job {
  id: string;
  requestId: string;
  action: ProvisionAction;
  attempts: number;
}

interface RequestState {
  id: string;
  ownerId: string;
  ownerName: string;
  name: string;
  planId: string;
  status: string;
  instanceName: string | null;
  sshPubkey: string | null;
  sshPort: number | null;
  subdomain: string;
}

class IncusError extends Error {
  constructor(
    args: string[],
    public readonly code: number | null,
    output: string,
  ) {
    super(`Command failed: incus ${redactArgs(args)}\n${output}`);
  }
}

/**
 * --config/-c values carry user-data (passwords, keys), and the `sh -euc`
 * guest script carries the container root password. Failed commands
 * surface this message in activity events and job errors, so values are
 * masked at construction: no argv secret can ever reach logs or the DB.
 */
function redactArgs(args: string[]): string {
  const shown = [...args];
  for (let i = 0; i + 1 < shown.length; i++) {
    if (shown[i] === "--config" || shown[i] === "-c" || shown[i] === "-euc")
      shown[i + 1] = "<redacted>";
  }
  return shown.join(" ");
}

async function incus(args: string[]): Promise<string> {
  // Never execFile: its inherited stdin keeps `incus launch` blocked forever.
  // spawn with stdin ignored returns in ~1s on a warm image cache.
  return new Promise<string>((resolve, reject) => {
    const child = spawn("incus", args, {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 300000,
    });
    let output = "";
    child.stdout.on("data", (d) => {
      output += String(d);
    });
    child.stderr.on("data", (d) => {
      output += String(d);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(output.trim());
      else reject(new IncusError(args, code, output.trim()));
    });
  });
}
// Env placement: dev rows (subdomain under dev.homehost.risktozero.sh,
// the dev BASE_DOMAIN in .env.dev) live in tenant-dev-* projects; prod
// and showcase rows keep the legacy tenant-* placement so existing VMs
// never move. Derived from the request's own subdomain so every worker
// agrees regardless of its WORKER_BASE_DOMAIN filter.
function envOfSubdomain(subdomain: string): "dev" | "prod" {
  return subdomain.endsWith(".dev.homehost.risktozero.sh") ? "dev" : "prod";
}

function projectOf(ownerId: string, subdomain?: string): string {
  if (subdomain && envOfSubdomain(subdomain) === "dev") {
    return `tenant-dev-${ownerId}`;
  }
  return `tenant-${ownerId}`;
}

/** Pre-namespacing location: every VM provisioned before the split. */
function legacyProjectOf(ownerId: string): string {
  return `tenant-${ownerId}`;
}

/**
 * Project holding this request's instance. Stored dev-req-* names live in
 * the dev project; stored legacy names (prod rows plus pre-split dev VMs
 * like tenant-operator/req-1828ca5e) stay in the legacy project; fresh
 * rows derive from their subdomain. Teardown/power must use this, never
 * projectOf directly, or pre-split dev VMs become orphans.
 */
function projectForReq(req: RequestState): string {
  if (req.instanceName?.startsWith("dev-req-")) {
    return `tenant-dev-${req.ownerId}`;
  }
  if (req.instanceName) return legacyProjectOf(req.ownerId);
  return projectOf(req.ownerId, req.subdomain);
}

// Env scoping: a worker with WORKER_BASE_DOMAIN set only handles requests
// whose subdomain sits under that suffix. Empty = no filtering (host
// systemd prod unit keeps legacy behavior).
function envMatches(subdomain: string): boolean {
  if (workerBaseDomain === "") return true;
  return (
    subdomain === workerBaseDomain ||
    subdomain.endsWith(`.${workerBaseDomain}`)
  );
}

function instanceNameOf(requestId: string, subdomain?: string): string {
  const short = requestId.replace(/-/g, "").slice(0, 8);
  // Dev VMs carry the env in the Incus name (visible in `incus list`
  // across projects) so nothing in one daemon collides: dev rows mint
  // dev-req-*, prod/showcase keep the legacy req-* shape.
  if (subdomain && envOfSubdomain(subdomain) === "dev") {
    return `dev-req-${short}`;
  }
  return `req-${short}`;
}

async function leaseJob(): Promise<Job | null> {
  const rows = await sql.begin(async (tx) => {
    const queued = await tx`
      SELECT id, request_id, action, attempts FROM provision_jobs
      WHERE status = 'queued' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED
    `;
    if (queued.length === 0) return [];
    const job = queued[0] as Job & { request_id: string };
    await tx`
      UPDATE provision_jobs SET status = 'leased', attempts = ${job.attempts + 1}, updated_at = now()
      WHERE id = ${job.id}
    `;
    return [
      {
        id: String(job.id),
        requestId: String(job.request_id),
        action: job.action as ProvisionAction,
        attempts: Number(job.attempts) + 1,
      },
    ];
  });
  return rows.length > 0 ? (rows[0] as Job) : null;
}

async function loadRequest(requestId: string): Promise<RequestState | null> {
  const rows = await sql`
    SELECT id, owner_id, owner_name, name, plan_id, status, instance_name, ssh_pubkey, ssh_port, subdomain
    FROM server_requests WHERE id = ${requestId} LIMIT 1
  `;
  if (rows.length === 0) return null;
  const r = rows[0] as Record<string, unknown>;
  return {
    id: String(r.id),
    ownerId: String(r.owner_id),
    ownerName: String(r.owner_name),
    name: String(r.name),
    planId: String(r.plan_id),
    status: String(r.status),
    instanceName: typeof r.instance_name === "string" ? r.instance_name : null,
    sshPubkey: typeof r.ssh_pubkey === "string" ? r.ssh_pubkey : null,
    sshPort: typeof r.ssh_port === "number" ? r.ssh_port : null,
    subdomain: String(r.subdomain),
  };
}

async function setRequest(
  requestId: string,
  status: string,
  fields: { instanceName?: string; ipv4?: string | null } = {},
): Promise<void> {
  await sql`
    UPDATE server_requests
    SET status = ${status},
      instance_name = ${fields.instanceName ?? null},
      ipv4 = ${fields.ipv4 ?? null},
      updated_at = now()
    WHERE id = ${requestId}
  `;
}

async function setInstancePassword(
  requestId: string,
  password: string,
): Promise<void> {
  await sql`
    UPDATE server_requests
    SET instance_password = ${password}, updated_at = now()
    WHERE id = ${requestId}
  `;
}

async function setDesktopPassword(
  requestId: string,
  password: string | null,
): Promise<void> {
  await sql`
    UPDATE server_requests
    SET desktop_password = ${password}, updated_at = now()
    WHERE id = ${requestId}
  `;
}

async function setIpv6(requestId: string, ipv6: string): Promise<void> {
  await sql`
    UPDATE server_requests
    SET ipv6 = ${ipv6}, updated_at = now()
    WHERE id = ${requestId}
  `;
}
interface DesktopFields {
  env: string | null;
  hostname: string | null;
  port: number | null;
}

/**
 * Desktop row columns from migration 0010. Null-tolerant: pre-migration
 * rows (or any select failure) fall back to plan-derived values so the
 * worker stays up across the migration boundary.
 */
async function loadDesktopFields(
  requestId: string,
): Promise<DesktopFields | null> {
  try {
    const rows = await sql`
      SELECT desktop_env, desktop_hostname, desktop_port
      FROM server_requests WHERE id = ${requestId} LIMIT 1
    `;
    if (rows.length === 0) return null;
    const r = rows[0] as Record<string, unknown>;
    return {
      env: typeof r.desktop_env === "string" ? r.desktop_env : null,
      hostname:
        typeof r.desktop_hostname === "string" ? r.desktop_hostname : null,
      port: typeof r.desktop_port === "number" ? r.desktop_port : null,
    };
  } catch {
    return null;
  }
}

const IPV6_DNS = ["2606:4700:4700::1111", "2001:4860:4860::8888"];

function buildNetConfig(ipv6: string, gateway: string): string {
  return `version: 2
ethernets:
  lan:
    match:
      name: "e*"
    dhcp4: true
    dhcp6: false
    addresses: [${ipv6}/64]
    routes:
      - to: "::/0"
        via: ${gateway}
    nameservers:
      addresses: [${IPV6_DNS.join(", ")}]
`;
}

const CF_API = "https://api.cloudflare.com/client/v4";
const cfZoneIds: Record<string, string> = {};

async function cfZones(subdomain: string): Promise<string> {
  // Zone is the apex owning the name: probe CF from longest suffix down
  // (dev.homehost.risktozero.sh -> homehost.risktozero.sh ->
  // risktozero.sh). The API has no parent lookup, so try each candidate
  // and cache the winning zone id by zone name.
  const parts = subdomain.split(".").filter((p) => p.length > 0);
  for (let i = 0; i <= parts.length - 2; i++) {
    const candidate = parts.slice(i).join(".");
    const cached = cfZoneIds[candidate];
    if (cached) return cached;
    const response = await fetch(`${CF_API}/zones?name=${candidate}`, {
      headers: { Authorization: `Bearer ${cfToken}` },
    });
    if (!response.ok) throw new Error(`cf zones failed: ${response.status}`);
    const body = (await response.json()) as {
      result?: Array<{ id?: unknown; name?: unknown }>;
    };
    const hit = (body.result ?? []).find((r) => r.name === candidate);
    if (hit && typeof hit.id === "string" && hit.id.length > 0) {
      cfZoneIds[candidate] = hit.id;
      return hit.id;
    }
  }
  throw new Error("cf zone not found");
}

async function ensureAAAA(subdomain: string, ipv6: string): Promise<void> {
  const zone = await cfZones(subdomain);
  const found = (await (
    await fetch(
      `${CF_API}/zones/${zone}/dns_records?type=AAAA&name=${subdomain}`,
      { headers: { Authorization: `Bearer ${cfToken}` } },
    )
  ).json()) as { result?: Array<{ id?: unknown; content?: unknown }> };
  const existing = (found.result ?? []).find((r) => r.content === ipv6);
  if (existing) return;
  const response = await fetch(`${CF_API}/zones/${zone}/dns_records`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      type: "AAAA",
      name: subdomain,
      content: ipv6,
      ttl: 120,
      proxied: false,
    }),
  });
  if (!response.ok)
    throw new Error(`cf AAAA create failed: ${response.status}`);
}

async function deleteAAAA(subdomain: string): Promise<void> {
  const zone = await cfZones(subdomain);
  const found = (await (
    await fetch(
      `${CF_API}/zones/${zone}/dns_records?type=AAAA&name=${subdomain}`,
      { headers: { Authorization: `Bearer ${cfToken}` } },
    )
  ).json()) as { result?: Array<{ id?: unknown }> };
  for (const record of found.result ?? []) {
    if (typeof record.id !== "string") continue;
    const response = await fetch(
      `${CF_API}/zones/${zone}/dns_records/${record.id}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${cfToken}` },
      },
    );
    if (!response.ok)
      throw new Error(`cf AAAA delete failed: ${response.status}`);
  }
}

function yamlSingle(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

interface InstanceAccess {
  userData: string;
  password: string;
}

function buildInstanceAccess(sshPubkey: string | null): InstanceAccess {
  // Every VM gets a generated password (one dashboard read, then cleared)
  // plus the owner's key when provided. Passwords are base64url so the
  // whole `user:pass` scalar survives YAML single-quoting.
  const password = randomBytes(18).toString("base64url");
  const keys = sshPubkey
    ? `users:\n  - name: root\n    ssh_authorized_keys:\n      - ${yamlSingle(sshPubkey)}\n`
    : "";
  return {
    password,
    userData: `#cloud-config
manage_etc_hosts: true
apt:
  conf: |
    Acquire::ForceIPv4 "true";
packages:
  - openssh-server
${keys}chpasswd:
  list:
    - ${yamlSingle(`root:${password}`)}
  expire: false
ssh_pwauth: true
write_files:
  - path: /etc/ssh/sshd_config.d/60-homehost.conf
    content: |
      PermitRootLogin yes
      PasswordAuthentication yes
runcmd:
  - systemctl restart ssh
`,
  };
}
/**
 * Containers ignore cloud-init, so sshd is installed in the running guest
 * via incus exec. Fail-fast (`sh -euc`): nonzero exit throws and the
 * attempts-capped requeue covers apt flakes. The password is base64url
 * (shell-safe); the pubkey travels base64-encoded so key comments can
 * never break quoting. Argv secrets are masked by redactArgs.
 */
async function provisionContainerSsh(
  project: string,
  name: string,
  password: string,
  sshPubkey: string | null,
  containerIpv6: string | null,
): Promise<void> {
  const keySetup = sshPubkey
    ? `mkdir -p /root/.ssh\nchmod 700 /root/.ssh\necho '${Buffer.from(sshPubkey, "utf8").toString("base64")}' | base64 -d > /root/.ssh/authorized_keys\nchmod 600 /root/.ssh/authorized_keys\n`
    : "";
  // incusbr0 is v6-disabled (no stateful DHCPv6), so a live NIC tweak is
  // rejected. Configure the static v6 in-guest instead, mirroring the VM
  // network-config gateway derivation.
  let v6Setup = "";
  if (containerIpv6) {
    const gateway = `${ipv6Prefix.replace(/:+$/, "")}::ffff`;
    const netplan = `network:\n  version: 2\n  ethernets:\n    eth0:\n      dhcp4: true\n      dhcp6: false\n      addresses: [${containerIpv6}/64]\n      routes:\n        - to: "::/0"\n          via: "${gateway}"\n      nameservers:\n        addresses: [${IPV6_DNS.join(", ")}]\n`;
    v6Setup = `mkdir -p /etc/netplan\ncat > /etc/netplan/60-homehost-v6.yaml <<'HOMEHOST_EOF'\n${netplan}HOMEHOST_EOF\nif command -v netplan >/dev/null 2>&1; then netplan apply; else # No netplan: live-only addresses, lost on reboot.\nip -6 addr add ${containerIpv6}/64 dev eth0 2>/dev/null || true\nip -6 route add default via ${gateway} dev eth0 2>/dev/null || true\nfi\n`;
  }
  const script = `export DEBIAN_FRONTEND=noninteractive\napt-get update\napt-get install -y openssh-server\nmkdir -p /etc/ssh/sshd_config.d\nprintf 'PermitRootLogin yes\\nPasswordAuthentication yes\\n' > /etc/ssh/sshd_config.d/60-homehost.conf\n${keySetup}${v6Setup}printf '%s\\n' 'root:${password}' | chpasswd\nsystemctl enable --now ssh\n`;
  await incus(["exec", name, "--project", project, "--", "sh", "-euc", script]);
}

async function emit(
  requestId: string,
  actorName: string,
  action: string,
  serverName: string,
  detail: string | null,
): Promise<void> {
  await sql`
    INSERT INTO activity_events (request_id, actor_name, action, server_name, detail)
    VALUES (${requestId}, ${actorName}, ${action}, ${serverName}, ${detail})
  `;
}

async function finishJob(
  jobId: string,
  status: "done" | "failed",
  lastError: string | null,
): Promise<void> {
  await sql`
    UPDATE provision_jobs SET status = ${status}, last_error = ${lastError}, updated_at = now()
    WHERE id = ${jobId}
  `;
}

async function requeue(jobId: string, lastError: string): Promise<void> {
  await sql`
    UPDATE provision_jobs SET status = 'queued', last_error = ${lastError}, updated_at = now()
    WHERE id = ${jobId}
  `;
}

function instanceState(out: string): { status: string; ipv4: string | null } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(out);
  } catch {
    return { status: "", ipv4: null };
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return { status: "", ipv4: null };
  }
  const first = parsed[0] as { state?: Record<string, unknown> };
  const state = first.state;
  if (!state || typeof state !== "object") return { status: "", ipv4: null };
  const status = typeof state.status === "string" ? state.status : "";
  let ipv4: string | null = null;
  const network = state.network;
  if (network && typeof network === "object") {
    for (const [iface, details] of Object.entries(network)) {
      if (iface === "lo") continue;
      const addrs = (details as { addresses?: unknown }).addresses;
      if (!Array.isArray(addrs)) continue;
      for (const a of addrs) {
        const entry = a as { family?: unknown; address?: unknown };
        if (
          entry.family === "inet" &&
          typeof entry.address === "string" &&
          !entry.address.startsWith("127.")
        ) {
          ipv4 = entry.address;
        }
      }
    }
  }
  return { status, ipv4 };
}

async function waitForAddress(
  project: string,
  name: string,
): Promise<string | null> {
  const deadline = Date.now() + bootTimeoutMs;
  while (Date.now() < deadline) {
    if (shuttingDown) return null;
    const out = await incus([
      "list",
      name,
      "--project",
      project,
      "--format",
      "json",
    ]).catch(() => "");
    const { status, ipv4 } = instanceState(out);
    if (status === "Running" && ipv4) return ipv4;
    await new Promise<void>((r) => setTimeout(r, 5000));
  }
  return null;
}

async function ensureProject(project: string): Promise<void> {
  try {
    await incus(["project", "create", project]);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (!message.includes("already exists")) throw e;
  }
  // Fresh projects inherit an empty default profile: give it the pilot root
  // disk and bridge NIC, idempotently. Tenant launches depend on these.
  await incus([
    "profile",
    "device",
    "add",
    "default",
    "root",
    "disk",
    "path=/",
    "pool=homehost",
    "--project",
    project,
  ]).catch((e: unknown) => {
    const message = e instanceof Error ? e.message : String(e);
    if (!message.includes("already exists")) throw e;
  });
  await incus([
    "profile",
    "device",
    "add",
    "default",
    "eth0",
    "nic",
    "network=incusbr0",
    "name=eth0",
    "--project",
    project,
  ]).catch((e: unknown) => {
    const message = e instanceof Error ? e.message : String(e);
    if (!message.includes("already exists")) throw e;
  });
}

async function handleProvision(job: Job): Promise<void> {
  const req = await loadRequest(job.requestId);
  if (!req || req.status === "deleted") {
    // Cancelled while queued: nothing to build.
    await finishJob(job.id, "done", "skipped: deleted");
    return;
  }
  if (req.status !== "approved" && req.status !== "provisioning") {
    await finishJob(job.id, "failed", `unexpected status ${req.status}`);
    return;
  }
  const plan: Plan | undefined = PLANS.find((p) => p.id === req.planId);
  if (!plan) {
    await failProvision(req, job, `unknown plan ${req.planId}`);
    return;
  }
  // Desktop plans are VM-only: containers ignore cloud-init, so a desktop
  // bake could never boot there. Omarchy has no non-interactive installer
  // (images:archlinux/cloud resolves; installer automation is the missing
  // prerequisite), so both refuse the job closed with an actionable message.
  if (plan.desktop && plan.kind !== "vm") {
    await failProvision(req, job, `desktop plan ${plan.id} requires a vm`);
    return;
  }
  if (plan.desktop?.env === "omarchy") {
    await failProvision(req, job, omarchyUnavailable(plan.id, plan.image));
    return;
  }
  const project = projectForReq(req);
  const name = req.instanceName ?? instanceNameOf(req.id, req.subdomain);
  try {
    await ensureProject(project);
    if (req.status === "approved") {
      await setRequest(req.id, "provisioning", { instanceName: name });
      await emit(req.id, "Homehost worker", "provisioning", req.name, null);
    }
    // Idempotent launch: a crashed earlier attempt may have left a partial instance.
    await incus(["delete", name, "--project", project, "--force"]).catch(
      () => {},
    );
    const args = [
      "launch",
      plan.image,
      name,
      "--project",
      project,
      "-c",
      `limits.cpu=${plan.cpu}`,
      "-c",
      `limits.memory=${plan.memoryMb}MiB`,
      "-d",
      `root,size=${plan.diskGb}GiB`,
    ];
    if (plan.kind === "vm") args.push("--vm");
    // SSH access for every plan: VMs via cloud-init user-data at launch,
    // containers via incus-exec sshd setup after boot (they ignore
    // cloud-init). Access is decided at launch: deleted-while-queued
    // requests never mint secrets. Password persists for its one
    // dashboard read.
    const isVm = plan.kind === "vm";
    const desktop = plan.desktop ?? null;
    // API stores desktop_env/hostname/port on the row (migration 0010);
    // when the row lacks them (pre-migration), derive from the plan and
    // toDesktopHostname the same way ApiDesktop does (first-label -vnc).
    const stored = desktop ? await loadDesktopFields(req.id) : null;
    const desktopEnv = stored?.env ?? desktop?.env ?? null;
    const desktopHostname =
      stored?.hostname ?? (desktop ? toDesktopHostname(req.subdomain) : null);
    const desktopPort = stored?.port ?? desktop?.kasmPort ?? null;
    let ipv6: string | null = null;
    if (isVm) {
      const access = buildInstanceAccess(req.sshPubkey);
      // Desktop KasmVNC gets its own persistent secret (desktop_password),
      // independent of the one-read root OTP (instance_password). The panel
      // proxy injects it as Basic auth; the browser never sees it.
      const desktopPassword =
        desktop && desktopEnv === "ubuntu-xfce"
          ? randomBytes(18).toString("base64url")
          : null;
      const userData =
        desktop && desktopEnv === "ubuntu-xfce" && desktopPassword !== null
          ? appendDesktopToUserData(
              access.userData,
              desktop,
              desktop.user,
              desktopPassword,
            )
          : access.userData;
      args.push("--config", `user.user-data=${userData}`);
      // Static v6 from the routed prefix; skipped entirely on v4-only hosts.
      ipv6 = ipv6ForInstance(ipv6Prefix, req.id);
      if (ipv6) {
        const gateway = `${ipv6Prefix.replace(/:+$/, "")}::ffff`;
        args.push(
          "--config",
          `user.network-config=${buildNetConfig(ipv6, gateway)}`,
        );
      }
      await setInstancePassword(req.id, access.password);
      await setDesktopPassword(req.id, desktopPassword);
    }
    await incus(args);
    const ipv4 = await waitForAddress(project, name);
    if (!ipv4) throw new Error("timed out waiting for instance address");
    if (!isVm) {
      // Same password shape as the VM path; nonzero guest exit throws so
      // the attempts-capped requeue covers apt flakes.
      const password = randomBytes(18).toString("base64url");
      // Containers get the same static v6 as VMs, applied in-guest via
      // netplan inside provisionContainerSsh (eth0 is inherited from the
      // profile; a live NIC tweak is rejected on incusbr0).
      const containerIpv6 = ipv6ForInstance(ipv6Prefix, req.id);
      if (containerIpv6) ipv6 = containerIpv6;
      await setInstancePassword(req.id, password);
      await provisionContainerSsh(
        project,
        name,
        password,
        req.sshPubkey,
        containerIpv6,
      );
    }
    // Direct IPv6 access for every plan: no leased ports, no NAT rules.
    if (ipv6) {
      await setIpv6(req.id, ipv6);
      if (cfToken) await ensureAAAA(req.subdomain, ipv6);
      else console.error("CF_DNS_API_TOKEN unset: skipping AAAA");
    }
    if (
      desktop &&
      desktopEnv === "ubuntu-xfce" &&
      desktopHostname &&
      desktopPort !== null
    ) {
      // Backend is the guest IPv4 (edge net has no v6; ratified with
      // EdgeDesktop). Desktop DNS is wildcard-only (*.dev + *.homehost A/AAAA
      // point at the edge host): no per-VM desktop record is written here.
      // SSH AAAA above is still per-VM (guest v6, direct access).
      await writeDesktopRoute({
        instanceName: name,
        desktopHostname,
        backendHost: ipv4,
        kasmPort: desktopPort,
      });
    }
    await setRequest(req.id, "running", { instanceName: name, ipv4 });
    await emit(req.id, "Homehost worker", "running", req.name, ipv4);
    await finishJob(job.id, "done", null);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (job.attempts >= provisionAttempts) {
      await failProvision(req, job, message);
    } else {
      await requeue(job.id, message);
    }
  }
}

async function failProvision(
  req: RequestState,
  job: Job,
  message: string,
): Promise<void> {
  // Terminal failure parks at approved: the reservation and the retry path survive.
  await setRequest(req.id, "approved", {
    instanceName: req.instanceName ?? undefined,
  });
  await emit(req.id, "Homehost worker", "provision_failed", req.name, message);
  await finishJob(job.id, "failed", message);
}

async function handleTeardown(job: Job): Promise<void> {
  const req = await loadRequest(job.requestId);
  const name = req?.instanceName;
  if (!req || !name) {
    await finishJob(job.id, "done", "nothing to tear down");
    return;
  }
  try {
    const project = projectForReq(req);
    try {
      await incus(["delete", name, "--project", project, "--force"]);
    } catch (e) {
      // Already gone is the desired end state.
      const out = await incus([
        "list",
        name,
        "--project",
        project,
        "--format",
        "csv",
      ]).catch(() => "");
      if (out.includes(name)) throw e;
    }
    if (cfToken) await deleteAAAA(req.subdomain);
    // Desktop VMs only: best-effort route-file cleanup. Desktop DNS is
    // wildcard-only (no per-VM desktop record exists to delete); SSH AAAA
    // above is still per-VM.
    const plan = PLANS.find((p) => p.id === req.planId);
    const fields = plan?.desktop ? await loadDesktopFields(req.id) : null;
    // Omarchy rows may exist from retries that failed closed after launch
    // cleanup: remove any route file even though omarchy never writes one.
    if (plan?.desktop || fields?.env) {
      await removeDesktopRoute(name).catch((e: unknown) => {
        console.error("desktop route remove failed", e);
      });
    }
    await finishJob(job.id, "done", null);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (job.attempts >= teardownAttempts) {
      await finishJob(job.id, "failed", message);
    } else {
      await requeue(job.id, message);
    }
  }
}

/**
 * Current Incus power state, lowercased ("running", "stopped"), or null when
 * the instance is gone. Drives the idempotent power verb, never the DB row.
 */
async function instancePowerState(
  project: string,
  name: string,
): Promise<string | null> {
  const out = await incus([
    "list",
    name,
    "--project",
    project,
    "--format",
    "csv",
  ]).catch(() => "");
  const line = out.split("\n").find((l) => l.split(",")[0] === name);
  const status = line?.split(",")[1]?.toLowerCase() ?? "";
  return status.length > 0 ? status : null;
}

async function handlePower(
  job: Job,
  verb: "stop" | "start",
  to: "stopped" | "running",
): Promise<void> {
  const req = await loadRequest(job.requestId);
  if (!req || !req.instanceName) {
    await finishJob(job.id, "failed", "request or instance missing");
    return;
  }
  try {
    const project = projectForReq(req);
    // Idempotent verb: a retried job finds the instance already flipped and
    // proceeds to access refresh instead of failing on a redundant command.
    const state = await instancePowerState(project, req.instanceName);
    if (state !== to) {
      await incus([verb, req.instanceName, "--project", project]);
    }
    let ipv4: string | null = null;
    if (verb === "start") {
      ipv4 = await waitForAddress(project, req.instanceName);
      // Slow boot requeues like provision: a running row must never point
      // at a stale or missing address.
      if (!ipv4) throw new Error("timed out waiting for instance address");
    }
    await setRequest(req.id, to, {
      instanceName: req.instanceName,
      ipv4,
    });
    await emit(req.id, req.ownerName, to, req.name, null);
    await finishJob(job.id, "done", null);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (job.attempts >= powerAttempts) {
      await finishJob(job.id, "failed", message);
    } else {
      await requeue(job.id, message);
    }
  }
}

async function handle(job: Job): Promise<void> {
  switch (job.action) {
    case "provision":
      return handleProvision(job);
    case "teardown":
      return handleTeardown(job);
    case "stop":
      return handlePower(job, "stop", "stopped");
    case "start":
      return handlePower(job, "start", "running");
  }
}

async function main(): Promise<void> {
  // Crash recovery: leases die with the process; requeue so jobs resume.
  // Instance names make relaunches idempotent.
  await sql`UPDATE provision_jobs SET status = 'queued', updated_at = now() WHERE status = 'leased'`;

  console.log(`worker up (${workerEnv}): polling provision_jobs`);
  while (!shuttingDown) {
    try {
      const job = await leaseJob();
      if (!job) {
        await new Promise<void>((r) => setTimeout(r, pollMs));
        continue;
      }
      // Env scoping: leave other-env jobs queued for their own worker.
      // No Incus/DB request state touched — just requeue the lease.
      const req = await loadRequest(job.requestId);
      if (req && !envMatches(req.subdomain)) {
        await requeue(job.id, `wrong-env:${req.subdomain}`);
        await new Promise<void>((r) => setTimeout(r, pollMs));
        continue;
      }
      await handle(job);
    } catch (e) {
      console.error("worker loop error", e);
      await new Promise<void>((r) => setTimeout(r, pollMs));
    }
  }
  await sql.end();
  console.log("worker down");
}

await main();
