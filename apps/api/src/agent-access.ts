import postgres from "postgres";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Effect, Either, type ManagedRuntime } from "effect";
import { z } from "zod";
import {
  ACCESS_SCOPES,
  ACCESS_TOKEN_PATTERN,
  CreateAccessTokenBody,
  EXEC_OUTPUT_MAX_BYTES,
  EXEC_TIMEOUT_DEFAULT_S,
  ExecBody,
  FILE_MAX_BYTES,
  FILE_READ_DEFAULT_BYTES,
  PLANS,
  PowerBody,
  ReadFileBody,
  WriteFileBody,
  type AccessScope,
  type AccessToken,
  type AgentMachine,
  type CreatedAccessToken,
  type ExecInput,
  type ExecResult,
  type FileReadResult,
  type FileWriteResult,
  type MachineCapability,
  type PortalUser,
  type PowerInput,
  type ReadFileInput,
  type RequestStatus,
} from "@homehost/shared";
import type { DatabaseTag } from "./domain/Database.js";
import type {
  DbFailure,
  InvalidTransition,
  RequestNotFound,
} from "./domain/errors.js";
import {
  AccessTokenLimit,
  AccessTokenNotFound,
  AmbiguousMachine,
  ExecBusy,
  MachineNotVisible,
  authenticateAccessToken,
  createAccessToken,
  enqueueExec,
  expireQueuedExec,
  listAccessTokens,
  listVisibleMachines,
  newExecId,
  readExec,
  resolveMachine,
  revokeAccessToken,
  type AccessTokenRow,
  type AuthenticatedToken,
  type ExecOperation,
  type ExecRow,
  type MachineRow,
} from "./domain/agent-access.js";
import { startInstance, stopInstance } from "./domain/requests.js";

type Runtime = ManagedRuntime.ManagedRuntime<DatabaseTag, never>;

export interface AgentAccessDeps {
  runtime: Runtime;
  resolveUser(req: FastifyRequest): Promise<PortalUser | null>;
  requireApprovedUser(
    req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<{ user: PortalUser } | null>;
  requireJsonBody(req: FastifyRequest, reply: FastifyReply): boolean;
  waiter: ExecWaiter;
  version: string;
}

interface AgentFailure {
  status: number;
  code: string;
  error: string;
}
type Outcome<T> = { ok: true; value: T } | { ok: false; failure: AgentFailure };

type AgentError =
  | AccessTokenNotFound
  | AccessTokenLimit
  | MachineNotVisible
  | AmbiguousMachine
  | ExecBusy
  | RequestNotFound
  | InvalidTransition
  | DbFailure;

const failure = (status: number, code: string, error: string) => ({
  ok: false as const,
  failure: { status, code, error },
});

function agentFailure(e: AgentError): AgentFailure {
  switch (e._tag) {
    case "AccessTokenNotFound":
      return { status: 404, code: "not_found", error: "token not found" };
    case "AccessTokenLimit":
      return {
        status: 429,
        code: "token_limit",
        error: "too many active tokens; revoke one first",
      };
    case "MachineNotVisible":
    case "RequestNotFound":
      return { status: 404, code: "not_found", error: "machine not found" };
    case "AmbiguousMachine":
      return {
        status: 409,
        code: "ambiguous_machine",
        error: "several machines share that name; use its id",
      };
    case "ExecBusy":
      return {
        status: 429,
        code: "exec_busy",
        error: "this token already has 4 operations in flight",
      };
    case "InvalidTransition":
      return { status: 409, code: "conflict", error: e.message };
    case "DbFailure":
      throw e.cause;
    default: {
      const _exhaustive: never = e;
      throw _exhaustive;
    }
  }
}

function sendFailure(reply: FastifyReply, f: AgentFailure) {
  return reply.code(f.status).send({ error: f.error, code: f.code });
}

function zodMessage(
  issues: { path: readonly PropertyKey[]; message: string }[],
): string {
  return issues
    .map((i) =>
      i.path.length > 0
        ? `${i.path.map(String).join(".")}: ${i.message}`
        : i.message,
    )
    .join("; ");
}

function toAccessToken(row: AccessTokenRow): AccessToken {
  return {
    id: row.id,
    name: row.name,
    hint: row.tokenHint,
    scopes: row.scopes.filter((s): s is AccessScope =>
      (ACCESS_SCOPES as readonly string[]).includes(s),
    ),
    machineIds: row.machineIds,
    expiresAt: row.expiresAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

function toAgentMachine(row: MachineRow): AgentMachine {
  const plan = PLANS.find((p) => p.id === row.planId);
  const capabilities: MachineCapability[] = ["exec", "files", "power"];
  if (row.desktopHostname) capabilities.push("desktop");
  return {
    id: row.id,
    name: row.name,
    kind: plan?.kind ?? "container",
    planId: row.planId,
    status: row.status as RequestStatus,
    hostname: row.subdomain,
    capabilities,
  };
}

const isFinished = (row: ExecRow) =>
  row.status === "done" || row.status === "failed";

function execFailure(row: ExecRow): AgentFailure {
  switch (row.error) {
    case "machine_not_running":
      return {
        status: 409,
        code: "machine_not_running",
        error: "machine is not running",
      };
    case "file_not_found":
      return { status: 404, code: "file_not_found", error: "file not found" };
    case "is_directory":
      return {
        status: 409,
        code: "is_directory",
        error: "path is a directory",
      };
    case "expired":
      return {
        status: 504,
        code: "exec_timeout",
        error: "no worker finished the operation in time",
      };
    default:
      return {
        status: 502,
        code: "exec_failed",
        error: "the worker could not run the operation",
      };
  }
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

function encodeFile(
  bytes: Buffer,
): Pick<FileReadResult, "encoding" | "content"> {
  try {
    return { encoding: "utf8", content: utf8.decode(bytes) };
  } catch {
    return { encoding: "base64", content: bytes.toString("base64") };
  }
}

/**
 * Wakes waiting requests on `machine_exec_done`. The callers re-read the row
 * at least once a second, so a dropped LISTEN connection only adds latency.
 */
export function createExecWaiter(url: string, onError: (err: unknown) => void) {
  const subscribers = new Map<string, Set<() => void>>();
  let sql: postgres.Sql | null = null;
  let closed = false;
  function start() {
    if (sql || closed) return;
    const conn = postgres(url, { max: 1, onnotice: () => {} });
    sql = conn;
    conn
      .listen("machine_exec_done", (id) => {
        for (const wake of subscribers.get(id) ?? []) wake();
      })
      .catch((err: unknown) => {
        sql = null;
        void conn.end({ timeout: 1 });
        onError(err);
      });
  }
  return {
    subscribe(id: string) {
      start();
      let notified = false;
      let wakeWaiter: (() => void) | null = null;
      const onNotify = () => {
        notified = true;
        wakeWaiter?.();
      };
      let set = subscribers.get(id);
      if (!set) subscribers.set(id, (set = new Set()));
      set.add(onNotify);
      const own = set;
      return {
        next(ms: number) {
          if (notified) {
            notified = false;
            return Promise.resolve();
          }
          return new Promise<void>((resolve) => {
            const finish = () => {
              clearTimeout(timer);
              wakeWaiter = null;
              notified = false;
              resolve();
            };
            const timer = setTimeout(finish, ms);
            wakeWaiter = finish;
          });
        },
        close() {
          own.delete(onNotify);
          if (own.size === 0) subscribers.delete(id);
        },
      };
    },
    async close() {
      closed = true;
      const conn = sql;
      sql = null;
      await conn?.end({ timeout: 5 });
    },
  };
}
export type ExecWaiter = ReturnType<typeof createExecWaiter>;

const MachineParams = z.object({ machine: z.string().min(1).max(200) });
const TokenParams = z.object({ id: z.string().uuid() });
const MachineRef = z.string().min(1).max(200);
const NoArgs = z.object({}).strict();
const MachineArgs = z.object({ machine: MachineRef }).strict();
const RunArgs = ExecBody.extend({ machine: MachineRef }).strict();
const ReadArgs = ReadFileBody.extend({ machine: MachineRef }).strict();
const WriteArgs = WriteFileBody.extend({ machine: MachineRef }).strict();
const PowerArgs = PowerBody.extend({ machine: MachineRef }).strict();
const WRITE_BODY_LIMIT = Math.ceil((FILE_MAX_BYTES * 4) / 3) + 64 * 1024;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

export const MCP_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

export function registerAgentAccess(
  app: FastifyInstance,
  deps: AgentAccessDeps,
) {
  const { runtime, waiter } = deps;

  async function run<A>(
    effect: Effect.Effect<A, AgentError, DatabaseTag>,
  ): Promise<Outcome<A>> {
    const result = await runtime.runPromise(Effect.either(effect));
    return Either.isRight(result)
      ? { ok: true, value: result.right }
      : { ok: false, failure: agentFailure(result.left) };
  }

  async function authenticate(
    req: FastifyRequest,
  ): Promise<AuthenticatedToken | null> {
    const match = /^Bearer (\S+)$/.exec(req.headers.authorization ?? "");
    const secret = match?.[1];
    if (!secret || !ACCESS_TOKEN_PATTERN.test(secret)) return null;
    const outcome = await run(
      authenticateAccessToken({ secret, now: new Date() }),
    );
    return outcome.ok ? outcome.value : null;
  }

  function unauthorized(reply: FastifyReply) {
    return reply
      .code(401)
      .header("WWW-Authenticate", 'Bearer realm="homehost"')
      .send({ error: "valid access token required", code: "unauthorized" });
  }

  function hasScope(ctx: AuthenticatedToken, scope: AccessScope) {
    return ctx.token.scopes.includes(scope);
  }

  function scoped(ctx: AuthenticatedToken, scope: AccessScope) {
    return hasScope(ctx, scope)
      ? null
      : failure(403, "scope_required", `token lacks the ${scope} scope`);
  }

  async function execute(
    ctx: AuthenticatedToken,
    machine: MachineRow,
    operation: ExecOperation,
    maxBytes: number,
    timeoutMs: number,
  ): Promise<Outcome<ExecRow>> {
    if (machine.status !== "running")
      return failure(409, "machine_not_running", "machine is not running");
    const id = newExecId();
    const subscription = waiter.subscribe(id);
    try {
      const queued = await run(
        enqueueExec({
          id,
          token: ctx.token,
          machine,
          operation,
          maxBytes,
          timeoutMs,
        }),
      );
      if (!queued.ok) return queued;
      const deadline = Date.now() + timeoutMs + 15_000;
      for (;;) {
        const read = await run(readExec(id));
        if (!read.ok) return read;
        if (read.value && isFinished(read.value)) {
          return read.value.status === "done"
            ? { ok: true, value: read.value }
            : { ok: false, failure: execFailure(read.value) };
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          await run(expireQueuedExec(id));
          const last = await run(readExec(id));
          if (last.ok && last.value && isFinished(last.value))
            return last.value.status === "done"
              ? { ok: true, value: last.value }
              : { ok: false, failure: execFailure(last.value) };
          return failure(
            504,
            "exec_timeout",
            "no worker finished the operation in time",
          );
        }
        await subscription.next(Math.min(1000, remaining));
      }
    } finally {
      subscription.close();
    }
  }

  const ops = {
    async listMachines(ctx: AuthenticatedToken) {
      const denied = scoped(ctx, "machines:read");
      if (denied) return denied;
      const listed = await run(listVisibleMachines(ctx.token));
      if (!listed.ok) return listed;
      return {
        ok: true as const,
        value: { machines: listed.value.map(toAgentMachine) },
      };
    },
    async machineStatus(
      ctx: AuthenticatedToken,
      ref: string,
    ): Promise<Outcome<AgentMachine>> {
      const denied = scoped(ctx, "machines:read");
      if (denied) return denied;
      const found = await run(resolveMachine(ctx.token, ref));
      if (!found.ok) return found;
      return { ok: true, value: toAgentMachine(found.value) };
    },
    async runCommand(
      ctx: AuthenticatedToken,
      ref: string,
      input: ExecInput,
    ): Promise<Outcome<ExecResult>> {
      const denied = scoped(ctx, "machines:exec");
      if (denied) return denied;
      const found = await run(resolveMachine(ctx.token, ref));
      if (!found.ok) return found;
      const done = await execute(
        ctx,
        found.value,
        { op: "command", command: input.command, cwd: input.cwd ?? null },
        EXEC_OUTPUT_MAX_BYTES,
        (input.timeoutSeconds ?? EXEC_TIMEOUT_DEFAULT_S) * 1000,
      );
      if (!done.ok) return done;
      const row = done.value;
      return {
        ok: true,
        value: {
          id: row.id,
          exitCode: row.exitCode,
          timedOut: row.timedOut,
          stdout: row.stdout?.toString("utf8") ?? "",
          stderr: row.stderr?.toString("utf8") ?? "",
          stdoutTruncated: row.stdoutTruncated,
          stderrTruncated: row.stderrTruncated,
          durationMs:
            row.finishedAt && row.startedAt
              ? row.finishedAt.getTime() - row.startedAt.getTime()
              : 0,
        },
      };
    },
    async readFile(
      ctx: AuthenticatedToken,
      ref: string,
      input: ReadFileInput,
    ): Promise<Outcome<FileReadResult>> {
      const denied = scoped(ctx, "machines:exec");
      if (denied) return denied;
      const found = await run(resolveMachine(ctx.token, ref));
      if (!found.ok) return found;
      const done = await execute(
        ctx,
        found.value,
        { op: "read_file", path: input.path },
        input.maxBytes ?? FILE_READ_DEFAULT_BYTES,
        60_000,
      );
      if (!done.ok) return done;
      const bytes = done.value.stdout ?? Buffer.alloc(0);
      return {
        ok: true,
        value: {
          path: input.path,
          ...encodeFile(bytes),
          bytes: bytes.length,
          truncated: done.value.stdoutTruncated,
        },
      };
    },
    async writeFile(
      ctx: AuthenticatedToken,
      ref: string,
      input: z.infer<typeof WriteFileBody>,
    ): Promise<Outcome<FileWriteResult>> {
      const denied = scoped(ctx, "machines:exec");
      if (denied) return denied;
      if (input.encoding === "base64" && !BASE64.test(input.content))
        return failure(400, "invalid", "content is not valid base64");
      const bytes = Buffer.from(input.content, input.encoding);
      if (bytes.length > FILE_MAX_BYTES)
        return failure(400, "invalid", "file content exceeds 4 MiB");
      const found = await run(resolveMachine(ctx.token, ref));
      if (!found.ok) return found;
      const done = await execute(
        ctx,
        found.value,
        {
          op: "write_file",
          path: input.path,
          input: bytes,
          fileMode: input.mode ?? null,
        },
        Math.max(bytes.length, 1),
        60_000,
      );
      if (!done.ok) return done;
      return { ok: true, value: { path: input.path, bytes: bytes.length } };
    },
    async setPower(
      ctx: AuthenticatedToken,
      ref: string,
      input: PowerInput,
    ): Promise<Outcome<AgentMachine>> {
      const denied = scoped(ctx, "machines:power");
      if (denied) return denied;
      const found = await run(resolveMachine(ctx.token, ref));
      if (!found.ok) return found;
      const target = { id: found.value.id, user: ctx.user };
      const changed = await run(
        input.action === "start" ? startInstance(target) : stopInstance(target),
      );
      if (!changed.ok) return changed;
      return { ok: true, value: toAgentMachine(changed.value) };
    },
  };

  app.get("/api/access-tokens", async (req, reply) => {
    const user = await deps.resolveUser(req);
    if (!user)
      return reply
        .code(401)
        .send({ error: "session required", code: "unauthorized" });
    const listed = await run(listAccessTokens(user.id));
    if (!listed.ok) return sendFailure(reply, listed.failure);
    return { tokens: listed.value.map(toAccessToken) };
  });

  app.post("/api/access-tokens", async (req, reply) => {
    const session = await deps.requireApprovedUser(req, reply);
    if (!session) return;
    if (!deps.requireJsonBody(req, reply)) return;
    const parsed = CreateAccessTokenBody.safeParse(req.body);
    if (!parsed.success)
      return reply
        .code(400)
        .send({ error: zodMessage(parsed.error.issues), code: "invalid" });
    const created = await run(
      createAccessToken({
        user: session.user,
        body: parsed.data,
        now: new Date(),
      }),
    );
    if (!created.ok) return sendFailure(reply, created.failure);
    const body: CreatedAccessToken = {
      token: toAccessToken(created.value.row),
      secret: created.value.secret,
    };
    return reply.code(201).header("Cache-Control", "no-store").send(body);
  });

  app.delete<{ Params: { id: string } }>(
    "/api/access-tokens/:id",
    async (req, reply) => {
      const user = await deps.resolveUser(req);
      if (!user)
        return reply
          .code(401)
          .send({ error: "session required", code: "unauthorized" });
      const params = TokenParams.safeParse(req.params);
      if (!params.success)
        return reply
          .code(404)
          .send({ error: "token not found", code: "not_found" });
      const revoked = await run(
        revokeAccessToken({
          userId: user.id,
          id: params.data.id,
          now: new Date(),
        }),
      );
      if (!revoked.ok) return sendFailure(reply, revoked.failure);
      return toAccessToken(revoked.value);
    },
  );

  // Bearer routes: Authorization header only, cookies are never consulted.
  async function bearerRoute<T>(
    req: FastifyRequest,
    reply: FastifyReply,
    handler: (ctx: AuthenticatedToken, machine: string) => Promise<Outcome<T>>,
  ) {
    const ctx = await authenticate(req);
    if (!ctx) return unauthorized(reply);
    const params = MachineParams.safeParse(req.params);
    const outcome = await handler(
      ctx,
      params.success ? params.data.machine : "",
    );
    if (!outcome.ok) return sendFailure(reply, outcome.failure);
    return reply.header("Cache-Control", "no-store").send(outcome.value);
  }

  function parseBody<S extends z.ZodTypeAny>(
    schema: S,
    req: FastifyRequest,
  ): Outcome<z.infer<S>> {
    const parsed = schema.safeParse(req.body ?? {});
    return parsed.success
      ? { ok: true, value: parsed.data }
      : failure(400, "invalid", zodMessage(parsed.error.issues));
  }

  app.get("/api/machines", (req, reply) =>
    bearerRoute(req, reply, (ctx) => ops.listMachines(ctx)),
  );
  app.get("/api/machines/:machine", (req, reply) =>
    bearerRoute(req, reply, (ctx, ref) => ops.machineStatus(ctx, ref)),
  );
  app.post("/api/machines/:machine/exec", (req, reply) =>
    bearerRoute(req, reply, async (ctx, ref) => {
      const body = parseBody(ExecBody, req);
      return body.ok ? ops.runCommand(ctx, ref, body.value) : body;
    }),
  );
  app.post("/api/machines/:machine/files/read", (req, reply) =>
    bearerRoute(req, reply, async (ctx, ref) => {
      const body = parseBody(ReadFileBody, req);
      return body.ok ? ops.readFile(ctx, ref, body.value) : body;
    }),
  );
  app.post(
    "/api/machines/:machine/files/write",
    { bodyLimit: WRITE_BODY_LIMIT },
    (req, reply) =>
      bearerRoute(req, reply, async (ctx, ref) => {
        const body = parseBody(WriteFileBody, req);
        return body.ok ? ops.writeFile(ctx, ref, body.value) : body;
      }),
  );
  app.post("/api/machines/:machine/power", (req, reply) =>
    bearerRoute(req, reply, async (ctx, ref) => {
      const body = parseBody(PowerBody, req);
      return body.ok ? ops.setPower(ctx, ref, body.value) : body;
    }),
  );

  const machineProp = {
    type: "string",
    description: "Machine id or its unique name, from list_machines.",
  };
  const tools: {
    name: string;
    scope: AccessScope;
    description: string;
    inputSchema: Record<string, unknown>;
    annotations: Record<string, boolean>;
    call: (ctx: AuthenticatedToken, args: unknown) => Promise<Outcome<unknown>>;
  }[] = [
    {
      name: "list_machines",
      scope: "machines:read",
      description:
        "List the homehost machines this token can reach: id, name, kind (container or vm), status, hostname and capabilities.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
      call: async (ctx, args) => {
        const parsed = NoArgs.safeParse(args);
        return parsed.success
          ? ops.listMachines(ctx)
          : failure(400, "invalid", zodMessage(parsed.error.issues));
      },
    },
    {
      name: "machine_status",
      scope: "machines:read",
      description:
        "Show one machine's status, kind, hostname and capabilities.",
      inputSchema: {
        type: "object",
        properties: { machine: machineProp },
        required: ["machine"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
      call: async (ctx, args) => {
        const parsed = MachineArgs.safeParse(args);
        return parsed.success
          ? ops.machineStatus(ctx, parsed.data.machine)
          : failure(400, "invalid", zodMessage(parsed.error.issues));
      },
    },
    {
      name: "run_command",
      scope: "machines:exec",
      description:
        "Run a shell command as root on a running machine through /bin/sh -c. Non-interactive: stdin is closed and there is no TTY. Returns exitCode, stdout and stderr (each keeps the last 256 KiB) and timedOut.",
      inputSchema: {
        type: "object",
        properties: {
          machine: machineProp,
          command: { type: "string", description: "Shell command line." },
          cwd: { type: "string", description: "Absolute working directory." },
          timeoutSeconds: {
            type: "integer",
            minimum: 1,
            maximum: 600,
            description:
              "Kill the command after this many seconds (default 60).",
          },
        },
        required: ["machine", "command"],
        additionalProperties: false,
      },
      annotations: { destructiveHint: true, openWorldHint: true },
      call: async (ctx, args) => {
        const parsed = RunArgs.safeParse(args);
        if (!parsed.success)
          return failure(400, "invalid", zodMessage(parsed.error.issues));
        const { machine, ...input } = parsed.data;
        return ops.runCommand(ctx, machine, input);
      },
    },
    {
      name: "read_file",
      scope: "machines:exec",
      description:
        "Read a file from a running machine. Returns UTF-8 text, or base64 for binary content, and whether it was truncated at maxBytes.",
      inputSchema: {
        type: "object",
        properties: {
          machine: machineProp,
          path: { type: "string", description: "Absolute file path." },
          maxBytes: {
            type: "integer",
            minimum: 1,
            maximum: FILE_MAX_BYTES,
            description: "Read at most this many bytes (default 1 MiB).",
          },
        },
        required: ["machine", "path"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
      call: async (ctx, args) => {
        const parsed = ReadArgs.safeParse(args);
        if (!parsed.success)
          return failure(400, "invalid", zodMessage(parsed.error.issues));
        const { machine, ...input } = parsed.data;
        return ops.readFile(ctx, machine, input);
      },
    },
    {
      name: "write_file",
      scope: "machines:exec",
      description:
        "Create or overwrite a file on a running machine (owned by root, up to 4 MiB). Parent directories must exist.",
      inputSchema: {
        type: "object",
        properties: {
          machine: machineProp,
          path: { type: "string", description: "Absolute file path." },
          content: { type: "string", description: "File content." },
          encoding: {
            type: "string",
            enum: ["utf8", "base64"],
            description: "How content is encoded (default utf8).",
          },
          mode: {
            type: "integer",
            minimum: 0,
            maximum: 4095,
            description: "Permission bits as a number, e.g. 420 for 0644.",
          },
        },
        required: ["machine", "path", "content"],
        additionalProperties: false,
      },
      annotations: { destructiveHint: true },
      call: async (ctx, args) => {
        const parsed = WriteArgs.safeParse(args);
        if (!parsed.success)
          return failure(400, "invalid", zodMessage(parsed.error.issues));
        const { machine, ...input } = parsed.data;
        return ops.writeFile(ctx, machine, input);
      },
    },
    {
      name: "set_power",
      scope: "machines:power",
      description:
        "Start a stopped machine or stop a running one. Returns the machine; the change completes in the background.",
      inputSchema: {
        type: "object",
        properties: {
          machine: machineProp,
          action: { type: "string", enum: ["start", "stop"] },
        },
        required: ["machine", "action"],
        additionalProperties: false,
      },
      annotations: { destructiveHint: true },
      call: async (ctx, args) => {
        const parsed = PowerArgs.safeParse(args);
        if (!parsed.success)
          return failure(400, "invalid", zodMessage(parsed.error.issues));
        const { machine, ...input } = parsed.data;
        return ops.setPower(ctx, machine, input);
      },
    },
  ];

  const RpcRequest = z.object({
    jsonrpc: z.literal("2.0"),
    id: z.union([z.string(), z.number()]).optional(),
    method: z.string(),
    params: z.record(z.unknown()).optional(),
  });
  const ToolCallParams = z.object({
    name: z.string(),
    arguments: z.record(z.unknown()).optional(),
  });
  const rpcError = (
    id: string | number | null,
    code: number,
    message: string,
  ) => ({
    jsonrpc: "2.0",
    id,
    error: { code, message },
  });

  const methodNotAllowed = (_req: FastifyRequest, reply: FastifyReply) =>
    reply
      .code(405)
      .header("Allow", "POST")
      .send({ error: "use POST", code: "method_not_allowed" });
  app.get("/api/mcp", methodNotAllowed);
  app.delete("/api/mcp", methodNotAllowed);

  app.post("/api/mcp", { bodyLimit: WRITE_BODY_LIMIT }, async (req, reply) => {
    const ctx = await authenticate(req);
    if (!ctx) return unauthorized(reply);
    const parsed = RpcRequest.safeParse(req.body);
    if (!parsed.success)
      return reply.code(400).send(rpcError(null, -32600, "invalid request"));
    const message = parsed.data;
    if (message.id === undefined) return reply.code(202).send();
    const id = message.id;
    const respond = (result: unknown) =>
      reply
        .header("Cache-Control", "no-store")
        .send({ jsonrpc: "2.0", id, result });

    switch (message.method) {
      case "initialize": {
        const requested = message.params?.["protocolVersion"];
        const protocolVersion =
          typeof requested === "string" &&
          MCP_PROTOCOL_VERSIONS.includes(requested)
            ? requested
            : MCP_PROTOCOL_VERSIONS[0];
        return respond({
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "homehost", version: deps.version },
          instructions:
            "Homehost machines you can reach with this token. Call list_machines first, then address a machine by id or name. Commands run as root, non-interactively.",
        });
      }
      case "ping":
        return respond({});
      case "tools/list":
        return respond({
          tools: tools
            .filter((t) => hasScope(ctx, t.scope))
            .map(({ name, description, inputSchema, annotations }) => ({
              name,
              description,
              inputSchema,
              annotations,
            })),
        });
      case "tools/call": {
        const params = ToolCallParams.safeParse(message.params);
        if (!params.success)
          return reply.send(rpcError(id, -32602, "invalid tool call"));
        const tool = tools.find((t) => t.name === params.data.name);
        if (!tool)
          return reply.send(
            rpcError(id, -32602, `unknown tool: ${params.data.name}`),
          );
        const outcome = await tool.call(ctx, params.data.arguments ?? {});
        if (!outcome.ok) {
          const body = {
            error: outcome.failure.error,
            code: outcome.failure.code,
          };
          return respond({
            content: [{ type: "text", text: JSON.stringify(body) }],
            isError: true,
          });
        }
        return respond({
          content: [{ type: "text", text: JSON.stringify(outcome.value) }],
          structuredContent: outcome.value,
        });
      }
      default:
        return reply.send(
          rpcError(id, -32601, `method not found: ${message.method}`),
        );
    }
  });
}
