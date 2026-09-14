import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import type { Plan, PortalUser } from "@homehost/shared";
import { isApiError } from "../lib/api";
import {
  isNetworkError,
  queryKeys,
  useDashboard,
  usePlans,
  useSession,
} from "../lib/query";
import { formatMemory } from "../lib/format";
import { ActivityFeed } from "../components/ActivityFeed";
import { LockIcon } from "../components/icons";
import { PersonaPicker } from "../components/PersonaPicker";
import { OAuthButtons, SignInGate } from "../components/SignInGate";
import { RequestList } from "../components/RequestList";
import {
  CARD,
  CARD_HEAD,
  CARD_SUB,
  CARD_TITLE,
  Chip,
  EmptyState,
  ErrorState,
  LINK_PRIMARY,
  LiveRegion,
  PageLoading,
  QuotaCard,
  QuotaCardSkeleton,
} from "../components/primitives";

const PLAN_GRID =
  "m-0 grid list-none grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-3";

function PlanCatalog({ plans }: { plans: Plan[] }) {
  return (
    <section className={CARD} aria-labelledby="catalog-heading">
      <div className={CARD_HEAD}>
        <div>
          <h2 id="catalog-heading" className={CARD_TITLE}>
            Plan catalog
          </h2>
          <p className={CARD_SUB}>
            Live from the API — the same catalog members request against.
          </p>
        </div>
      </div>
      <ul className={PLAN_GRID}>
        {plans.map((plan) => (
          <li
            key={plan.id}
            className={
              plan.technicalOnly
                ? "rounded-control border border-line bg-ink-2 p-3.5 opacity-[0.78]"
                : "rounded-control border border-line bg-ink-2 p-3.5"
            }
          >
            <div className="flex flex-wrap items-center justify-between gap-2 [&>*]:min-w-0">
              <h3 className="text-[14.5px] font-[650]">{plan.name}</h3>
              {plan.technicalOnly ? (
                <Chip>
                  <LockIcon className="size-3" /> technical only
                </Chip>
              ) : null}
            </div>
            <p className="mt-2 text-[13.5px] text-text-2">
              {plan.cpu} CPU · {formatMemory(plan.memoryMb)} RAM · {plan.diskGb}{" "}
              GB disk
            </p>
            <p className="mt-1.5 text-[12.5px] text-text-3">
              Quotas are per trust tier — plans share the same tier-wide
              ceilings.
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}

function SignedOutHome() {
  const { data: session } = useSession();
  const plans = usePlans();
  return (
    <div className="flex flex-col gap-5">
      <section className="max-w-[780px] px-0 pb-1.5 pt-[clamp(8px,3vw,28px)]">
        <h1 className="mb-3 text-[clamp(26px,4vw,36px)] font-[750] tracking-[-0.015em]">
          Request a server from the homelab.
        </h1>
        <p className="m-0 max-w-[66ch] text-[15.5px] leading-[1.65] text-text-2">
          {session?.mode === "live"
            ? "Homehost is a small control plane for friends: pick a plan, request it, and a lab operator approves or rejects. Approved servers are provisioned as real machines on the homelab."
            : "Homehost is a small control plane for friends: pick a plan, request it, and a lab operator approves or rejects. This running copy is an honest showcase — requests only reserve capacity on paper, and no server is ever created."}
        </p>
        <h2 className="mb-0 mt-[30px] text-[12px] font-bold uppercase tracking-[0.07em] text-text-3">
          Sign in
        </h2>
        <OAuthButtons />
        {(session?.personas ?? []).length > 0 ? (
          <>
            <h2 className="mb-0 mt-[30px] text-[12px] font-bold uppercase tracking-[0.07em] text-text-3">
              Try a demo persona
            </h2>
            <PersonaPicker />
          </>
        ) : null}
      </section>
      {plans.isPending ? (
        <div className={CARD} aria-hidden="true">
          <div className="skeleton skeleton-line w-40" />
          <div className={PLAN_GRID}>
            {[0, 1, 2].map((i) => (
              <div key={i} className="rounded-control border border-line p-3.5">
                <div className="skeleton skeleton-line w-28" />
                <div className="skeleton skeleton-line w-full" />
                <div className="skeleton skeleton-line w-20" />
              </div>
            ))}
          </div>
        </div>
      ) : plans.isError ? (
        <ErrorState error={plans.error} onRetry={() => void plans.refetch()} />
      ) : (
        <PlanCatalog plans={plans.data} />
      )}
    </div>
  );
}

function SignedInDashboard({ user }: { user: PortalUser }) {
  const dashboard = useDashboard(user.id);
  const queryClient = useQueryClient();
  const [liveMessage, setLiveMessage] = useState<string | null>(null);

  // A 401 means the server no longer honors the cookie — ask /api/session for
  // the truth so the whole shell (topbar included) flips to signed out.
  const sessionExpired =
    isApiError(dashboard.error) && dashboard.error.status === 401;
  useEffect(() => {
    if (sessionExpired) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.session });
    }
  }, [sessionExpired, queryClient]);

  if (dashboard.isPending) {
    return (
      <div className="flex flex-col gap-5">
        <div
          className="flex items-center justify-between gap-4"
          aria-hidden="true"
        >
          <div className="skeleton skeleton-line w-48" />
          <div className="skeleton skeleton-button" />
        </div>
        <QuotaCardSkeleton />
        <div className={CARD} aria-hidden="true">
          <div className="skeleton skeleton-line w-32" />
          <div className="skeleton skeleton-row" />
          <div className="skeleton skeleton-row" />
        </div>
      </div>
    );
  }

  if (dashboard.isError) {
    const error = dashboard.error;
    if (isApiError(error) && error.status === 401) {
      return (
        <SignInGate title="Your session has ended">
          Pick a demo persona to sign back in.
        </SignInGate>
      );
    }
    if (isNetworkError(error)) {
      return (
        <ErrorState
          error={error}
          title="The API is unreachable"
          onRetry={() => void dashboard.refetch()}
        />
      );
    }
    return (
      <ErrorState error={error} onRetry={() => void dashboard.refetch()} />
    );
  }

  const { quota, usage, requests, activity } = dashboard.data;
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-[clamp(22px,3vw,28px)] font-bold tracking-[-0.01em]">
            Dashboard
          </h1>
          <p className="mt-1.5 flex flex-wrap items-center gap-2 text-[14px] text-text-2">
            Signed in as {user.name} <Chip>{user.tier} tier</Chip>
            {user.role === "operator" ? (
              <Chip tone="accent">operator</Chip>
            ) : null}
          </p>
        </div>
        <Link to="/new" className={`${LINK_PRIMARY} w-full sm:w-auto`}>
          New request
        </Link>
      </div>

      <QuotaCard quota={quota} usage={usage} tier={user.tier} />

      <section className={CARD} aria-labelledby="requests-heading">
        <div className={CARD_HEAD}>
          <div>
            <h2 id="requests-heading" className={CARD_TITLE} tabIndex={-1}>
              Your requests
            </h2>
            <p className={CARD_SUB}>
              Pending, approved, provisioning, running and stopped rows hold
              reserved quota. Rejected rows stay visible but hold nothing.
            </p>
          </div>
        </div>
        {requests.length === 0 ? (
          <EmptyState
            title="No requests yet"
            copy="Request your first server and it will show up here, pending operator approval."
            action={
              <Link to="/new" className={LINK_PRIMARY}>
                New request
              </Link>
            }
          />
        ) : (
          <RequestList requests={requests} onAnnounce={setLiveMessage} />
        )}
      </section>

      <section className={CARD} aria-labelledby="activity-heading">
        <div className={CARD_HEAD}>
          <div>
            <h2 id="activity-heading" className={CARD_TITLE}>
              Activity
            </h2>
            <p className={CARD_SUB}>
              Audit events for your requests, newest first.
            </p>
          </div>
        </div>
        {activity.length === 0 ? (
          <EmptyState
            title="No activity yet"
            copy="Events appear here when a request is created, decided, or cancelled."
          />
        ) : (
          <ActivityFeed events={activity} />
        )}
      </section>

      <LiveRegion message={liveMessage} />
    </div>
  );
}

export function DashboardPage() {
  const { data: session, isPending } = useSession();
  if (isPending) return <PageLoading label="Loading your session…" />;
  if (!session?.user) return <SignedOutHome />;
  // Keyed by user id: persona switches remount the page so live messages and
  // any in-flight dialog state can never cross tenants.
  return <SignedInDashboard key={session.user.id} user={session.user} />;
}
