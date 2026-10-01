import { useEffect, useState, type CSSProperties } from "react";
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
import { ActivityFeed } from "../components/ActivityFeed";
import { HowItWorks } from "../components/landing/HowItWorks";
import { LifecycleDiagram } from "../components/landing/LifecycleDiagram";
import { PlanCard, PlanCardSkeleton } from "../components/landing/PlanCard";
import { PrimaryCta } from "../components/landing/PrimaryCta";
import { usePauseOffscreen } from "../components/landing/usePauseOffscreen";
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
  "m-0 grid list-none grid-cols-1 gap-4 p-0 sm:grid-cols-2 lg:grid-cols-3";

const LABEL =
  "m-0 text-[12px] font-bold uppercase tracking-[0.07em] text-text-3";

const stagger = (i: number): CSSProperties => ({
  animationDelay: `${i * 70}ms`,
});

const delay = (ms: number): CSSProperties => ({ animationDelay: `${ms}ms` });

function PlansHeader() {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-x-8 gap-y-1.5">
      <h2
        id="catalog-heading"
        className="text-[22px] font-[700] tracking-[-0.015em]"
      >
        Plans
      </h2>
      <p className="m-0 max-w-[60ch] text-[13.5px] leading-[1.5] text-text-3">
        Live from the API. Quotas are per trust tier, so every plan shares the
        same tier ceilings.
      </p>
    </div>
  );
}

function PlanCatalog({ plans }: { plans: Plan[] }) {
  return (
    <section aria-labelledby="catalog-heading">
      <PlansHeader />
      <ul className={PLAN_GRID}>
        {plans.map((plan, i) => (
          <PlanCard key={plan.id} plan={plan} index={i} />
        ))}
      </ul>
    </section>
  );
}

function SignedOutHome() {
  const { data: session } = useSession();
  const plans = usePlans();
  const heroRef = usePauseOffscreen<HTMLElement>();
  const showcase = session?.mode === "showcase";
  const showPersonas = showcase && (session?.personas ?? []).length > 0;
  return (
    <div className="mx-auto flex w-full max-w-[1120px] flex-col gap-[clamp(56px,8vw,96px)]">
      <section
        ref={heroRef}
        className="lc relative isolate flex flex-col gap-10 pt-[clamp(8px,4vw,40px)] lg:grid lg:grid-cols-12 lg:items-center lg:gap-12"
      >
        <div className="lc-ambient" aria-hidden="true">
          <div className="lc-grid" />
          <div className="absolute bottom-0 right-1/2 size-[560px] translate-x-1/2 lg:bottom-auto lg:right-[-40px] lg:top-1/2 lg:translate-x-0 lg:-translate-y-1/2">
            <div className="lc-glow" />
          </div>
        </div>
        <div className="flex min-w-0 flex-col lg:col-span-7">
          <p className="m-0 inline-flex w-fit animate-fade-up items-center gap-2 rounded-full border border-line bg-ink-1/70 px-3 py-1 text-[12px] text-text-2">
            <span
              className={`lc-ring relative size-1.5 rounded-full ${showcase ? "bg-pending" : "bg-ok"}`}
              aria-hidden="true"
            />
            {showcase
              ? "Containers, VMs and desktops · showcase"
              : "Containers, VMs and desktops · live"}
          </p>
          <h1 className="mb-5 mt-5 text-[clamp(36px,5.4vw,62px)] font-[750] leading-[1.04] tracking-[-0.03em]">
            <span className="lc-line">
              <span className="lc-line-in">Request a server.</span>
            </span>{" "}
            <span className="lc-line">
              <span className="lc-line-in text-accent-strong" style={delay(90)}>
                SSH in and build.
              </span>
            </span>
          </h1>
          <p
            className="m-0 max-w-[54ch] animate-fade-up text-[16px] leading-[1.65] text-text-2"
            style={delay(220)}
          >
            {session?.mode === "live"
              ? "Homehost is a small cloud for friends. Pick a container, a virtual machine or a browser desktop and request it. Once an operator approves, you get a real server you can SSH into, start, stop or delete."
              : "Homehost is a small cloud for friends. Pick a container, a virtual machine or a browser desktop and request it, and an operator approves it. This copy is a showcase: requests only reserve capacity on paper, and no server is ever created."}
          </p>
          <div className="mt-8">
            {showPersonas ? (
              <div className="animate-fade-up" style={delay(320)}>
                <PrimaryCta href="#personas" landing>
                  Try a demo persona
                </PrimaryCta>
              </div>
            ) : (
              <OAuthButtons variant="landing" />
            )}
          </div>
        </div>
        <div
          className="flex animate-fade-up lg:col-span-5 lg:justify-end"
          style={delay(280)}
        >
          <LifecycleDiagram showcase={showcase} />
        </div>
      </section>
      <HowItWorks />
      {plans.isPending ? (
        <section aria-hidden="true">
          <PlansHeader />
          <ul className={PLAN_GRID}>
            {[0, 1, 2].map((i) => (
              <PlanCardSkeleton key={i} />
            ))}
          </ul>
        </section>
      ) : plans.isError ? (
        <ErrorState error={plans.error} onRetry={() => void plans.refetch()} />
      ) : (
        <PlanCatalog plans={plans.data} />
      )}
      {showPersonas ? (
        <section id="personas" aria-labelledby="personas-heading">
          <h2 id="personas-heading" className={LABEL}>
            Try a demo persona
          </h2>
          <PersonaPicker />
        </section>
      ) : null}
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
      <div className="flex animate-fade-up flex-wrap items-start justify-between gap-4">
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

      <div className="animate-fade-up" style={stagger(1)}>
        <QuotaCard quota={quota} usage={usage} tier={user.tier} />
      </div>

      <section
        className={`${CARD} animate-fade-up`}
        style={stagger(2)}
        aria-labelledby="requests-heading"
      >
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

      <section
        className={`${CARD} animate-fade-up`}
        style={stagger(3)}
        aria-labelledby="activity-heading"
      >
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
