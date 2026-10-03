# packages/shared (`@homehost/shared`)

## OVERVIEW
The cross-process contract: API types, plans, provisioning math, readiness, streaming, concierge/agent/ledger/setup schemas. Imported by api, web (browser bundle) and worker. Earned its file: shared by every app, 22 src files, single `index.ts` boundary.

## WHERE TO LOOK
| Task | Location | Notes |
|------|----------|-------|
| Public surface | `src/index.ts` | the only import path consumers use |
| Plans catalog | `src/plans.ts` | `PLANS`, `Plan`, `DesktopConfig` (cpu/mem/disk, container vs vm, desktop) |
| API request/response types | `src/control-plane.ts` | `PortalUser`, `ServerRequest`, `DashboardResponse`, `AccountStatus`, ... |
| Subdomain / IPv6 / hostname | `src/provisioning.ts` | `ipv6ForInstance`, `toSubdomain`, `toDesktopHostname` |
| DNS/TCP readiness | `src/readiness.ts` | `pollChecks`, `sameIpv6`, `normalizeIpv6`, `dohHasAaaa` |
| Desktop stream tiers | `src/streaming.ts` | `STREAM_PROFILES`, `recommendStreamProfile` |
| Secret detection | `src/secrets.ts` | `containsSecret` (guards LLM/user text) |
| SSH key validation | `src/ssh.ts` | `isValidSshPublicKey`, `SSH_KEY_MAX` |
| Desktop iframe sandbox | `src/desktop-sandbox.ts` | `DESKTOP_SANDBOX`, `DESKTOP_CSP`, `DESKTOP_BRIDGE_CHANNEL` |
| Domain schemas | `ledger.ts`, `concierge.ts`, `concierge-catalog.ts`, `setup.ts`, `agent-chat.ts` | re-exported with `export *` |

## CONVENTIONS
- No build step: `main`/`types` point at `src/index.ts`; consumers compile it directly.
- Relative imports use the `.js` suffix (`./plans.js`), unlike `packages/sites`.
- `"sideEffects": false`; modules must stay pure (no top-level I/O).
- Browser-safe: no `node:*` imports outside `*.test.ts` (web bundles this package).
- Only runtime dependency is `zod`.
- Tests are co-located `*.test.ts`, run by `bun test packages/shared`.
- Named exports for small surfaces; `export *` only for cohesive domain modules.

## CHANGE CHECKLIST
- New export: add it to `src/index.ts`, or consumers cannot see it.
- Changing a type here changes api, web and worker at once: run root `typecheck`.
- Worker runs from source: shared changes it imports need a worker restart on the host (see `apps/worker`).
- Plan ids are persisted (migration `0014_plan_ids`); never rename/reuse an id in `PLANS`.

## ANTI-PATTERNS
- Redeclaring API shapes inside apps instead of importing from here.
- Deep imports (`@homehost/shared/src/...`).
- Surfacing `SSH_PORT_*` / `pickFreePort` in UI or responses (ports stay internal).
