import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import {
  RECIPES,
  SETUP_STEPS,
  type ActivityEvent,
  type DashboardResponse,
  type RecipeId,
  type ServerRequest,
} from "@homehost/shared";
import { isApiError } from "../lib/api";
import { recipeLabel, setupErrorCopy, warningCopy } from "../lib/concierge";
import { formatDateTime, formatPlanSpecs, formatRelative } from "../lib/format";
import {
  isNetworkError,
  queryKeys,
  useDashboard,
  usePlans,
  useRetrySetup,
  useSession,
} from "../lib/query";
import { SignInGate } from "../components/SignInGate";
import { CopyCode } from "../components/RequestList";
import { Notes } from "../components/SetupHelper";
import {
  CheckCircleIcon,
  CheckIcon,
  Spinner,
  XIcon,
} from "../components/icons";
import {
  BUTTON_GHOST_SM,
  BUTTON_OUTLINE_SM,
  CARD,
  EmptyState,
  ErrorState,
  FORM_ERROR,
  LINK_GHOST,
  LINK_PRIMARY,
  LiveRegion,
  PageLoading,
  StatusPill,
} from "../components/primitives";

const FAST_POLL_MS = 2_500;
const SLOW_POLL_MS = 10_000;
const REDIRECT_SECONDS = 10;

const COPY = "m-0 max-w-[62ch] text-[13.5px] leading-[1.6] text-text-2";
const CODE =
  "rounded-md border border-line bg-ink-2 px-1.5 py-0.5 font-mono text-[12.5px] text-accent [overflow-wrap:anywhere]";

type StepState = "done" | "active" | "failed" | "waiting";

const STATE_TEXT: Record<StepState, string> = {
  done: "Done",
  active: "In progress",
  failed: "Failed",
  waiting: "Not started yet",
};

function recipeSteps(recipeId: string) {
  return Object.hasOwn(RECIPES, recipeId)
    ? RECIPES[recipeId as RecipeId].steps
    : [];
}

/** Ready to use: up, and its software (if any) installed. */
function isReady(request: ServerRequest): boolean {
  return (
    request.status === "running" &&
    (request.setupStatus === "none" || request.setupStatus === "done")
  );
}

/**
 * Provisioning that gave up parks the request at `approved` with a
 * provision_failed event; it stays there until the operator retries.
 */
function provisionFailure(
  request: ServerRequest,
  activity: readonly ActivityEvent[],
): boolean {
  if (request.status !== "approved") return false;
  const latest = activity.find(
    (event) =>
      event.requestId === request.id &&
      (event.action === "approved" ||
        event.action === "provisioning" ||
        event.action === "provision_failed"),
  );
  return latest?.action === "provision_failed";
}

/** Something on the server side is still moving for this request. */
function isSettling(
  request: ServerRequest,
  activity: readonly ActivityEvent[],
) {
  if (request.status === "rejected" || request.status === "deleted")
    return false;
  if (request.status === "running" || request.status === "stopped")
    return (
      request.setupStatus === "pending" || request.setupStatus === "running"
    );
  return !provisionFailure(request, activity);
}

function pollFor(id: string) {
  return (data: DashboardResponse | undefined) => {
    const request = data?.requests.find((row) => row.id === id);
    return data && request && isSettling(request, data.activity)
      ? FAST_POLL_MS
      : SLOW_POLL_MS;
  };
}

function StateIcon({ state, small }: { state: StepState; small?: boolean }) {
  const size = small ? "size-5 [&_svg]:size-3" : "size-7 [&_svg]:size-4";
  const tone = {
    done: "border-[rgba(94,201,143,0.45)] bg-ok-dim text-ok",
    active: "border-accent-line bg-accent-dim text-accent",
    failed: "border-[rgba(224,108,108,0.5)] bg-bad-dim text-bad",
    waiting: "border-line-strong bg-ink-1 text-text-3",
  }[state];
  return (
    <span
      className={`relative z-[1] inline-flex shrink-0 items-center justify-center rounded-full border ${size} ${tone}`}
    >
      {state === "done" ? <CheckIcon /> : null}
      {state === "active" ? <Spinner className="spinner-sm" /> : null}
      {state === "failed" ? <XIcon /> : null}
      {state === "waiting" ? (
        <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />
      ) : null}
      <span className="sr-only">{STATE_TEXT[state]}: </span>
    </span>
  );
}

function Stage({
  state,
  title,
  children,
}: {
  state: StepState;
  title: string;
  children?: ReactNode;
}) {
  return (
    <li
      className="relative flex gap-3.5 pb-6 last:pb-0 [&:last-child>.rail]:hidden"
      aria-current={state === "active" ? "step" : undefined}
    >
      <span
        className="rail absolute bottom-0 left-[13.5px] top-7 w-px bg-line"
        aria-hidden="true"
      />
      <StateIcon state={state} />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5 pt-[3px]">
        <h2
          className={`text-[15px] font-[650] ${state === "waiting" ? "text-text-3" : state === "failed" ? "text-bad" : "text-text-1"}`}
        >
          {title}
        </h2>
        {children}
      </div>
    </li>
  );
}

function SetupStage({
  request,
  serverUp,
}: {
  request: ServerRequest;
  serverUp: boolean;
}) {
  const retry = useRetrySetup();
  const recipeId = request.recipeId ?? "none";
  const steps = recipeSteps(recipeId);
  const label = recipeLabel(recipeId);
  const { setupStatus } = request;
  const at = request.setupStep ? steps.indexOf(request.setupStep) : -1;

  const stage: StepState =
    setupStatus === "done"
      ? "done"
      : setupStatus === "failed"
        ? "failed"
        : serverUp
          ? "active"
          : "waiting";

  const stepState = (index: number): StepState => {
    if (setupStatus === "done") return "done";
    if (setupStatus === "failed")
      return index < at ? "done" : index === at ? "failed" : "waiting";
    if (setupStatus === "running") {
      const current = Math.max(at, 0);
      return index < current
        ? "done"
        : index === current
          ? "active"
          : "waiting";
    }
    return "waiting";
  };

  let summary: string;
  if (setupStatus === "done") summary = `${label} is installed and running.`;
  else if (setupStatus === "failed")
    summary = `${setupErrorCopy(request.setupError)} Your server itself is fine, and you can still log in over SSH.`;
  else if (setupStatus === "running")
    summary =
      "Installing now. Each step is checked before the next one starts.";
  else if (serverUp) summary = "Getting ready to install…";
  else summary = "Starts by itself as soon as the server answers.";

  return (
    <Stage state={stage} title={`Installing ${label}`}>
      <p className={COPY}>{summary}</p>
      {steps.length > 0 ? (
        <ol className="m-0 mt-1 flex list-none flex-col gap-2 p-0">
          {steps.map((step, index) => {
            const state = stepState(index);
            return (
              <li
                key={step}
                className="flex items-center gap-2.5 text-[13.5px] leading-[1.45]"
                aria-current={state === "active" ? "step" : undefined}
              >
                <StateIcon state={state} small />
                <span
                  className={
                    state === "waiting"
                      ? "text-text-3"
                      : state === "failed"
                        ? "font-semibold text-bad"
                        : "text-text-1"
                  }
                >
                  {SETUP_STEPS[step].label}
                </span>
              </li>
            );
          })}
        </ol>
      ) : null}
      {setupStatus === "failed" ? (
        <div className="mt-1 flex flex-col items-start gap-2">
          {request.status === "running" ? (
            <button
              type="button"
              className={BUTTON_OUTLINE_SM}
              disabled={retry.isPending}
              onClick={() => retry.mutate(request.id)}
            >
              {retry.isPending ? <Spinner className="spinner-sm" /> : null}
              Try setup again
            </button>
          ) : (
            <p className={COPY}>
              Start the server from your servers list to try setup again.
            </p>
          )}
          {retry.isError ? (
            <p className={FORM_ERROR} role="alert">
              {isApiError(retry.error) && retry.error.status === 409
                ? "Setup can't restart right now. Make sure the server is running, then try again."
                : "We couldn't restart setup. Try again in a moment."}
            </p>
          ) : null}
        </div>
      ) : null}
    </Stage>
  );
}

/** Where to go from here once the box is ready: address, login, console. */
function ReadyCard({
  request,
  redirectIn,
  onStay,
}: {
  request: ServerRequest;
  redirectIn: number | null;
  onStay: () => void;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    // Take focus only from nowhere in particular, never from a control.
    const active = document.activeElement;
    if (active === document.body || active?.tagName === "H1")
      headingRef.current?.focus();
  }, []);
  const minecraft = request.recipeId === "minecraft_java";
  const ssh = `ssh root@${request.subdomain}`;

  return (
    <section
      aria-labelledby="ready-heading"
      className={`${CARD} animate-scale-in flex flex-col gap-4 border-[rgba(94,201,143,0.4)]`}
    >
      <div className="flex items-center gap-3">
        <CheckCircleIcon className="size-8 shrink-0 text-ok" />
        <h2
          id="ready-heading"
          ref={headingRef}
          tabIndex={-1}
          className="text-[19px] font-[700] tracking-[-0.01em]"
        >
          {request.name} is ready
        </h2>
      </div>

      {request.gameAddress ? (
        <div className="flex flex-col gap-1.5">
          <p className={COPY}>
            {minecraft
              ? "Open Minecraft → Multiplayer → Add Server, and put this in Server Address:"
              : "Players connect to this address:"}
          </p>
          <CopyCode
            value={request.gameAddress}
            name="server address"
            className=""
          />
        </div>
      ) : null}

      <div className="flex flex-col gap-1.5">
        <p className={COPY}>
          {request.gameAddress
            ? "To manage it, log in from a terminal:"
            : "Log in from a terminal:"}
        </p>
        <CopyCode value={ssh} name="SSH command" className="" />
        <p className={COPY}>
          {request.hasSshKey
            ? "It lets you in with the SSH key you added."
            : "Your one-time root password is on your servers list, under “Show one-time password”."}
        </p>
        {minecraft ? (
          <p className={COPY}>
            Server console: once logged in, run{" "}
            <code className={CODE}>minecraft-console</code>. To leave it
            running, press Ctrl+A, then D.
          </p>
        ) : null}
      </div>

      <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center">
        <Link to="/" className={`${LINK_PRIMARY} w-full sm:w-auto`}>
          Go to my servers
        </Link>
        {redirectIn !== null ? (
          <>
            <p className="m-0 text-[13px] text-text-3">
              Taking you there in {redirectIn} s
            </p>
            <button type="button" className={BUTTON_GHOST_SM} onClick={onStay}>
              Stay here
            </button>
          </>
        ) : null}
      </div>
    </section>
  );
}

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
  const approved = status !== "pending_approval" && !rejected;
  const serverUp = status === "running" || status === "stopped";
  const stuck = provisionFailure(request, activity);
  const hasSetup = request.recipeId !== null && request.recipeId !== "none";
  const approvedAt = activity.find(
    (event) => event.requestId === request.id && event.action === "approved",
  )?.createdAt;

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

      <section
        aria-label="Progress"
        className={`${CARD} animate-fade-up`}
        style={{ animationDelay: "70ms" }}
      >
        <ol className="m-0 list-none p-0">
          <Stage state="done" title="Request sent">
            <p className={COPY}>
              <time
                dateTime={request.createdAt}
                title={formatDateTime(request.createdAt)}
              >
                {formatRelative(request.createdAt)}
              </time>
              {" · "}Reserved address{" "}
              <code className={CODE}>{request.subdomain}</code>
            </p>
          </Stage>

          <Stage
            state={rejected ? "failed" : approved ? "done" : "active"}
            title={rejected ? "Request declined" : "Operator approval"}
          >
            {rejected ? (
              <>
                <p className={COPY}>
                  An operator declined this request, so nothing was created and
                  its reserved capacity is free again.
                </p>
                {request.decisionReason ? (
                  <p className="m-0 border-l-2 border-line-strong pl-2.5 text-[13.5px] leading-[1.55] text-text-2">
                    Reason: {request.decisionReason}
                  </p>
                ) : null}
                <Link to="/" className={`${LINK_GHOST} -ml-3 w-fit px-3`}>
                  Back to my servers
                </Link>
              </>
            ) : approved ? (
              <p className={COPY}>
                Approved
                {approvedAt ? ` ${formatRelative(approvedAt)}` : ""}.
              </p>
            ) : (
              <p className={COPY}>
                An operator reviews every new request before anything is
                created. This page updates by itself, so you can leave it open
                or come back later.
              </p>
            )}
          </Stage>

          {rejected ? null : (
            <Stage
              state={
                serverUp
                  ? "done"
                  : stuck
                    ? "failed"
                    : approved
                      ? "active"
                      : "waiting"
              }
              title="Starting your server"
            >
              <p className={COPY}>
                {serverUp
                  ? `It's up and answering at ${request.subdomain}.`
                  : stuck
                    ? "Starting the server hit a problem. The operator has been told and can try again; this page keeps watching."
                    : approved
                      ? "Creating the machine, giving it an address and checking it answers on the network. This can take a few minutes."
                      : "Once approved, we create the machine and give it its own address."}
              </p>
            </Stage>
          )}

          {!rejected && hasSetup ? (
            <SetupStage request={request} serverUp={serverUp} />
          ) : null}

          {rejected ? null : (
            <Stage state={ready ? "done" : "waiting"} title="Ready to use">
              <p className={COPY}>
                {ready
                  ? "All done. The details are above."
                  : status === "stopped"
                    ? "The server is stopped. Start it again from your servers list."
                    : hasSetup
                      ? "You'll get the address and login details here."
                      : "You'll get the login command here."}
              </p>
            </Stage>
          )}
        </ol>
      </section>
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
