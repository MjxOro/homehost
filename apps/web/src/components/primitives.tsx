import type { ReactNode } from "react";
import type { Quota, RequestStatus } from "@homehost/shared";
import { isApiError } from "../lib/api";
import { isNetworkError } from "../lib/query";
import { formatMemory } from "../lib/format";
import { AlertIcon, CheckCircleIcon, ServerIcon, Spinner } from "./icons";

/**
 * Shared control recipes (complete literal strings) so every instance renders
 * identically. BUTTON_* are for real <button> elements: hover styles use
 * enabled:hover so disabled controls never show a hover state. LINK_* are for
 * <a> CTAs, which never match :disabled and keep plain hover:. Weights of 650
 * match the pre-migration sheet (Tailwind has no 650 step).
 */
export const BUTTON_PRIMARY =
  "inline-flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-control border border-transparent bg-accent px-4 py-2 text-[14px] font-[650] text-on-accent no-underline transition-colors enabled:hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-55 [&_svg]:size-[17px]";
export const LINK_PRIMARY =
  "inline-flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-control border border-transparent bg-accent px-4 py-2 text-[14px] font-[650] text-on-accent no-underline transition-colors hover:bg-accent-strong [&_svg]:size-[17px]";
export const BUTTON_OUTLINE =
  "inline-flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-control border border-line-strong bg-ink-2 px-4 py-2 text-[14px] font-[650] text-text-1 no-underline transition-colors enabled:hover:border-accent-line enabled:hover:text-accent disabled:cursor-not-allowed disabled:opacity-55 [&_svg]:size-[17px]";
export const BUTTON_OUTLINE_SM =
  "inline-flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-control border border-line-strong bg-ink-2 px-3 py-1.5 text-[14px] font-[650] text-text-1 no-underline transition-colors enabled:hover:border-accent-line enabled:hover:text-accent disabled:cursor-not-allowed disabled:opacity-55 [&_svg]:size-[17px]";
export const BUTTON_GHOST =
  "inline-flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-control border border-transparent bg-transparent px-4 py-2 text-[14px] font-[650] text-text-2 no-underline transition-colors enabled:hover:bg-ink-2 enabled:hover:text-text-1 disabled:cursor-not-allowed disabled:opacity-55 [&_svg]:size-[17px]";
export const BUTTON_GHOST_SM =
  "inline-flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-control border border-transparent bg-transparent px-3 py-1.5 text-[14px] font-[650] text-text-2 no-underline transition-colors enabled:hover:bg-ink-2 enabled:hover:text-text-1 disabled:cursor-not-allowed disabled:opacity-55 [&_svg]:size-[17px]";
export const LINK_GHOST =
  "inline-flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-control border border-transparent bg-transparent px-4 py-2 text-[14px] font-[650] text-text-2 no-underline transition-colors hover:bg-ink-2 hover:text-text-1 [&_svg]:size-[17px]";
export const BUTTON_DANGER =
  "inline-flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-control border border-[rgba(224,108,108,0.5)] bg-transparent px-4 py-2 text-[14px] font-[650] text-[#f0a8a8] no-underline transition-colors enabled:hover:border-bad enabled:hover:bg-bad-dim disabled:cursor-not-allowed disabled:opacity-55 [&_svg]:size-[17px]";
export const BUTTON_DANGER_SM =
  "inline-flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-control border border-[rgba(224,108,108,0.5)] bg-transparent px-3 py-1.5 text-[14px] font-[650] text-[#f0a8a8] no-underline transition-colors enabled:hover:border-bad enabled:hover:bg-bad-dim disabled:cursor-not-allowed disabled:opacity-55 [&_svg]:size-[17px]";
export const ICON_BTN =
  "inline-flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-control border-0 bg-transparent text-text-2 transition-colors enabled:hover:bg-ink-2 enabled:hover:text-text-1 disabled:cursor-not-allowed disabled:opacity-55 [&_svg]:size-[19px]";
export const ICON_BTN_QUIET =
  "inline-flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-control border-0 bg-transparent text-text-3 transition-colors enabled:hover:bg-ink-2 enabled:hover:text-text-1 disabled:cursor-not-allowed disabled:opacity-55 [&_svg]:size-[19px]";
export const FORM_ERROR =
  "m-0 rounded-control border border-[rgba(224,108,108,0.45)] bg-bad-dim px-3 py-2.5 text-[13.5px] leading-[1.5] text-[#f0a8a8]";

export const CARD = "rounded-card border border-line bg-ink-1 p-4 sm:p-5";
export const CARD_HEAD =
  "mb-3.5 flex flex-wrap items-start justify-between gap-4 [&>*]:min-w-0";
export const CARD_TITLE = "text-[16px] font-[650] tracking-[-0.005em]";
export const CARD_SUB =
  "mt-1 max-w-[72ch] text-[13.5px] leading-[1.5] text-text-3";

const PILL_BASE =
  "inline-flex items-center gap-2 text-balance rounded-full border px-2.5 py-1 text-[13px] font-semibold";
const STATE_PANEL = "flex flex-col items-center gap-2.5 px-4 py-10 text-center";
const STATE_TITLE = "text-[18px] font-bold";
const STATE_COPY = "max-w-[54ch] text-[14px] leading-[1.6] text-text-2";

export function PageLoading({ label = "Loading…" }: { label?: string }) {
  return (
    <div
      className="flex items-center justify-center gap-3 py-[72px] text-[14px] text-text-2"
      role="status"
    >
      <Spinner />
      <span>{label}</span>
    </div>
  );
}

/** Visually hidden (but screen-reader announced) polite live region. */
export function LiveRegion({ message }: { message: string | null }) {
  return (
    <div aria-live="polite" className="sr-only">
      {message ?? ""}
    </div>
  );
}

interface ErrorStateProps {
  error: unknown;
  onRetry?: () => void;
  retryLabel?: string;
  title?: string;
}

export function ErrorState({
  error,
  onRetry,
  retryLabel = "Try again",
  title,
}: ErrorStateProps) {
  const heading =
    title ??
    (isNetworkError(error) ? "The API is unreachable" : "Something went wrong");
  const detail = isApiError(error)
    ? error.status === 0
      ? "The control plane did not respond. Check that the API and the Vite proxy are running."
      : `The server reported: “${error.message}”`
    : "An unexpected error occurred while loading this view.";
  return (
    <div className={STATE_PANEL} role="alert">
      <AlertIcon className="size-7 text-bad" />
      <h2 className={STATE_TITLE}>{heading}</h2>
      <p className={STATE_COPY}>{detail}</p>
      {onRetry ? (
        <button type="button" className={BUTTON_OUTLINE} onClick={onRetry}>
          {retryLabel}
        </button>
      ) : null}
    </div>
  );
}

interface EmptyStateProps {
  title: string;
  copy?: string;
  action?: ReactNode;
}

export function EmptyState({ title, copy, action }: EmptyStateProps) {
  return (
    <div className={STATE_PANEL}>
      <ServerIcon className="size-7 text-text-3" />
      <h2 className={STATE_TITLE}>{title}</h2>
      {copy ? <p className={STATE_COPY}>{copy}</p> : null}
      {action ?? null}
    </div>
  );
}

export function SuccessState({ title, copy, action }: EmptyStateProps) {
  return (
    <div className={STATE_PANEL}>
      <CheckCircleIcon className="size-7 text-ok" />
      <h2 className={STATE_TITLE}>{title}</h2>
      {copy ? <p className={STATE_COPY}>{copy}</p> : null}
      {action ?? null}
    </div>
  );
}

const STATUS_META: Record<RequestStatus, { label: string; className: string }> =
  {
    pending_approval: {
      label: "Pending approval",
      className: `${PILL_BASE} border-[rgba(217,169,78,0.4)] bg-pending-dim text-pending`,
    },
    approved: {
      label: "Approved · not provisioned",
      className: `${PILL_BASE} border-[rgba(94,201,143,0.4)] bg-ok-dim text-ok`,
    },
    provisioning: {
      label: "Provisioning…",
      className: `${PILL_BASE} border-accent-line bg-accent-dim text-accent`,
    },
    running: {
      label: "Running",
      className: `${PILL_BASE} border-[rgba(94,201,143,0.4)] bg-ok-dim text-ok`,
    },
    stopped: {
      label: "Stopped",
      className: `${PILL_BASE} border-line-strong text-text-2`,
    },
    rejected: {
      label: "Rejected",
      className: `${PILL_BASE} border-[rgba(224,108,108,0.4)] bg-bad-dim text-bad`,
    },
    deleted: {
      label: "Deleted",
      className: `${PILL_BASE} border-line-strong text-text-2`,
    },
  };

export function StatusPill({ status }: { status: RequestStatus }) {
  const meta = STATUS_META[status];
  return (
    <span className={meta.className}>
      <span className="size-2 rounded-full bg-current" aria-hidden="true" />
      {meta.label}
    </span>
  );
}

export function Chip({
  children,
  tone,
}: {
  children: ReactNode;
  tone?: "accent" | "plain";
}) {
  return (
    <span
      className={
        tone === "accent"
          ? "inline-flex items-center gap-1 whitespace-nowrap rounded-md border border-accent-line bg-accent-dim px-[7px] py-[3px] font-mono text-[11px] uppercase tracking-[0.04em] text-accent"
          : "inline-flex items-center gap-1 whitespace-nowrap rounded-md border border-line-strong px-[7px] py-[3px] font-mono text-[11px] uppercase tracking-[0.04em] text-text-2"
      }
    >
      {children}
    </span>
  );
}

interface QuotaBarProps {
  label: string;
  used: number;
  max: number;
  format?: (value: number) => string;
}

export function QuotaBar({ label, used, max, format }: QuotaBarProps) {
  const render = format ?? ((value: number) => String(value));
  const pct = max > 0 ? Math.min(100, Math.round((used / max) * 100)) : 0;
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1 text-[13px] [&>*]:min-w-0">
        <span className="min-w-0 text-text-2">{label}</span>
        <span className="font-mono text-[12.5px] tabular-nums text-text-1">
          {render(used)} / {render(max)}
        </span>
      </div>
      <div
        className="h-2 overflow-hidden rounded-full bg-ink-3"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={used}
      >
        <div
          className="h-full rounded-full bg-accent transition-[width] duration-[0.4s] ease-[ease]"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

export function QuotaCardSkeleton() {
  return (
    <div className={CARD} aria-hidden="true">
      <div className="skeleton skeleton-line w-40" />
      <div className="grid grid-cols-1 gap-[18px] sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="flex flex-col">
            <div className="skeleton skeleton-line w-24" />
            <div className="skeleton skeleton-bar" />
          </div>
        ))}
      </div>
    </div>
  );
}

const QUOTA_ROWS: {
  key: keyof Quota;
  label: string;
  format?: (value: number) => string;
}[] = [
  { key: "servers", label: "Servers" },
  { key: "cpu", label: "CPU (cores)" },
  { key: "memoryMb", label: "Memory", format: formatMemory },
  { key: "diskGb", label: "Disk", format: (value) => `${value} GB` },
];

export function QuotaCard({
  quota,
  usage,
  tier,
}: {
  quota: Quota;
  usage: Quota;
  tier: string;
}) {
  return (
    <section className={CARD} aria-labelledby="quota-heading">
      <div className={CARD_HEAD}>
        <div>
          <h2 id="quota-heading" className={CARD_TITLE}>
            Reserved capacity
          </h2>
          <p className={CARD_SUB}>
            Tier quota for a {tier} member. Pending and approved requests
            reserve capacity — this is never live usage.
          </p>
        </div>
      </div>
      <div className="grid grid-cols-1 gap-[18px] sm:grid-cols-2 lg:grid-cols-4">
        {QUOTA_ROWS.map((row) => (
          <QuotaBar
            key={row.key}
            label={row.label}
            used={usage[row.key]}
            max={quota[row.key]}
            format={row.format}
          />
        ))}
      </div>
    </section>
  );
}
