import { useEffect, useState } from "react";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import type { PortalUser } from "@homehost/shared";
import { isApiError } from "../lib/api";
import {
  adminApi,
  type AccountStatus,
  type AdminUsersPage,
} from "../lib/api-admin";
import { queryKeys, useSession } from "../lib/query";
import { UserTable } from "../components/admin/UserTable";
import { AuditTrail } from "../components/admin/AuditTrail";
import { SignInGate } from "../components/SignInGate";
import { Spinner } from "../components/icons";
import {
  CARD,
  CARD_HEAD,
  CARD_SUB,
  CARD_TITLE,
  EmptyState,
  ErrorState,
  LiveRegion,
  PageLoading,
} from "../components/primitives";

type StatusFilter = AccountStatus | "all";

const STATUS_FILTERS: ReadonlyArray<{ value: StatusFilter; label: string }> = [
  { value: "pending", label: "Pending" },
  { value: "approved", label: "Approved" },
  { value: "rejected", label: "Rejected" },
  { value: "suspended", label: "Suspended" },
  { value: "all", label: "All" },
];

const TAB_BASE =
  "inline-flex min-h-11 cursor-pointer items-center justify-center rounded-full px-4 py-2 text-[14px] font-[650] no-underline transition-colors [-webkit-tap-highlight-color:transparent] disabled:cursor-not-allowed disabled:opacity-55";
const TAB_IDLE = `${TAB_BASE} border border-line-strong bg-ink-2 text-text-2 enabled:hover:border-accent-line enabled:hover:text-accent`;
const TAB_ACTIVE = `${TAB_BASE} border border-transparent bg-accent text-on-accent`;

function StatusFilterTabs({
  value,
  onChange,
}: {
  value: StatusFilter;
  onChange: (value: StatusFilter) => void;
}) {
  return (
    <div
      className="flex flex-wrap gap-2"
      role="group"
      aria-label="Filter users by account status"
    >
      {STATUS_FILTERS.map((filter) => (
        <button
          key={filter.value}
          type="button"
          className={filter.value === value ? TAB_ACTIVE : TAB_IDLE}
          aria-pressed={filter.value === value}
          onClick={() => onChange(filter.value)}
        >
          {filter.label}
        </button>
      ))}
    </div>
  );
}

function AdminPanel({ user }: { user: PortalUser }) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<StatusFilter>("pending");
  const [liveMessage, setLiveMessage] = useState<string | null>(null);
  const usersQuery = useInfiniteQuery({
    queryKey: ["admin", "users", user.id, status],
    queryFn: ({ pageParam }): Promise<AdminUsersPage> =>
      adminApi.listUsers({
        status: status === "all" ? undefined : status,
        limit: 50,
        cursor: pageParam ?? undefined,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });

  const seenIds = new Set<string>();
  const users = (usersQuery.data?.pages ?? []).flatMap((page) => page.users).filter((u) => {
    if (seenIds.has(u.id)) return false;
    seenIds.add(u.id);
    return true;
  });

  // A 401 means the server no longer honors the cookie — ask /api/session for
  // the truth so the whole shell (topbar included) flips to signed out.
  const sessionExpired =
    isApiError(usersQuery.error) && usersQuery.error.status === 401;
  useEffect(() => {
    if (sessionExpired) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.session });
    }
  }, [sessionExpired, queryClient]);

  // The operator role was revoked mid-session: the list endpoint answers 403.
  const roleRevoked =
    isApiError(usersQuery.error) && usersQuery.error.status === 403;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-[clamp(22px,3vw,28px)] font-bold tracking-[-0.01em]">
            Administration
          </h1>
          <p className="mt-1.5 max-w-[72ch] text-[14px] leading-[1.6] text-text-2">
            Review account requests, classify users as technical or
            non-technical, and audit every moderation action.
          </p>
        </div>
      </div>

      <StatusFilterTabs value={status} onChange={setStatus} />

      {usersQuery.isPending ? (
        <div className={CARD} aria-hidden="true">
          <div className="skeleton skeleton-line w-32" />
          <div className="skeleton skeleton-row" />
          <div className="skeleton skeleton-row" />
        </div>
      ) : usersQuery.isError ? (
        sessionExpired ? (
          <SignInGate title="Your session has ended">
            Pick a demo persona to sign back in.
          </SignInGate>
        ) : roleRevoked ? (
          <EmptyState
            title="Not authorized (403)"
            copy="This view returned 403: your session is no longer an operator session. If you were just demoted, your dashboard and requests are unaffected."
          />
        ) : (
          <ErrorState
            error={usersQuery.error}
            onRetry={() => void usersQuery.refetch()}
          />
        )
      ) : (
        <section className={CARD} aria-labelledby="users-heading">
          <div className={CARD_HEAD}>
            <div>
              <h2 id="users-heading" className={CARD_TITLE}>
                Users
              </h2>
              <p className={CARD_SUB}>
                Approve or reject pending accounts and set each user&apos;s
                technical level.
              </p>
            </div>
          </div>
          <UserTable
            users={users}
            onAnnounce={(message) => {
              // The table announces only after a moderation mutation, so the
              // list it just rendered is stale — refetch before announcing.
              setLiveMessage(message);
              void queryClient.invalidateQueries({
                queryKey: ["admin", "users", user.id],
              });
            }}
          />
          {usersQuery.isFetchNextPageError ? (
            <p role="alert" className="mt-2 text-[13px] text-bad">
              Could not load more users. Try again.
            </p>
          ) : null}
          {usersQuery.hasNextPage ? (
            <button
              type="button"
              onClick={() => void usersQuery.fetchNextPage()}
              disabled={usersQuery.isFetchingNextPage}
              aria-busy={usersQuery.isFetchingNextPage}
              className="mt-3 flex min-h-[44px] w-full items-center justify-center gap-2 rounded-control border border-line bg-ink-2 px-4 text-[14px] font-semibold disabled:cursor-wait disabled:opacity-60"
            >
              {usersQuery.isFetchingNextPage ? (
                <>
                  <Spinner className="size-4" /> Loading…
                </>
              ) : (
                "Show more"
              )}
            </button>
          ) : null}
        </section>
      )}

      <section className={CARD} aria-labelledby="audit-heading">
        <div className={CARD_HEAD}>
          <div>
            <h2 id="audit-heading" className={CARD_TITLE}>
              Moderation audit trail
            </h2>
            <p className={CARD_SUB}>
              Every approve, reject, and classification change, newest first.
            </p>
          </div>
        </div>
        <AuditTrail />
      </section>

      <LiveRegion message={liveMessage} />
    </div>
  );
}

export function AdminPage() {
  const { data: session, isPending } = useSession();
  if (isPending) return <PageLoading label="Loading your session…" />;
  if (!session?.user) {
    return (
      <SignInGate title="Operator sign-in required">
        Pick the operator demo persona to open the administration panel.
      </SignInGate>
    );
  }
  if (session.user.role !== "operator") {
    return (
      <EmptyState
        title="Not authorized (403)"
        copy="Account administration is only visible to the operator. Your dashboard and requests are unaffected."
      />
    );
  }
  // Keyed by user id: persona switches remount the page so filter state and
  // any in-flight moderation state can never cross tenants.
  return <AdminPanel key={session.user.id} user={session.user} />;
}
