# Agent access

Agents (Claude Code, Codex, scripts) work on a user's homehost machines
without a GUI. The same token unlocks three entry points:

- the remote **MCP server** at `POST /api/mcp`,
- the **`hh` CLI** (`apps/cli`, a static Go binary),
- the token **REST API** under `/api/machines`, which both of them use.

Commands run through the host worker and the Incus API (`incus exec` and
the Incus file API), so access works for containers and VMs alike, needs
no guest changes, and needs no IPv6 on the agent's machine. It is
non-interactive: stdin is closed and there is no PTY. People keep using
`ssh root@<hostname>` for interactive shells.

## Tokens

The panel's **Agent access** page (`/tokens`) issues and revokes tokens.
The session routes are:

| Route                           | Body / result                                                                |
| ------------------------------- | ---------------------------------------------------------------------------- |
| `GET /api/access-tokens`        | `AccessTokenListResponse`, newest first, revoked and expired rows included   |
| `POST /api/access-tokens`       | `CreateAccessTokenBody` -> `201 CreatedAccessToken` (the secret, shown once) |
| `DELETE /api/access-tokens/:id` | revokes the token -> `AccessToken`                                           |

- Only an approved panel session can mint a token. A token cannot mint or
  list tokens. Operators can only manage their own tokens, like every other
  owner-only resource.
- The format is `hht_` plus 32 random bytes as base64url (43 characters).
  Only its sha256 is stored, together with the last four characters
  (`hint`) so the token can be recognised in the list. The shared
  `containsSecret` guard recognises the prefix.
- Scopes:
  - `machines:read`: list machines and read their status.
  - `machines:exec`: run commands and read or write files.
  - `machines:power`: start or stop a machine through the existing
    provision_jobs actions.
- `machineIds` lists specific machines. `null` means every machine the owner
  has, now or later.
- Expiry is required, 1 to 90 days. Each user can hold at most 20 active
  (unrevoked, unexpired) tokens.
- Every call re-checks all of the following. Revoking a token, or suspending
  its owner, takes effect on the next call:
  - the hash exists, the token is not revoked and not expired;
  - the owner is approved (operators exempt);
  - the scope is granted;
  - the machine is in the token's set, still owned by the user and not
    deleted.
- An operation already running finishes within its own timeout.
- `last_used_at` is updated on each authenticated call.

Bearer routes read only `Authorization: Bearer hht_...` and ignore cookies,
so the panel's cross-site checks don't apply to them and a browser cannot
replay a session cookie against them. They return
`401 { code: "unauthorized" }` for any token problem; the response never
says which check failed.

## Token REST API

`machine` is a machine id or its name. A name must be unique among the
machines the token can see, otherwise the call returns `409 ambiguous_machine`.

| Route                                     | Scope            | Body -> result                                   |
| ----------------------------------------- | ---------------- | ------------------------------------------------ |
| `GET /api/machines`                       | `machines:read`  | -> `AgentMachineListResponse` (non-deleted only) |
| `GET /api/machines/:machine`              | `machines:read`  | -> `AgentMachine`                                |
| `POST /api/machines/:machine/exec`        | `machines:exec`  | `ExecBody` -> `ExecResult`                       |
| `POST /api/machines/:machine/files/read`  | `machines:exec`  | `ReadFileBody` -> `FileReadResult`               |
| `POST /api/machines/:machine/files/write` | `machines:exec`  | `WriteFileBody` -> `FileWriteResult`             |
| `POST /api/machines/:machine/power`       | `machines:power` | `PowerBody` -> `AgentMachine`                    |

Errors use the usual `{ error, code }` shape:

| Status | Code                  | Meaning                                                                   |
| ------ | --------------------- | ------------------------------------------------------------------------- |
| 401    | `unauthorized`        | missing, malformed, unknown, revoked or expired token; owner not approved |
| 403    | `scope_required`      | the token lacks the route's scope                                         |
| 404    | `not_found`           | the machine is not visible to this token                                  |
| 404    | `file_not_found`      | read path does not exist                                                  |
| 409    | `ambiguous_machine`   | the name matches more than one machine                                    |
| 409    | `machine_not_running` | exec and files need a `running` machine                                   |
| 409    | `conflict`            | the power action does not fit the machine's state, or one is queued       |
| 409    | `is_directory`        | read path is a directory                                                  |
| 429    | `exec_busy`           | this token already has 4 operations queued or running                     |
| 502    | `exec_failed`         | the worker could not run the operation                                    |
| 504    | `exec_timeout`        | no worker finished it in time                                             |

A non-zero exit code is a successful call (`200`, with `exitCode` set). A
command killed at its timeout returns `200` with `timedOut: true` and
`exitCode: null`.

## Exec pipeline (`machine_execs`, migration 0020)

1. The API inserts one `queued` row: the command, or the file path plus the
   input bytes, `timeout_ms`, and `max_bytes` (the per-stream output cap for
   commands, the read cap for files). It holds the token's row lock while it
   counts active rows, so the concurrency cap can't be raced. The insert
   trigger sends `NOTIFY machine_execs`.
2. The worker's exec pool (`WORKER_EXEC_CONCURRENCY` loops, default 8,
   separate from the serial provisioning loop so a long build never blocks
   agents) claims the oldest queued row:
   `queued -> running`, `FOR UPDATE SKIP LOCKED`, scoped to
   `WORKER_BASE_DOMAIN` like provision jobs. The request must be `running`
   with an instance name, otherwise the row fails with
   `machine_not_running`.
3. It runs the operation once (never retried):
   - command: `/bin/sh -c <command>` as root, with `cwd`, stdin closed,
     killed at `timeout_ms`;
   - files: the Incus file API, so file content never travels as argv.
     It stores up to `max_bytes` per stream (the tail for commands, the head
     for file reads) plus truncation flags, then sets `done`, or `failed` with
     a stable code (`machine_not_running`, `file_not_found`, `is_directory`,
     `exec_failed`, `worker_restarted`, `expired`). `input` is cleared. The
     update trigger sends `NOTIFY machine_exec_done`.
4. The API replica waits on its own `LISTEN machine_exec_done` connection,
   with a 1-second re-read as the fallback, until `timeout_ms + 15s`. If the
   row is still queued at that point, the API fails it as `expired` so a
   late worker never runs it.

Error codes never contain guest output. On worker startup, `running` rows
fail with `worker_restarted`, and queued rows older than 10 minutes fail
with `expired`. Finished rows are deleted 24 hours after they finish. The
command text and output are retained for that window, and the token's
`last_used_at` records activity after it.

## MCP server

`POST /api/mcp` speaks MCP over streamable HTTP in stateless JSON mode:
there is no session id, every response is `application/json`, and
`GET /api/mcp` answers `405`. It authenticates with the same bearer token.
It implements `initialize` (protocol `2025-06-18`, capability `tools`),
`notifications/initialized` (`202`, no body), `ping`, `tools/list` and
`tools/call`. Any other method returns JSON-RPC `-32601`.

| Tool             | Arguments                                          | Scope            |
| ---------------- | -------------------------------------------------- | ---------------- |
| `list_machines`  | none                                               | `machines:read`  |
| `machine_status` | `machine`                                          | `machines:read`  |
| `run_command`    | `machine`, `command`, `cwd?`, `timeoutSeconds?`    | `machines:exec`  |
| `read_file`      | `machine`, `path`, `maxBytes?`                     | `machines:exec`  |
| `write_file`     | `machine`, `path`, `content`, `encoding?`, `mode?` | `machines:exec`  |
| `set_power`      | `machine`, `action` (`start`/`stop`)               | `machines:power` |

`tools/list` only lists the tools the token's scopes allow. Tool failures
(scope, machine, exec errors) come back as a tool result with
`isError: true` and the same `{ error, code }` text. An invalid token is
HTTP `401`. Every result carries both `structuredContent` and a JSON text
block.

Client setup (Claude Code):

```sh
claude mcp add --transport http homehost https://<panel>/api/mcp \
  --header "Authorization: Bearer $HOMEHOST_TOKEN"
```

## `hh` CLI

`apps/cli` is a stdlib-only Go module. Build it with `bun run cli:build`,
which produces `apps/cli/bin/hh-darwin-arm64` and `hh-linux-amd64`.

```text
hh login [--url https://<panel>]     # reads the token from stdin, checks it, saves ~/.config/homehost/cli.json (0600)
hh logout
hh machines                          # table: name, kind, status, hostname
hh status <machine>
hh exec [--cwd DIR] [--timeout SEC] <machine> -- <command...>
hh cat <machine> <path>              # file bytes to stdout
hh put [--mode 0644] <machine> <local-file|-> <path>
hh start|stop <machine>
hh mcp-config                        # prints the MCP client snippet for this URL
```

`HOMEHOST_URL` and `HOMEHOST_TOKEN` override the saved config. `hh exec`
prints stdout and stderr to the matching streams and exits with the remote
exit code (`124` on timeout, `1` on API errors).

## Later: Android emulators

An emulator will be one more `MachineKind`, with extra capabilities such as
`screen`/`input`, watched through the existing desktop-ticket VNC proxy.
The token model, the exec pipeline, MCP and `hh` stay as they are.
