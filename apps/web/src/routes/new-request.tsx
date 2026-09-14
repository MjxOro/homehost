import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import type { Plan, PortalUser, ServerRequest } from "@homehost/shared";
import { isValidSshPublicKey } from "@homehost/shared";
import { isApiError } from "../lib/api";
import { formatMemory } from "../lib/format";
import {
  useCreateRequest,
  useDashboard,
  usePlans,
  useSession,
} from "../lib/query";
import { LockIcon, Spinner } from "../components/icons";
import { SignInGate } from "../components/SignInGate";
import {
  BUTTON_PRIMARY,
  CARD,
  Chip,
  ErrorState,
  FORM_ERROR,
  LINK_GHOST,
  LINK_PRIMARY,
  PageLoading,
  StatusPill,
} from "../components/primitives";

const NAME_MAX = 48;

const CODE_BADGE =
  "rounded-md border border-line bg-ink-2 px-1.5 py-0.5 font-mono text-[12.5px] text-accent [overflow-wrap:anywhere]";
const FIELD_LABEL = "text-[13.5px] font-semibold text-text-1";
const INPUT_FIELD =
  "min-h-11 w-full rounded-control border border-line-strong bg-ink-2 px-3 py-2.5 text-[14.5px] text-text-1 transition-colors placeholder:text-text-3 focus:border-accent aria-invalid:border-bad disabled:opacity-60";
const FIELD_HINT = "m-0 max-w-[62ch] text-[12.5px] leading-[1.5] text-text-3";
const COUNTER_BASE = "m-0 whitespace-nowrap font-mono text-[12px]";

function describeSubmitError(error: unknown): string {
  if (isApiError(error)) {
    if (error.status === 429) {
      return `${error.message} Cancel an existing request or ask an operator to adjust your tier.`;
    }
    if (error.status === 403) {
      return `${error.message} Locked plans need a technical friend tier.`;
    }
    if (error.status === 0) {
      return "Network error — the API did not respond.";
    }
    return error.message;
  }
  return "Unexpected error while submitting the request.";
}

interface PlanChoice {
  plan: Plan;
  locked: boolean;
}

const PLAN_RADIO_GRID =
  "grid grid-cols-[repeat(auto-fit,minmax(min(100%,230px),1fr))] gap-3";
const PLAN_CARD_LABEL =
  "flex h-full cursor-pointer flex-col gap-1.5 rounded-control border border-line-strong bg-ink-2 p-3.5 transition-[border-color,box-shadow] duration-[0.15s] ease-[ease] hover:border-text-3 peer-checked:border-accent peer-checked:shadow-[inset_0_0_0_1px_var(--color-accent)] peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent peer-disabled:cursor-not-allowed peer-disabled:opacity-60";

function PlanCards({
  choices,
  selectedId,
  disabled,
  onSelect,
}: {
  choices: PlanChoice[];
  selectedId: string | null;
  disabled: boolean;
  onSelect: (planId: string) => void;
}) {
  return (
    <fieldset className="min-w-0 border-0 p-0" disabled={disabled}>
      <legend className={`${FIELD_LABEL} mb-2.5 p-0`}>Plan</legend>
      <div className={PLAN_RADIO_GRID}>
        {choices.map(({ plan, locked }) => {
          const inputId = `plan-${plan.id}`;
          return (
            <div key={plan.id} className="relative">
              <input
                type="radio"
                id={inputId}
                name="plan"
                value={plan.id}
                className="peer absolute size-0.5 opacity-0"
                checked={selectedId === plan.id}
                disabled={locked}
                onChange={() => onSelect(plan.id)}
              />
              <label htmlFor={inputId} className={PLAN_CARD_LABEL}>
                <span className="flex flex-wrap items-center justify-between gap-2 [&>*]:min-w-0">
                  <span className="text-[14.5px] font-[650]">{plan.name}</span>
                  {locked ? (
                    <Chip>
                      <LockIcon className="size-3" /> technical only
                    </Chip>
                  ) : null}
                </span>
                <span className="text-[13.5px] text-text-2">
                  {plan.cpu} CPU · {formatMemory(plan.memoryMb)} RAM ·{" "}
                  {plan.diskGb} GB disk
                </span>
                <span className="text-[12.5px] leading-[1.5] text-text-3">
                  {locked
                    ? "Locked for your tier — technical friends can request this plan."
                    : "Resources reserve against your per-tier quota while pending or approved."}
                </span>
              </label>
            </div>
          );
        })}
      </div>
    </fieldset>
  );
}

function QuotaHint({ userId, plan }: { userId: string; plan: Plan | null }) {
  const dashboard = useDashboard(userId);
  if (!plan || dashboard.isPending || dashboard.isError) return null;
  const { quota, usage } = dashboard.data;
  const remaining = {
    servers: quota.servers - usage.servers,
    cpu: quota.cpu - usage.cpu,
    memoryMb: quota.memoryMb - usage.memoryMb,
    diskGb: quota.diskGb - usage.diskGb,
  };
  const fits =
    remaining.servers >= 1 &&
    remaining.cpu >= plan.cpu &&
    remaining.memoryMb >= plan.memoryMb &&
    remaining.diskGb >= plan.diskGb;
  if (fits) {
    return (
      <p className="m-0 rounded-control border border-line bg-ink-2 px-3 py-2.5 text-[13px] leading-[1.55] text-text-2">
        This fits your reserved quota — you hold {usage.servers} of{" "}
        {quota.servers} servers. The server still makes the final call.
      </p>
    );
  }
  return (
    <p
      className="m-0 rounded-control border border-[rgba(217,169,78,0.45)] bg-pending-dim px-3 py-2.5 text-[13px] leading-[1.55] text-[#e8c98a]"
      role="status"
    >
      This exceeds your remaining reserved quota ({remaining.servers} server(s),{" "}
      {remaining.cpu} CPU, {formatMemory(Math.max(0, remaining.memoryMb))} RAM,{" "}
      {Math.max(0, remaining.diskGb)} GB disk left). The server will reject it
      with a quota error — cancel something first or pick a smaller plan.
    </p>
  );
}

function SuccessPanel({ request }: { request: ServerRequest }) {
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  return (
    <div
      className="flex flex-col items-center gap-2.5 px-4 py-10 text-center"
      role="status"
    >
      <h2 className="text-[18px] font-bold" tabIndex={-1} ref={headingRef}>
        Request submitted
      </h2>
      <p className="max-w-[54ch] text-[14px] leading-[1.6] text-text-2">
        “{request.name}” is now <StatusPill status={request.status} />. An
        operator will review it — nothing has been created or started.
      </p>
      <p className="max-w-[54ch] text-[14px] leading-[1.6] text-text-2">
        Reserved subdomain label:{" "}
        <code className={CODE_BADGE}>{request.subdomain}</code>
      </p>
      <Link to="/" className={LINK_PRIMARY}>
        View dashboard
      </Link>
    </div>
  );
}

function RequestForm({ user }: { user: PortalUser }) {
  const plansQuery = usePlans();
  const createRequest = useCreateRequest();
  const [name, setName] = useState("");
  const [planId, setPlanId] = useState<string | null>(null);
  const [sshKey, setSshKey] = useState("");
  const [attempted, setAttempted] = useState(false);
  const [submitted, setSubmitted] = useState<ServerRequest | null>(null);

  const choices = useMemo<PlanChoice[]>(
    () =>
      (plansQuery.data ?? []).map((plan) => ({
        plan,
        locked: plan.technicalOnly && user.tier !== "technical",
      })),
    [plansQuery.data, user.tier],
  );

  if (submitted) return <SuccessPanel request={submitted} />;

  if (plansQuery.isPending) {
    return (
      <div className="flex flex-col gap-5" aria-hidden="true">
        <div className="skeleton skeleton-line w-56" />
        <div className="skeleton skeleton-row" />
        <div className="skeleton skeleton-row" />
      </div>
    );
  }
  if (plansQuery.isError) {
    return (
      <ErrorState
        error={plansQuery.error}
        onRetry={() => void plansQuery.refetch()}
      />
    );
  }

  const trimmed = name.trim();
  const nameTooLong = name.length > NAME_MAX;
  const nameError =
    trimmed.length === 0
      ? "Enter a server name."
      : nameTooLong
        ? `Name is limited to ${NAME_MAX} characters.`
        : null;
  const planError = planId === null ? "Choose a plan." : null;
  const selectedPlan =
    choices.find((choice) => choice.plan.id === planId)?.plan ?? null;
  const trimmedKey = sshKey.trim();
  const keyError =
    trimmedKey.length > 0 && !isValidSshPublicKey(trimmedKey)
      ? "Paste a single-line public key: <type> <base64> [comment]."
      : null;

  return (
    <form
      className="flex flex-col gap-[18px]"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        setAttempted(true);
        if (nameError || planError || keyError || !planId) return;
        createRequest.mutate(
          {
            name: trimmed,
            planId,
            sshPubkey: trimmedKey || undefined,
          },
          {
            onSuccess: (request) => setSubmitted(request),
          },
        );
      }}
    >
      <div className="flex flex-col gap-2">
        <label htmlFor="server-name" className={FIELD_LABEL}>
          Server name
        </label>
        <input
          id="server-name"
          name="server-name"
          type="text"
          className={INPUT_FIELD}
          value={name}
          maxLength={NAME_MAX + 16}
          disabled={createRequest.isPending}
          aria-invalid={attempted && nameError ? true : undefined}
          aria-describedby="server-name-hint server-name-counter"
          onChange={(event) => setName(event.target.value)}
          placeholder="e.g. valheim-weekend"
          autoComplete="off"
        />
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <p id="server-name-hint" className={FIELD_HINT}>
            1–{NAME_MAX} characters. The name seeds your subdomain label; the
            API trims whitespace and adds a unique suffix.
          </p>
          <p
            id="server-name-counter"
            className={
              nameTooLong
                ? `${COUNTER_BASE} text-bad`
                : `${COUNTER_BASE} text-text-3`
            }
          >
            {name.length}/{NAME_MAX}
          </p>
        </div>
        {attempted && nameError ? (
          <p className={FORM_ERROR} role="alert">
            {nameError}
          </p>
        ) : null}
      </div>

      <PlanCards
        choices={choices}
        selectedId={planId}
        disabled={createRequest.isPending}
        onSelect={setPlanId}
      />
      {attempted && planError ? (
        <p className={FORM_ERROR} role="alert">
          {planError}
        </p>
      ) : null}

      {selectedPlan ? <QuotaHint userId={user.id} plan={selectedPlan} /> : null}

      {selectedPlan ? (
        <div className="flex flex-col gap-2">
          <label htmlFor="ssh-key" className={FIELD_LABEL}>
            SSH public key <span className={FIELD_HINT}>(optional)</span>
          </label>
          <textarea
            id="ssh-key"
            name="ssh-key"
            rows={3}
            className={`${INPUT_FIELD} font-mono`}
            value={sshKey}
            disabled={createRequest.isPending}
            aria-invalid={attempted && keyError ? true : undefined}
            aria-describedby="ssh-key-hint"
            onChange={(event) => setSshKey(event.target.value)}
            placeholder="ssh-ed25519 AAAA… you@machine"
            autoComplete="off"
            spellCheck={false}
          />
          <p id="ssh-key-hint" className={FIELD_HINT}>
            Key-only root login when set. Empty means a generated password,
            shown once on the dashboard after provisioning.
          </p>
          {attempted && keyError ? (
            <p className={FORM_ERROR} role="alert">
              {keyError}
            </p>
          ) : null}
        </div>
      ) : null}

      {createRequest.isError ? (
        <p className={FORM_ERROR} role="alert">
          {describeSubmitError(createRequest.error)}
        </p>
      ) : null}

      <div className="flex flex-col-reverse flex-wrap justify-end gap-3 sm:flex-row">
        <Link to="/" className={`${LINK_GHOST} w-full sm:w-auto`}>
          Back to dashboard
        </Link>
        <button
          type="submit"
          className={`${BUTTON_PRIMARY} w-full sm:w-auto`}
          disabled={createRequest.isPending}
        >
          {createRequest.isPending ? <Spinner className="spinner-sm" /> : null}
          Submit request
        </button>
      </div>
    </form>
  );
}

export function NewRequestPage() {
  const { data: session, isPending } = useSession();
  if (isPending) return <PageLoading label="Loading your session…" />;
  if (!session?.user) {
    return (
      <SignInGate title="Sign in to request a server">
        Pick a demo persona to open the request form.
      </SignInGate>
    );
  }
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-[clamp(22px,3vw,28px)] font-bold tracking-[-0.01em]">
            New request
          </h1>
          <p className="mt-1.5 flex flex-wrap items-center gap-2 text-[14px] text-text-2">
            Every request starts as pending approval — an operator decides.
          </p>
        </div>
      </div>
      <div className={CARD}>
        <RequestForm key={session.user.id} user={session.user} />
      </div>
    </div>
  );
}
