import { useMemo, useState } from "react";
import type { ServerRequest } from "@homehost/shared";
import { usePlans } from "../lib/query";
import { formatDateTime, formatMemory, formatRelative } from "../lib/format";
import { CancelDialog } from "./CancelDialog";
import { BUTTON_GHOST_SM, ICON_BTN_QUIET, StatusPill } from "./primitives";
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
    <span className="mt-2.5 inline-flex items-center gap-0.5">
      <code className={CODE_BADGE}>{value}</code>
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

  return (
    <>
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
              {request.status === "rejected" && request.decisionReason ? (
                <p className="mt-2.5 border-l-2 border-line-strong pl-2.5 text-[13px] leading-[1.55] text-text-2">
                  Reason: {request.decisionReason}
                </p>
              ) : null}
            </div>
            <div className="flex w-full items-center justify-between gap-2.5 sm:w-auto sm:flex-col sm:items-end">
              <time
                className="whitespace-nowrap text-[12.5px] text-text-3"
                dateTime={request.createdAt}
                title={formatDateTime(request.createdAt)}
              >
                {formatRelative(request.createdAt)}
              </time>
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
