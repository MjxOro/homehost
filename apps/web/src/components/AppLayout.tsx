import { useEffect, useRef, useState } from "react";
import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import type { PortalUser } from "@homehost/shared";
import { useApprovals, useSession } from "../lib/query";
import {
  DashboardIcon,
  InboxIcon,
  InfoIcon,
  PlusIcon,
  ServerIcon,
  SidebarIcon,
  Spinner,
  XIcon,
} from "./icons";
import { PersonaMenu } from "./PersonaMenu";
import { ErrorState, PageLoading } from "./primitives";

const NAV_ITEM_BASE =
  "flex min-h-11 items-center gap-3 rounded-control px-3 py-2.5 text-[14.5px] font-medium no-underline transition-colors hover:bg-ink-2";
const NAV_ITEM_IDLE = `${NAV_ITEM_BASE} text-text-2 hover:text-text-1`;
const NAV_ITEM_ACTIVE = `${NAV_ITEM_BASE} bg-accent-dim text-accent`;

function ShowcaseBadge() {
  return (
    <span className="inline-flex items-center gap-[7px] whitespace-nowrap rounded-full border border-accent-line bg-accent-dim px-2.5 py-[5px] font-mono text-[11px] uppercase tracking-[0.08em] text-accent">
      <span className="size-[7px] rounded-full bg-accent" aria-hidden="true" />
      Showcase
    </span>
  );
}

function NavApprovalsItem({
  user,
  active,
  onNavigate,
}: {
  user: PortalUser;
  active: boolean;
  onNavigate: () => void;
}) {
  const approvals = useApprovals(user);
  const count = approvals.data?.requests.length ?? 0;
  return (
    <Link
      to="/approvals"
      className={active ? NAV_ITEM_ACTIVE : NAV_ITEM_IDLE}
      onClick={onNavigate}
    >
      <InboxIcon className="size-[18px] shrink-0" />
      <span>Approvals</span>
      {count > 0 ? (
        <span
          className="ml-auto inline-flex h-[22px] min-w-[22px] items-center justify-center rounded-full bg-accent px-1.5 font-mono text-[12px] font-bold text-on-accent"
          aria-label={`${count} pending`}
        >
          {count}
        </span>
      ) : null}
    </Link>
  );
}

function SidebarNav({
  user,
  pathname,
  onNavigate,
}: {
  user: PortalUser | null;
  pathname: string;
  onNavigate: () => void;
}) {
  const isOperator = user?.role === "operator";
  return (
    <nav className="flex flex-col gap-1 pt-2.5" aria-label="Primary">
      <Link
        to="/"
        className={pathname === "/" ? NAV_ITEM_ACTIVE : NAV_ITEM_IDLE}
        onClick={onNavigate}
      >
        <DashboardIcon className="size-[18px] shrink-0" />
        <span>Dashboard</span>
      </Link>
      <Link
        to="/new"
        className={
          pathname.startsWith("/new") ? NAV_ITEM_ACTIVE : NAV_ITEM_IDLE
        }
        onClick={onNavigate}
      >
        <PlusIcon className="size-[18px] shrink-0" />
        <span>New request</span>
      </Link>
      {isOperator && user ? (
        <NavApprovalsItem
          user={user}
          active={pathname.startsWith("/approvals")}
          onNavigate={onNavigate}
        />
      ) : null}
    </nav>
  );
}

/**
 * App shell: fixed left navigation, compact topbar with the showcase badge and
 * persona switcher, plus a persistent honesty banner. The sidebar collapses to
 * an off-canvas drawer below lg (hamburger-only, never persistent); at lg it
 * is a sticky sidebar. Signed-out visitors get a chromeless shell — just the
 * banner and the routed landing — with zero nav chrome.
 */
export function AppLayout() {
  const [navOpen, setNavOpen] = useState(false);
  const sidebarRef = useRef<HTMLElement>(null);
  const navToggleRef = useRef<HTMLButtonElement>(null);
  const { data: session, isPending, isError, error, refetch } = useSession();
  const live = session?.mode !== "showcase";
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });

  useEffect(() => {
    if (!navOpen) return;
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setNavOpen(false);
        navToggleRef.current?.focus();
        return;
      }
      if (event.key !== "Tab") return;
      const sidebar = sidebarRef.current;
      if (!sidebar) return;
      const focusable = Array.from(
        sidebar.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter(
        (element) =>
          !element.hasAttribute("disabled") && element.offsetParent !== null,
      );
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (event.shiftKey && (active === first || !sidebar.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        (active === last || !sidebar.contains(active))
      ) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = originalOverflow;
    };
  }, [navOpen]);
  useEffect(() => {
    const query = window.matchMedia("(min-width: 1024px)");
    const onChange = (event: MediaQueryListEvent) => {
      if (event.matches) setNavOpen(false);
    };
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  // Public surface: signed-out landing / sign-in renders zero nav chrome —
  // no sidebar, no topbar, no drawer toggle. Authenticated layout below is
  // untouched: drawer-only below lg, persistent sidebar at lg.
  const signedOut = !isPending && !isError && !session?.user;
  if (signedOut) {
    return (
      <div className="flex min-h-dvh flex-col">
        <a
          className="absolute left-3 top-[-56px] z-[100] rounded-control bg-accent px-4 py-2.5 font-[650] text-on-accent no-underline transition-[top] duration-[0.15s] ease-[ease] focus:top-3"
          href="#main"
        >
          Skip to content
        </a>
        {live ? null : (
          <div className="flex items-start gap-2.5 border-b border-accent-line bg-accent-dim px-[clamp(16px,4vw,44px)] py-2.5 text-[13.5px] text-text-2">
            <InfoIcon className="mt-px size-[18px] shrink-0 text-accent" />
            <p className="m-0 max-w-[110ch] leading-[1.5]">
              Showcase mode — no real infrastructure is created and no payments
              are involved. Approving a request only reserves capacity; nothing
              is ever provisioned.
            </p>
          </div>
        )}
        <main
          id="main"
          className="mx-auto w-full max-w-[1120px] px-[clamp(16px,4vw,44px)] pb-[88px] pt-7 focus:outline-none"
          tabIndex={-1}
        >
          <Outlet />
        </main>
      </div>
    );
  }

  const asideClass = navOpen
    ? "visible fixed inset-y-0 left-0 z-50 flex w-[280px] translate-x-0 flex-col gap-2 border-r border-line bg-ink-1 px-3.5 pb-4 pt-5 shadow-pop transition-[translate,visibility] duration-[0.22s] ease-[ease] motion-reduce:transition-none lg:sticky lg:top-0 lg:z-auto lg:h-dvh lg:w-[264px] lg:shrink-0 lg:translate-x-0 lg:shadow-none"
    : "invisible fixed inset-y-0 left-0 z-50 flex w-[280px] -translate-x-[108%] flex-col gap-2 border-r border-line bg-ink-1 px-3.5 pb-4 pt-5 shadow-pop transition-[translate,visibility] duration-[0.22s] ease-[ease] [transition-delay:0s,0.22s] motion-reduce:transition-none lg:visible lg:sticky lg:top-0 lg:z-auto lg:h-dvh lg:w-[264px] lg:shrink-0 lg:translate-x-0 lg:shadow-none";

  const scrimClass = navOpen
    ? "visible fixed inset-0 z-[45] cursor-pointer bg-[rgba(4,8,10,0.6)] opacity-100 transition-[opacity,visibility] duration-200 ease-[ease] motion-reduce:transition-none lg:hidden"
    : "invisible pointer-events-none fixed inset-0 z-[45] cursor-pointer bg-[rgba(4,8,10,0.6)] opacity-0 transition-[opacity,visibility] duration-200 ease-[ease] [transition-delay:0s,0.2s] motion-reduce:transition-none lg:hidden";

  return (
    <div className="flex min-h-dvh">
      <a
        className="absolute left-3 top-[-56px] z-[100] rounded-control bg-accent px-4 py-2.5 font-[650] text-on-accent no-underline transition-[top] duration-[0.15s] ease-[ease] focus:top-3"
        href="#main"
      >
        Skip to content
      </a>
      <button
        type="button"
        aria-label="Close navigation"
        className={scrimClass}
        onClick={() => setNavOpen(false)}
      />
      <aside ref={sidebarRef} id="primary-navigation" className={asideClass}>
        <div className="flex items-center gap-2.5 border-b border-line px-1.5 pb-3.5 pt-0.5">
          <ServerIcon className="size-[26px] shrink-0 text-accent" />
          <div className="flex min-w-0 flex-1 flex-col leading-[1.2]">
            <span className="text-[16px] font-[750] tracking-[-0.01em]">
              Homehost
            </span>
            <span className="font-mono text-[11.5px] text-text-3">
              homelab control
            </span>
          </div>
          <button
            type="button"
            aria-label="Close navigation"
            onClick={(event) => {
              setNavOpen(false);
              if (event.detail !== 0) event.currentTarget.blur();
              else navToggleRef.current?.focus();
            }}
            className="inline-flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-control border-0 bg-transparent text-text-1 transition-colors [-webkit-tap-highlight-color:transparent] hover:bg-ink-2 lg:hidden"
          >
            <XIcon width={20} height={20} className="h-5 w-5" />
          </button>
        </div>
        {isPending ? (
          <div className="px-3 py-3.5" aria-hidden="true">
            <Spinner className="spinner-sm" />
          </div>
        ) : (
          <SidebarNav
            user={session?.user ?? null}
            pathname={pathname}
            // Deliberately no focus move here: keyboard focus rests on the
            // hidden link after navigation; Escape is the keyboard close path.
            onNavigate={() => setNavOpen(false)}
          />
        )}
        <div className="mt-auto flex flex-col items-start gap-2 border-t border-line pt-4">
          {live ? null : (
            <>
              <ShowcaseBadge />
              <p className="m-0 text-[12px] leading-[1.5] text-text-3">
                Requests reserve capacity on paper only.
              </p>
            </>
          )}
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex items-center justify-between gap-3 border-b border-line bg-ink-0/[0.88] px-[clamp(16px,4vw,44px)] py-2 backdrop-blur">
          <button
            ref={navToggleRef}
            aria-controls="primary-navigation"
            type="button"
            className="inline-flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-control border-0 bg-transparent text-text-1 transition-colors [-webkit-tap-highlight-color:transparent] hover:bg-ink-2 lg:hidden"
            aria-label={navOpen ? "Close navigation" : "Open navigation"}
            aria-expanded={navOpen}
            onClick={(event) => {
              setNavOpen((value) => !value);
              if (event.detail !== 0) event.currentTarget.blur();
            }}
          >
            <SidebarIcon width={24} height={24} className="h-6 w-6" />
          </button>
          <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-3 [&>*]:min-w-0">
            {live ? null : <ShowcaseBadge />}
            <PersonaMenu />
          </div>
        </header>
        {live ? null : (
          <div className="flex items-start gap-2.5 border-b border-accent-line bg-accent-dim px-[clamp(16px,4vw,44px)] py-2.5 text-[13.5px] text-text-2">
            <InfoIcon className="mt-px size-[18px] shrink-0 text-accent" />
            <p className="m-0 max-w-[110ch] leading-[1.5]">
              Showcase mode — no real infrastructure is created and no payments
              are involved. Approving a request only reserves capacity; nothing
              is ever provisioned.
            </p>
          </div>
        )}
        <main
          id="main"
          className="mx-auto w-full max-w-[1120px] px-[clamp(16px,4vw,44px)] pb-[88px] pt-7 focus:outline-none"
          tabIndex={-1}
        >
          {isPending ? (
            <PageLoading label="Loading your session…" />
          ) : isError ? (
            <ErrorState
              error={error}
              title="Cannot load your session"
              onRetry={() => void refetch()}
            />
          ) : (
            <Outlet />
          )}
        </main>
      </div>
    </div>
  );
}
