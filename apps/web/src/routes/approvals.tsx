import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { PortalUser, ServerRequest } from "@homehost/shared";
import { isApiError } from "../lib/api";
import { formatDateTime, formatMemory, formatRelative } from "../lib/format";
import {
  queryKeys,
  useApprovals,
  useDecide,
  usePlans,
  useSession,
} from "../lib/query";
import { CheckIcon, Spinner, XIcon } from "../components/icons";
import { SignInGate } from "../components/SignInGate";
import {
  BUTTON_DANGER_SM,
  BUTTON_OUTLINE_SM,
  CARD,
  CARD_HEAD,
  CARD_SUB,
  CARD_TITLE,
  Chip,
  EmptyState,
  ErrorState,
  FORM_ERROR,
  LiveRegion,
  PageLoading,
} from "../components/primitives";

const REASON_MAX = 500;

const CODE_BADGE =
  "rounded-md border border-line bg-ink-2 px-1.5 py-0.5 font-mono text-[12.5px] text-accent [overflow-wrap:anywhere]";
const FIELD_LABEL = "text-[13.5px] font-semibold text-text-1";
const TEXTAREA_FIELD =
  "min-h-24 w-full resize-y rounded-control border border-line-strong bg-ink-2 px-3 py-2.5 text-[14.5px] leading-[1.5] text-text-1 transition-colors placeholder:text-text-3 focus:border-accent aria-invalid:border-bad disabled:opacity-60";
const FIELD_HINT = "m-0 max-w-[62ch] text-[12.5px] leading-[1.5] text-text-3";
const COUNTER_BASE = "m-0 whitespace-nowrap font-mono text-[12px]";

function ApprovalRow({
  request,
  planName,
  onDecided,
}: {
  request: ServerRequest;
  planName: string;
  onDecided: (message: string) => void;
}) {
  const decide = useDecide();
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");

  const busy = decide.isPending;
  const reasonTooLong = reason.length > REASON_MAX;

  const act = (decision: "approve" | "reject") => {
    decide.mutate(
      { id: request.id, decision, reason },
      {
        onSuccess: (updated) => {
          setRejecting(false);
          onDecided(
            decision === "approve"
              ? `“${updated.name}” approved — capacity reserved for ${updated.ownerName}. Nothing was provisioned.`
              : `“${updated.name}” rejected${updated.decisionReason ? ` — ${updated.decisionReason}` : ""}.`,
          );
        },
      },
    );
  };

  return (
    <li className="flex flex-col justify-between gap-4 px-0.5 py-4 sm:flex-row sm:items-start">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-3">
          <h3 className="text-[15.5px] font-[650]">{request.name}</h3>
          <Chip>pending approval</Chip>
        </div>
        <p className="mt-1.5 flex flex-wrap items-center gap-2 text-[13.5px] text-text-2">
          <span className="font-semibold">{request.ownerName}</span>
          <span aria-hidden="true">·</span>
          <span>{planName}</span>
          <span aria-hidden="true">·</span>
          <span>
            {request.cpu} CPU · {formatMemory(request.memoryMb)} RAM ·{" "}
            {request.diskGb} GB disk
          </span>
        </p>
        <p className="mt-1.5 flex flex-wrap items-center gap-2 text-[13.5px] text-text-2">
          <code className={CODE_BADGE}>{request.subdomain}</code>
          <span aria-hidden="true">·</span>
          <time
            dateTime={request.createdAt}
            title={formatDateTime(request.createdAt)}
          >
            {formatRelative(request.createdAt)}
          </time>
        </p>
        {decide.isError ? (
          <p className={FORM_ERROR} role="alert">
            {isApiError(decide.error) && decide.error.status === 409
              ? "This request was just decided by someone else — refreshing the queue."
              : decide.error instanceof Error
                ? decide.error.message
                : "Decision failed."}
          </p>
        ) : null}
        {rejecting ? (
          <div className="mt-3.5 flex max-w-[520px] flex-col gap-2">
            <label htmlFor={`reason-${request.id}`} className={FIELD_LABEL}>
              Reason for rejection{" "}
              <span className="font-normal text-text-3">(optional)</span>
            </label>
            <textarea
              id={`reason-${request.id}`}
              className={TEXTAREA_FIELD}
              rows={3}
              value={reason}
              maxLength={REASON_MAX + 64}
              aria-describedby={`reason-counter-${request.id}`}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Shown to the owner on their dashboard."
            />
            <div className="flex items-start justify-between gap-4">
              <p className={FIELD_HINT}>
                The owner sees this on their dashboard.
              </p>
              <p
                id={`reason-counter-${request.id}`}
                className={
                  reasonTooLong
                    ? `${COUNTER_BASE} text-bad`
                    : `${COUNTER_BASE} text-text-3`
                }
              >
                {reason.length}/{REASON_MAX}
              </p>
            </div>
            <div className="flex flex-wrap gap-2.5">
              <button
                type="button"
                className={BUTTON_OUTLINE_SM}
                disabled={busy}
                onClick={() => {
                  setRejecting(false);
                  setReason("");
                }}
              >
                Back
              </button>
              <button
                type="button"
                className={BUTTON_DANGER_SM}
                disabled={busy || reasonTooLong}
                onClick={() => act("reject")}
              >
                {busy ? <Spinner className="spinner-sm" /> : null}
                Confirm rejection
              </button>
            </div>
          </div>
        ) : null}
      </div>
      <div className="flex w-full items-center justify-between gap-2.5 sm:w-auto sm:flex-col sm:items-end">
        <div className="flex flex-wrap gap-2.5">
          <button
            type="button"
            className={BUTTON_OUTLINE_SM}
            disabled={busy || rejecting}
            onClick={() => act("approve")}
          >
            {busy ? <Spinner className="spinner-sm" /> : <CheckIcon />}
            Approve
          </button>
          <button
            type="button"
            className={BUTTON_DANGER_SM}
            disabled={busy || rejecting}
            onClick={() => setRejecting(true)}
          >
            <XIcon />
            Reject
          </button>
        </div>
      </div>
    </li>
  );
}

function ApprovalsQueue({ user }: { user: PortalUser }) {
  const approvals = useApprovals(user);
  const queryClient = useQueryClient();
  const plans = usePlans();
  const [liveMessage, setLiveMessage] = useState<string | null>(null);
  const planNames = new Map(
    (plans.data ?? []).map((plan) => [plan.id, plan.name]),
  );

  // A 401 means the cookie no longer maps to a session — ask /api/session for
  // the truth so the whole shell flips to signed out.
  const sessionExpired =
    isApiError(approvals.error) && approvals.error.status === 401;
  useEffect(() => {
    if (sessionExpired) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.session });
    }
  }, [sessionExpired, queryClient]);

  if (approvals.isPending) {
    return (
      <div className={CARD} aria-hidden="true">
        <div className="skeleton skeleton-line w-40" />
        <div className="skeleton skeleton-row" />
        <div className="skeleton skeleton-row" />
        <div className="skeleton skeleton-row" />
      </div>
    );
  }
  if (approvals.isError) {
    const error = approvals.error;
    if (isApiError(error) && error.status === 401) {
      return (
        <SignInGate title="Your session has ended">
          Pick a demo persona to sign back in.
        </SignInGate>
      );
    }
    if (isApiError(error) && error.status === 403) {
      return (
        <EmptyState
          title="Operator role required"
          copy="The approval queue is limited to operator personas. Switch persona from the topbar menu."
        />
      );
    }
    return (
      <ErrorState error={error} onRetry={() => void approvals.refetch()} />
    );
  }

  const { requests } = approvals.data;
  return (
    <div className="flex flex-col gap-5">
      <section className={CARD} aria-labelledby="queue-heading">
        <div className={CARD_HEAD}>
          <div>
            <h2 id="queue-heading" className={CARD_TITLE}>
              Pending approval
            </h2>
            <p className={CARD_SUB}>
              Requests from every owner, newest first. Approving reserves quota
              — it never starts a real server.
            </p>
          </div>
          {requests.length > 0 ? (
            <span className="inline-flex h-[26px] min-w-[26px] items-center justify-center rounded-full bg-accent px-1.5 font-mono text-[13px] font-bold text-on-accent">
              {requests.length}
            </span>
          ) : null}
        </div>
        {requests.length === 0 ? (
          <EmptyState
            title="Queue is clear"
            copy="Nothing is waiting for operator review right now."
          />
        ) : (
          <ul className="m-0 flex list-none flex-col divide-y divide-line">
            {requests.map((request) => (
              <ApprovalRow
                key={request.id}
                request={request}
                planName={planNames.get(request.planId) ?? request.planId}
                onDecided={setLiveMessage}
              />
            ))}
          </ul>
        )}
      </section>
      <LiveRegion message={liveMessage} />
    </div>
  );
}

export function ApprovalsPage() {
  const { data: session, isPending } = useSession();
  if (isPending) return <PageLoading label="Loading your session…" />;
  if (!session?.user) {
    return (
      <SignInGate title="Operator sign-in required">
        Pick the operator demo persona to open the approval queue.
      </SignInGate>
    );
  }
  if (session.user.role !== "operator") {
    return (
      <EmptyState
        title="Operator role required"
        copy="Approval actions are only visible to the operator persona. Your dashboard and requests are unaffected."
      />
    );
  }
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-[clamp(22px,3vw,28px)] font-bold tracking-[-0.01em]">
            Approvals
          </h1>
          <p className="mt-1.5 flex flex-wrap items-center gap-2 text-[14px] text-text-2">
            Decide pending requests from every owner on the showcase.
          </p>
        </div>
      </div>
      <ApprovalsQueue key={session.user.id} user={session.user} />
    </div>
  );
}
