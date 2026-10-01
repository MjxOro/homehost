import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import {
  SETUP_STEPS,
  type ActivityEvent,
  type ServerRequest,
} from "@homehost/shared";
import { isApiError } from "../lib/api";
import { recipeLabel, setupErrorCopy } from "../lib/concierge";
import { formatPlanSpecs } from "../lib/format";
import {
  isNetworkError,
  queryKeys,
  useDashboard,
  usePlans,
  useSession,
} from "../lib/query";
import { SignInGate } from "../components/SignInGate";
import {
  isReady,
  pollFor,
  provisionFailure,
  ReadyCard,
  ServerTimeline,
} from "../components/ServerProgress";
import {
  EmptyState,
  ErrorState,
  LINK_GHOST,
  LINK_PRIMARY,
  LiveRegion,
  PageLoading,
  StatusPill,
} from "../components/primitives";
const REDIRECT_SECONDS = 10;
function ProgressView({
  request,
  activity,
}: {
  request: ServerRequest;
  activity: readonly ActivityEvent[];
}) {
  const navigate = useNavigate();
  const plan = usePlans().data?.find((p) => p.id === request.planId);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const ready = isReady(request);
  // Only a box that becomes ready while this page watches sends you on;
  // opening the page for an already-ready box just shows its details.
  const [watchedReady] = useState(!ready);
  const [redirectIn, setRedirectIn] = useState<number | null>(null);
  const [stayed, setStayed] = useState(false);

  // Arriving from a long form leaves the window scrolled; start at the top.
  useEffect(() => {
    window.scrollTo({ top: 0 });
    headingRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    if (ready && watchedReady && !stayed && redirectIn === null)
      setRedirectIn(REDIRECT_SECONDS);
  }, [ready, watchedReady, stayed, redirectIn]);

  useEffect(() => {
    if (redirectIn === null) return;
    if (redirectIn <= 0) {
      void navigate({ to: "/" });
      return;
    }
    const timer = window.setTimeout(
      () => setRedirectIn((n) => (n === null ? null : n - 1)),
      1_000,
    );
    return () => window.clearTimeout(timer);
  }, [redirectIn, navigate]);

  const { status } = request;
  const rejected = status === "rejected";
  const serverUp = status === "running" || status === "stopped";
  const stuck = provisionFailure(request, activity);
  const hasSetup = request.recipeId !== null && request.recipeId !== "none";
  let announcement: string;
  if (rejected) announcement = "The request was declined.";
  else if (status === "pending_approval")
    announcement = "Waiting for an operator to approve it.";
  else if (stuck) announcement = "Starting the server hit a problem.";
  else if (!serverUp) announcement = "Starting your server.";
  else if (request.setupStatus === "failed")
    announcement = `Setup failed. ${setupErrorCopy(request.setupError)}`;
  else if (request.setupStatus === "running" && request.setupStep)
    announcement = `${SETUP_STEPS[request.setupStep]?.label ?? "Installing"}.`;
  else if (request.setupStatus === "pending")
    announcement = "Getting ready to install.";
  else if (ready)
    // Ticking seconds are not news: the redirect is announced once.
    announcement =
      redirectIn !== null
        ? `${request.name} is ready. Going to your servers in ${REDIRECT_SECONDS} seconds unless you choose Stay here.`
        : `${request.name} is ready.`;
  else announcement = "The server is stopped.";

  return (
    <div className="mx-auto flex w-full max-w-[760px] flex-col gap-5">
      <LiveRegion message={announcement} />
      <div className="flex animate-fade-up flex-col gap-2">
        <Link to="/" className={`${LINK_GHOST} -ml-3 w-fit px-3 text-[13.5px]`}>
          ← My servers
        </Link>
        <h1
          ref={headingRef}
          tabIndex={-1}
          className="text-[clamp(22px,3vw,28px)] font-bold tracking-[-0.01em] [overflow-wrap:anywhere]"
        >
          {request.name}
        </h1>
        <p className="m-0 flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[14px] text-text-2">
          <StatusPill status={status} />
          <span>
            {plan ? `${plan.name} · ${formatPlanSpecs(plan)}` : request.planId}
          </span>
          <span aria-hidden="true">·</span>
          <span>
            {hasSetup
              ? recipeLabel(request.recipeId ?? "none")
              : "Plain Ubuntu"}
          </span>
        </p>
      </div>

      {ready ? (
        <ReadyCard
          request={request}
          redirectIn={redirectIn}
          onStay={() => {
            setStayed(true);
            setRedirectIn(null);
          }}
        />
      ) : null}

      <ServerTimeline request={request} activity={activity} />
    </div>
  );
}

export function ServerProgressPage() {
  const { data: session, isPending: sessionPending } = useSession();
  const params = useParams({ strict: false }) as { id?: string };
  const id = params.id ?? "";
  const dashboard = useDashboard(session?.user?.id, pollFor(id));
  const queryClient = useQueryClient();

  // A 401 means the cookie is no longer honored: let /api/session flip the
  // whole shell to signed out, like the dashboard does.
  const sessionExpired =
    isApiError(dashboard.error) && dashboard.error.status === 401;
  useEffect(() => {
    if (sessionExpired) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.session });
    }
  }, [sessionExpired, queryClient]);

  if (sessionPending) return <PageLoading label="Loading your session…" />;
  if (!session?.user) {
    return (
      <SignInGate title="Sign in to follow your server">
        Sign in to see how your server is coming along.
      </SignInGate>
    );
  }
  if (dashboard.isPending) return <PageLoading label="Loading your server…" />;
  if (dashboard.isError) {
    const error = dashboard.error;
    if (sessionExpired) {
      return (
        <SignInGate title="Your session has ended">
          Pick a demo persona to sign back in.
        </SignInGate>
      );
    }
    return (
      <ErrorState
        error={error}
        title={isNetworkError(error) ? "The API is unreachable" : undefined}
        onRetry={() => void dashboard.refetch()}
      />
    );
  }

  const request = dashboard.data.requests.find((row) => row.id === id);
  if (!request) {
    // A just-created request can miss the cached list until the refetch lands.
    if (dashboard.isFetching)
      return <PageLoading label="Loading your server…" />;
    return (
      <EmptyState
        title="We can't find that server"
        copy="It may have been deleted, or it belongs to a different account."
        action={
          <Link to="/" className={LINK_PRIMARY}>
            Go to my servers
          </Link>
        }
      />
    );
  }

  return (
    <ProgressView
      key={request.id}
      request={request}
      activity={dashboard.data.activity}
    />
  );
}
