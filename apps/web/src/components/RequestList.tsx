import { useEffect, useMemo, useRef, useState } from "react";
import type { ServerRequest } from "@homehost/shared";
import {
  useCredentials,
  usePlans,
  useStartInstance,
  useStopInstance,
} from "../lib/query";
import { formatDateTime, formatMemory, formatRelative } from "../lib/format";
import { CancelDialog } from "./CancelDialog";
import {
  BUTTON_GHOST_SM,
  FORM_ERROR,
  ICON_BTN_QUIET,
  StatusPill,
} from "./primitives";
import { CheckIcon, CopyIcon, TrashIcon } from "./icons";

const CODE_BADGE =
  "rounded-md border border-line bg-ink-2 px-1.5 py-0.5 font-mono text-[12.5px] text-accent [overflow-wrap:anywhere]";

function resourceLine(request: ServerRequest): string {
  return `${request.cpu} CPU · ${formatMemory(request.memoryMb)} RAM · ${request.diskGb} GB disk`;
}

/** Subdomain is display text, never a (fake) reachable link. */
function SubdomainText({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="mt-2.5 inline-flex min-w-0 flex-wrap items-center gap-0.5">
      <code className={`${CODE_BADGE} min-w-0 break-all`}>{value}</code>
      <button
        type="button"
        className={ICON_BTN_QUIET}
        aria-label={copied ? "Subdomain copied" : `Copy subdomain ${value}`}
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
 * Copyable command for a leased box. Rendered only when the lease exists:
 * the worker writes the DNAT rule before the row ever reports a port.
 */
function SshCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="mt-2.5 inline-flex min-w-0 flex-wrap items-center gap-0.5">
      <code className={`${CODE_BADGE} min-w-0 break-all`}>{command}</code>
      <button
        type="button"
        className={ICON_BTN_QUIET}
        aria-label={
          copied ? "SSH command copied" : `Copy SSH command ${command}`
        }
        onClick={() => {
          void navigator.clipboard
            ?.writeText(command)
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
 * the secret never needs manual transcription.
 */
function PasswordReveal({ password }: { password: string }) {
  const [copied, setCopied] = useState(false);
  const revealedRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    revealedRef.current?.focus();
  }, []);
  return (
    <p
      ref={revealedRef}
      tabIndex={-1}
      className="mt-2.5 flex flex-wrap items-center gap-2 text-[13px] leading-[1.55] text-text-2"
    >
      <span>One-time root password (now cleared server-side):</span>
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
    </p>
  );
}

/**
 * Root access for a provisioned box: the bare `ssh root@<subdomain>` command
 * when running (dials over IPv6), then key status or the one-time password
 * flow.
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
      {request.status === "running" ? (
        <SshCommand command={`ssh root@${request.subdomain}`} />
      ) : null}
      {request.hasSshKey ? (
        <p className="mt-2.5 text-[13px] leading-[1.55] text-text-2">
          SSH key attached — root login by key.
        </p>
      ) : !allowPassword ? null : password !== null ? (
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
      )}
    </>
  );
}

interface RequestListProps {
  requests: ServerRequest[];
  onAnnounce: (message: string) => void;
}

function focusRequestsHeading() {
  const heading = document.getElementById("requests-heading");
  if (heading instanceof HTMLElement) {
    heading.focus();
  }
}

export function RequestList({ requests, onAnnounce }: RequestListProps) {
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
            className="flex flex-col justify-between gap-4 px-0.5 py-4 sm:flex-row sm:items-start"
          >
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-3">
                <h3 className="text-[15.5px] font-[650]">{request.name}</h3>
                <StatusPill status={request.status} />
              </div>
              <p className="mt-1.5 flex flex-wrap items-center gap-2 text-[13.5px] text-text-2">
                <span>{planNames.get(request.planId) ?? request.planId}</span>
                <span aria-hidden="true">·</span>
                <span>{resourceLine(request)}</span>
              </p>
              <SubdomainText value={request.subdomain} />
              {request.ipv4 ? <IpBadge value={request.ipv4} /> : null}
              {request.ipv6 ? <Ipv6Badge value={request.ipv6} /> : null}
              <SshAccess request={request} onAnnounce={onAnnounce} />
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
                  Cancel
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
                `“${target.request.name}” cancelled — reserved capacity released.`,
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
