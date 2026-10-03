# apps/web

## OVERVIEW
React 18 SPA (Vite 8, TanStack Router + Query, Tailwind v4 via `@tailwindcss/vite`); talks only to same-origin `/api`. Earned its file: 42 src files, ~10k LOC, own build config, central query layer.

## WHERE TO LOOK
| Task | Location | Notes |
|------|----------|-------|
| Add/rename a route | `src/router.tsx` | `createRootRoute`/`createRoute`; root component is `AppLayout` |
| Page bodies | `src/routes/*.tsx`, `src/pages/Admin.tsx` | flat, one file per route |
| Server data | `src/lib/query.ts` | `queryKeys`, `queryClient`, `useSession`/`useDashboard`/`useApprovals`/`useInstances`/`useLogout` |
| Fetch + errors | `src/lib/api.ts` | `api` (method object), `ApiError`, `isApiError`; `isNetworkError` lives in `lib/query.ts` |
| Admin API shapes | `src/lib/api-admin.ts` | normalizes response casing |
| Button/link styles | `src/components/primitives.tsx` | `BUTTON_PRIMARY`, `BUTTON_OUTLINE`, `BUTTON_DANGER`, `LINK_PRIMARY`, `ICON_BTN` class strings |
| Motion | `src/lib/motion.ts`, `src/lib/app-motion.ts` | reduced-motion aware helpers |
| Icons | `src/components/icons.tsx` | inline SVG components |
| Admin moderation UI | `src/components/admin/` | `UserTable`, `ModerationDialog`, `AuditTrail` |
| Signed-out landing | `src/components/landing/` | `landing.css` is the one non-Tailwind stylesheet |
| Mode switch (showcase vs live) | `session.mode` from `useSession` | `SignInGate` picks `PersonaPicker` vs OAuth buttons |

## HOTSPOTS
- `routes/desktop-login.tsx` (~1100 lines): desktop session flow, credential display.
- `components/RequestList.tsx` (~650), `components/SetupHelper.tsx` (~530).

## CONVENTIONS
- Server state goes through `lib/query.ts` hooks + `queryKeys`. Existing direct `fetch` calls (`ActivityFeed`, `RequestList` health check, `admin/AuditTrail`) are exceptions, not a pattern for new code.
- Persona switch / logout runs `clearTenantData`: cancels in-flight queries and removes tenant-scoped caches (dashboard, approvals, conversations) while keeping the session and public plans. One tenant's cached data must never leak to another; add new tenant query keys there.
- `api` throws `ApiError` with a `code` mirroring the server `code`, or `"network"` when the request never reached the API. Branch on `code`, not message text.
- Style tokens come from `primitives.tsx` string constants; reuse them rather than re-typing button class lists.
- Router uses `defaultViewTransition: true` (cross-fade between `.vt-page` columns) and `defaultPreload: "intent"`.
- Types come from `@homehost/shared` (`import type`); don't redeclare API shapes locally.
- Only package with `noUncheckedIndexedAccess` in its tsconfig.

## DEV SERVER
- `bun --bun vite` on `:5173`, `strictPort`. `/api` (incl. ws) proxies to `API_PROXY_TARGET` (default `http://127.0.0.1:3000`).
- `allowedHosts` is loopback + one LAN IP only; dev is never published on a public name.
- Containerized dev stack serves web on `:5174` (see `infra/dev`).

## ANTI-PATTERNS
- Gating showcase-only copy on anything other than `session.mode === "showcase"`.
- Adding a CSS file or CSS-in-JS for app UI (landing.css is the existing exception, not a precedent).
- Calling the API from an absolute origin; everything is same-origin `/api`.
- Introducing a second fetch wrapper or query client.
