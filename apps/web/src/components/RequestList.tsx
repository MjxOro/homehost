import { useListEntrance } from "../lib/app-motion";
import { Link } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ServerRequest, StreamTier } from "@homehost/shared";
import { estimateDownlinkMbps, recommendStreamProfile } from "@homehost/shared";
import {
  useCredentials,
  usePlans,
  useStartInstance,
  useStopInstance,
  queryKeys,
} from "../lib/query";
import { recipeLabel, setupChip } from "../lib/concierge";
import { formatDateTime, formatMemory, formatRelative } from "../lib/format";
import { CancelDialog } from "./CancelDialog";
import {
  BUTTON_GHOST_SM,
  BUTTON_OUTLINE_SM,
  Chip,
  FORM_ERROR,
  ICON_BTN_QUIET,
  StatusPill,
} from "./primitives";
import { CheckIcon, CopyIcon, Spinner, TrashIcon } from "./icons";

const CODE_BADGE =
  "rounded-md border border-line bg-ink-2 px-1.5 py-0.5 font-mono text-[12.5px] text-accent [overflow-wrap:anywhere]";

/** Small label chip for a copy box, mirroring the code badge's chip look. */
const LABEL_CHIP =
  "inline-block rounded border border-line bg-ink-2 px-1.5 py-0.5 text-[11px] font-semibold leading-[1.4] text-text-2";

function resourceLine(request: ServerRequest): string {
  return `${request.cpu} CPU · ${formatMemory(request.memoryMb)} RAM · ${request.diskGb} GB disk`;
}

/**
 * Display text with a copy button (1600 ms "copied" state, inert when the
 * clipboard is unavailable). `name` reads naturally in "Copy {name} {value}".
 * Addresses are display text, never (fake) reachable links.
 */
export function CopyCode({
  value,
  name,
  className = "mt-2.5",
}: {
  value: string;
  name: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const title = name.charAt(0).toUpperCase() + name.slice(1);
  return (
    <span
      className={`${className} inline-flex min-w-0 flex-wrap items-center gap-0.5`}
    >
      <code className={`${CODE_BADGE} min-w-0 break-all`}>{value}</code>
      <button
        type="button"
        className={ICON_BTN_QUIET}
        aria-label={copied ? `${title} copied` : `Copy ${name} ${value}`}
        onClick={() => {
          void navigator.clipboard
            ?.writeText(value)
            .then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1600);
            })
            .catch(() => {
              /* clipboard unavailable — leave the button inert */
            });
        }}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </button>
    </span>
  );
}

/** Tenant IPv4 is display text, like the subdomain. Shown only once addressed. */
function IpBadge({ value }: { value: string }) {
  return (
    <span className="mt-2.5 inline-flex min-w-0 flex-wrap items-center gap-2">
      <span className="text-[13px] text-text-2">IP</span>
      <code className={`${CODE_BADGE} min-w-0 break-all`}>{value}</code>
    </span>
  );
}

/** Public IPv6 is display text like the IPv4 badge. Shown once assigned. */
function Ipv6Badge({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="mt-2.5 inline-flex min-w-0 flex-wrap items-center gap-2">
      <span className="text-[13px] text-text-2">IPv6</span>
      <code className={`${CODE_BADGE} min-w-0 break-all`}>{value}</code>
      <button
        type="button"
        className={ICON_BTN_QUIET}
        aria-label={copied ? "IPv6 copied" : `Copy IPv6 ${value}`}
        onClick={() => {
          void navigator.clipboard
            ?.writeText(value)
            .then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1600);
            })
            .catch(() => {
              /* clipboard unavailable — leave the button inert */
            });
        }}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </button>
    </span>
  );
}

/**
 * Revealed one-time password with focus management and a copy button, so
 * the secret never needs manual transcription. The label chip names the box;
 * focus lands on the wrapper so the label, secret, and one-time note are all
 * announced together.
 */
function PasswordReveal({ password }: { password: string }) {
  const [copied, setCopied] = useState(false);
  const revealedRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    revealedRef.current?.focus();
  }, []);
  return (
    <div ref={revealedRef} tabIndex={-1} className="mt-2.5">
      <span className={LABEL_CHIP}>One-time password</span>
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <code className={`${CODE_BADGE} min-w-0 break-all`}>{password}</code>
        <button
          type="button"
          className={ICON_BTN_QUIET}
          aria-label={copied ? "Password copied" : "Copy one-time password"}
          onClick={() => {
            void navigator.clipboard
              ?.writeText(password)
              .then(() => {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1600);
              })
              .catch(() => {
                /* clipboard unavailable — leave the button inert */
              });
          }}
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
        </button>
      </div>

      <p className="mt-1 text-[13px] leading-[1.55] text-text-2">
        Now cleared server-side — it will not be shown again.
      </p>
    </div>
  );
}

/** Desktop request shape: reads the ratified desktop fields structurally so the
 *  row renders against the current ServerRequest type and the landed contract
 *  alike. */
interface DesktopLink {
  hostname: string | null;
  env: string | null;
}

function desktopOf(request: ServerRequest): DesktopLink {
  let hostname: string | null = null;
  let env: string | null = null;
  if ("desktopHostname" in request) {
    const value: unknown = request.desktopHostname;
    if (typeof value === "string" && value.length > 0) hostname = value;
  }
  if ("desktopEnv" in request) {
    const value: unknown = request.desktopEnv;
    if (typeof value === "string" && value.length > 0) env = value;
  }
  return { hostname, env };
}

/** Human label for a desktop env slug; unknown slugs pass through verbatim. */
const DESKTOP_ENV_LABELS: Record<string, string> = {
  "ubuntu-xfce": "Ubuntu XFCE",
  omarchy: "Omarchy",
};

/** Stream tier hint via a client-only timed same-origin /api/health fetch.
 *  Never blocks the Open-desktop link; neutral fallback on any failure. */
function StreamTierHint() {
  const [tier, setTier] = useState<StreamTier | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      const started =
        typeof performance !== "undefined" && performance.now
          ? performance.now()
          : Date.now();
      try {
        const response = await fetch("/api/health", {
          credentials: "same-origin",
          cache: "no-store",
        });
        const bytes = Number(response.headers.get("content-length") ?? 0);
        await response.arrayBuffer();
        const now =
          typeof performance !== "undefined" && performance.now
            ? performance.now()
            : Date.now();
        const downMbps =
          bytes > 0 ? estimateDownlinkMbps(bytes, now - started) : null;
        const recommendation = recommendStreamProfile({
          downMbps: downMbps ?? NaN,
        });
        if (!cancelled) setTier(recommendation.tier);
      } catch {
        if (!cancelled) setFailed(true);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, []);
  if (failed || tier === null) return <Chip>stream: auto</Chip>;
  return <Chip>stream: {tier}</Chip>;
}

/**
 * Browser GUI access for a desktop VM. The Open-desktop link navigates
 * inside the SPA to `/desktop/:id`, where the panel-hosted canvas
 * auto-connects over the same-origin session. A
 * stopped VM keeps the link disabled until the instance starts again, and
 * provisioning rows stay disabled with an honest waiting note.
 */
function DesktopAccess({ request }: { request: ServerRequest }) {
  const desktop = desktopOf(request);
  const live = request.status === "running" && desktop.hostname !== null;
  if (
    request.status !== "provisioning" &&
    request.status !== "running" &&
    request.status !== "stopped"
  ) {
    return null;
  }
  if (desktop.hostname === null && desktop.env === null) return null;
  return (
    <div className="mt-2.5 flex flex-col items-start gap-1.5">
      <span className={LABEL_CHIP}>Desktop</span>
      <span className="flex flex-wrap items-center gap-2">
        {live ? (
          <Link
            to="/desktop/$id"
            params={{ id: request.id }}
            className={`${BUTTON_OUTLINE_SM} focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent`}
          >
            Open desktop
          </Link>
        ) : (
          <span
            aria-disabled="true"
            className={`${BUTTON_OUTLINE_SM} pointer-events-none opacity-55`}
          >
            Open desktop
          </span>
        )}
        {desktop.env ? (
          <Chip tone="accent">
            {DESKTOP_ENV_LABELS[desktop.env] ?? desktop.env}
          </Chip>
        ) : null}
        {(request.status === "running" || request.status === "provisioning") &&
        desktop.hostname !== null ? (
          <StreamTierHint />
        ) : null}
      </span>
      {request.status === "running" ? (
        <span className="text-[13px] leading-[1.55] text-text-2">
          {desktop.hostname ? (
            <>
              Direct edge:{" "}
              <code className={CODE_BADGE}>https://{desktop.hostname}</code>{" "}
              (panel session still required) — opens here and connects
              automatically.
            </>
          ) : (
            <>KasmVNC canvas — opens here and connects automatically.</>
          )}
        </span>
      ) : null}
      {request.status === "provisioning" ? (
        <span className="text-[13px] leading-[1.55] text-text-3">
          Desktop is provisioning — the link activates once the instance is
          running.
        </span>
      ) : null}
      {request.status === "stopped" ? (
        <span className="text-[13px] leading-[1.55] text-text-3">
          Desktop is offline while the instance is stopped — start it to
          reconnect.
        </span>
      ) : null}
    </div>
  );
}

/**
 * Root access for a provisioned box, top to bottom: the bare
 * `ssh root@<subdomain>` command when running (dials over IPv6), then the
 * key status note, then the one-time password flow.
 */
export function SshAccess({
  request,
  onAnnounce,
  allowPassword = true,
}: {
  request: ServerRequest;
  onAnnounce: (message: string) => void;
  /**
   * False hides the one-time password control: reading it clears the secret
   * server-side, so previews on other people's rows would burn their read.
   */
  allowPassword?: boolean;
}) {
  const credentials = useCredentials();
  const [password, setPassword] = useState<string | null>(null);
  const [consumed, setConsumed] = useState(false);
  if (
    request.status !== "provisioning" &&
    request.status !== "running" &&
    request.status !== "stopped"
  ) {
    return null;
  }
  return (
    <>
      {request.status === "provisioning" ? (
        <p className="mt-2.5 text-[13px] leading-[1.55] text-text-2">
          Setting up the network. Your SSH address appears once the box answers.
        </p>
      ) : null}
      {request.status === "running" ? (
        <div className="animate-fade-in mt-2.5 flex flex-col items-start gap-1 [&>span]:mt-0">
          <span className={LABEL_CHIP}>SSH</span>
          <CopyCode
            value={`ssh root@${request.subdomain}`}
            name="SSH command"
          />
        </div>
      ) : null}
      {request.hasSshKey ? (
        <p className="mt-2.5 text-[13px] leading-[1.55] text-text-2">
          SSH key attached — root login by key.
        </p>
      ) : null}
      {!request.hasSshKey && allowPassword ? (
        password !== null ? (
          <PasswordReveal password={password} />
        ) : request.status === "provisioning" ? (
          <p className="mt-2.5 text-[13px] leading-[1.55] text-text-2">
            Root password appears here once provisioning finishes.
          </p>
        ) : (
          <span className="mt-2.5 inline-flex flex-wrap items-center gap-2">
            <button
              type="button"
              className={BUTTON_GHOST_SM}
              disabled={credentials.isPending}
              onClick={() => {
                credentials.mutate(request.id, {
                  onSuccess: (data) => {
                    if (data.password) {
                      setPassword(data.password);
                      onAnnounce(
                        `One-time password for “${request.name}” shown. It will not be shown again.`,
                      );
                    } else {
                      setConsumed(true);
                      onAnnounce(
                        `No password on file for “${request.name}” — already shown or never generated.`,
                      );
                    }
                  },
                });
              }}
            >
              Show one-time password
            </button>
            {consumed ? (
              <span className="text-[13px] text-text-3">
                No password on file — already shown or never generated.
              </span>
            ) : null}
            {credentials.isError ? (
              <span className={FORM_ERROR} role="alert">
                Could not load the password.
              </span>
            ) : null}
          </span>
        )
      ) : null}
    </>
  );
}

interface RequestListProps {
  requests: ServerRequest[];
  onAnnounce: (message: string) => void;
}

/** Rows in worker/operator-driven states that will flip on their own. */
const NON_TERMINAL_STATUSES = new Set([
  "pending_approval",
  "approved",
  "provisioning",
]);

const LIVE_PILL_BASE =
  "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[13px] font-semibold transition-colors duration-(--duration-fast)";

/**
 * Live status for rows that are about to flip. Awaiting approval is static
 * (an operator still has to decide); approved/provisioning animate with a
 * spinner plus text. Turnover is driven by the short-interval dashboard
 * refetch in RequestList, so it updates without a manual reload.
 */
function LiveStatusPill({ status }: { status: ServerRequest["status"] }) {
  if (status === "pending_approval") {
    return (
      <span
        className={`${LIVE_PILL_BASE} border-[rgba(217,169,78,0.4)] bg-pending-dim text-pending`}
        role="status"
      >
        Awaiting approval
      </span>
    );
  }
  if (status !== "approved" && status !== "provisioning") {
    return <StatusPill status={status} />;
  }
  return (
    <span
      className={
        status === "provisioning"
          ? `${LIVE_PILL_BASE} border-accent-line bg-accent-dim text-accent`
          : `${LIVE_PILL_BASE} border-[rgba(217,169,78,0.4)] bg-pending-dim text-pending`
      }
      role="status"
    >
      <Spinner className="spinner-sm" />
      Provisioning…
    </span>
  );
}

const SETUP_TONE = {
  busy: "border-accent-line bg-accent-dim text-accent",
  ok: "border-[rgba(94,201,143,0.4)] bg-ok-dim text-ok",
  bad: "border-[rgba(224,108,108,0.4)] bg-bad-dim text-bad",
} as const;

/**
 * Setup state for a box with software, linking to its progress page. Setup
 * runs once the box is up, so earlier states show "Follow progress" instead.
 */
function SetupChip({ request }: { request: ServerRequest }) {
  const chip = setupChip(request);
  if (!chip || (request.status !== "running" && request.status !== "stopped"))
    return null;
  return (
    <Link
      to="/servers/$id"
      params={{ id: request.id }}
      className="group inline-flex min-h-11 items-center rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
    >
      <span
        className={`${LIVE_PILL_BASE} ${SETUP_TONE[chip.tone]} group-hover:underline`}
      >
        {chip.tone === "busy" ? <Spinner className="spinner-sm" /> : null}
        {chip.label}
      </span>
    </Link>
  );
}

function focusRequestsHeading() {
  const heading = document.getElementById("requests-heading");
  if (heading instanceof HTMLElement) {
    heading.focus();
  }
}

export function RequestList({ requests, onAnnounce }: RequestListProps) {
  const entrance = useListEntrance(requests);
  const plansQuery = usePlans();
  const planNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const plan of plansQuery.data ?? []) map.set(plan.id, plan.name);
    return map;
  }, [plansQuery.data]);
  const [target, setTarget] = useState<{
    request: ServerRequest;
    trigger: HTMLElement | null;
  } | null>(null);
  const stop = useStopInstance();
  const start = useStartInstance();
  const [powerError, setPowerError] = useState<string | null>(null);
  const busy = stop.isPending || start.isPending;
  const queryClient = useQueryClient();
  const awaitingFlip = requests.some(
    (request) =>
      NON_TERMINAL_STATUSES.has(request.status) ||
      request.setupStatus === "pending" ||
      request.setupStatus === "running",
  );
  // Worker/operator-driven transitions land server-side; while any row can
  // still flip, refetch faster than the base poll so the live pill and rows
  // converge within seconds instead of up to the 10s interval.
  useEffect(() => {
    if (!awaitingFlip) return;
    const id = window.setInterval(() => {
      void queryClient.refetchQueries({ queryKey: queryKeys.dashboard });
    }, 3_000);
    return () => window.clearInterval(id);
  }, [awaitingFlip, queryClient]);
  const power = (request: ServerRequest, verb: "stop" | "start") => {
    setPowerError(null);
    const mutation = verb === "stop" ? stop : start;
    mutation.mutate(request.id, {
      onSuccess: () => {
        onAnnounce(
          verb === "stop"
            ? `“${request.name}” stopping — the instance shuts down shortly.`
            : `“${request.name}” starting — the instance boots shortly.`,
        );
        focusRequestsHeading();
      },
      onError: (error) => {
        setPowerError(
          error instanceof Error
            ? error.message
            : `Could not ${verb} “${request.name}”.`,
        );
      },
    });
  };

  return (
    <>
      {powerError ? (
        <p className={FORM_ERROR} role="alert">
          {powerError}
        </p>
      ) : null}
      <ul className="m-0 flex list-none flex-col divide-y divide-line">
        {requests.map((request) => (
          <li
            key={request.id}
            className={`${entrance(request.id).className} flex flex-col justify-between gap-4 px-0.5 py-4 sm:flex-row sm:items-start`}
            style={entrance(request.id).style}
          >
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-3">
                <h3 className="text-[15.5px] font-[650]">{request.name}</h3>
                <LiveStatusPill status={request.status} />
                <SetupChip request={request} />
                {NON_TERMINAL_STATUSES.has(request.status) ? (
                  <Link
                    to="/servers/$id"
                    params={{ id: request.id }}
                    className="inline-flex min-h-11 items-center text-[13.5px] font-semibold text-accent underline-offset-2 hover:underline"
                  >
                    Follow progress
                  </Link>
                ) : null}
              </div>
              <p className="mt-1.5 flex flex-wrap items-center gap-2 text-[13.5px] text-text-2">
                <span>{planNames.get(request.planId) ?? request.planId}</span>
                <span aria-hidden="true">·</span>
                <span>{resourceLine(request)}</span>
              </p>
              {request.status === "provisioning" ? null : (
                <CopyCode value={request.subdomain} name="subdomain" />
              )}
              {request.ipv4 ? <IpBadge value={request.ipv4} /> : null}
              {request.ipv6 ? <Ipv6Badge value={request.ipv6} /> : null}
              {request.gameAddress ? (
                <div className="mt-2.5 flex flex-col items-start gap-1">
                  <span className={LABEL_CHIP}>
                    {request.recipeId
                      ? `${recipeLabel(request.recipeId)} address`
                      : "Game address"}
                  </span>
                  <CopyCode
                    value={request.gameAddress}
                    name="game address"
                    className=""
                  />
                </div>
              ) : null}
              <SshAccess request={request} onAnnounce={onAnnounce} />
              <DesktopAccess request={request} />
              {request.status === "rejected" && request.decisionReason ? (
                <p className="mt-2.5 border-l-2 border-line-strong pl-2.5 text-[13px] leading-[1.55] text-text-2">
                  Reason: {request.decisionReason}
                </p>
              ) : null}
            </div>
            <div className="flex w-full flex-col gap-2 sm:w-auto sm:items-end">
              <time
                className="whitespace-nowrap text-[12.5px] text-text-3"
                dateTime={request.createdAt}
                title={formatDateTime(request.createdAt)}
              >
                {formatRelative(request.createdAt)}
              </time>
              <div className="flex w-full items-center justify-between gap-2.5 sm:w-auto sm:flex-col sm:items-end">
                {request.status === "running" ? (
                  <button
                    type="button"
                    className={BUTTON_GHOST_SM}
                    disabled={busy}
                    onClick={() => power(request, "stop")}
                  >
                    Stop
                  </button>
                ) : null}
                {request.status === "stopped" ? (
                  <button
                    type="button"
                    className={BUTTON_GHOST_SM}
                    disabled={busy}
                    onClick={() => power(request, "start")}
                  >
                    Start
                  </button>
                ) : null}
                <button
                  type="button"
                  className={BUTTON_GHOST_SM}
                  onClick={(event) =>
                    setTarget({ request, trigger: event.currentTarget })
                  }
                >
                  <TrashIcon />
                  Delete
                </button>
              </div>
            </div>
          </li>
        ))}
      </ul>
      {target ? (
        <CancelDialog
          request={target.request}
          trigger={target.trigger}
          onClose={(confirmed) => {
            const trigger = target.trigger;
            setTarget(null);
            if (confirmed) {
              onAnnounce(
                `“${target.request.name}” deleted — reserved capacity released.`,
              );
              focusRequestsHeading();
            } else if (trigger?.isConnected) {
              trigger.focus();
            }
          }}
        />
      ) : null}
    </>
  );
}
