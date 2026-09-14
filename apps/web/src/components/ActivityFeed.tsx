import { useEffect, useState } from "react";
import type { ReactElement } from "react";
import type { ActivityEvent, ActivityPageResponse } from "@homehost/shared";
import { formatDateTime, formatRelative } from "../lib/format";
import {
  CheckCircleIcon,
  PlusIcon,
  Spinner,
  TrashIcon,
  XCircleIcon,
} from "./icons";

const PAGE_SIZE = 20;

function encodeCursor(createdAt: string, id: string): string {
  return btoa(`${createdAt}|${id}`)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

const ACTION_META: Record<
  ActivityEvent["action"],
  {
    icon: (props: { className?: string }) => ReactElement;
    className: string;
    label: string;
  }
> = {
  requested: { icon: PlusIcon, className: "text-accent", label: "requested" },
  approved: { icon: CheckCircleIcon, className: "text-ok", label: "approved" },
  provisioning: {
    icon: Spinner,
    className: "text-accent",
    label: "provisioning",
  },
  running: { icon: CheckCircleIcon, className: "text-ok", label: "running" },
  stopped: { icon: TrashIcon, className: "text-text-3", label: "stopped" },
  provision_failed: {
    icon: XCircleIcon,
    className: "text-bad",
    label: "provision failed",
  },
  rejected: { icon: XCircleIcon, className: "text-bad", label: "rejected" },
  deleted: { icon: TrashIcon, className: "text-text-3", label: "deleted" },
};

export function ActivityFeed({ events }: { events: ActivityEvent[] }) {
  const firstPage = events.slice(0, PAGE_SIZE);
  const [extraPages, setExtraPages] = useState<ActivityEvent[][]>([]);
  const [hasMore, setHasMore] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Dashboard polls, so freshly fetched heads merge with appended older
  // pages below; ids dedupe so nothing renders twice.
  const seen = new Set(firstPage.map((event) => event.id));
  const appended: ActivityEvent[] = [];
  for (const page of extraPages) {
    for (const event of page) {
      if (!seen.has(event.id)) {
        seen.add(event.id);
        appended.push(event);
      }
    }
  }
  const visible = [...firstPage, ...appended];
  // Terminal actions end provisioning for a request. `visible` is newest
  // first, so a provisioning row is superseded when a terminal event for the
  // same request was already seen above it. A paged-out successor is simply
  // not loaded, and the row keeps its spinner.
  const TERMINAL_ACTIONS: Record<string, true> = {
    running: true,
    provision_failed: true,
    failed: true,
    stopped: true,
    rejected: true,
    cancelled: true,
    deleted: true,
  };
  const terminalByRequest = new Set<string>();
  const supersededProvisioning = new Set<string>();
  for (const event of visible) {
    if (TERMINAL_ACTIONS[event.action]) {
      terminalByRequest.add(event.requestId);
    } else if (
      event.action === "provisioning" &&
      terminalByRequest.has(event.requestId)
    ) {
      supersededProvisioning.add(event.id);
    }
  }

  // A new head (fresh events arrived, persona switched) reopens pagination;
  // appended pages stay merged below, deduped by id.
  const headId = firstPage[0]?.id ?? null;
  useEffect(() => {
    setHasMore(null);
    setExtraPages([]);
  }, [headId]);

  const showMore = hasMore ?? firstPage.length >= PAGE_SIZE;

  async function handleShowMore() {
    const last = visible[visible.length - 1];
    if (loading || !last) return;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        limit: String(PAGE_SIZE),
        cursor: encodeCursor(last.createdAt, last.id),
      });
      const response = await fetch(`/api/activity?${params.toString()}`, {
        credentials: "same-origin",
      });
      if (!response.ok) {
        throw new Error(
          `Could not load more activity (server returned ${response.status}).`,
        );
      }
      const page = (await response.json()) as ActivityPageResponse;
      setExtraPages((prev) => [...prev, page.activity]);
      setHasMore(page.hasMore);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not load more activity.",
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <ul className="m-0 flex list-none flex-col divide-y divide-line">
        {visible.map((event) => {
          const meta = supersededProvisioning.has(event.id)
            ? {
                icon: CheckCircleIcon,
                className: "text-ok",
                label: "provisioned",
              }
            : ACTION_META[event.action];
          const Icon = meta.icon;
          return (
            <li key={event.id} className="flex items-start gap-3 px-0.5 py-3">
              <Icon
                className={`mt-0.5 size-[18px] shrink-0 ${meta.className}`}
              />
              <div className="min-w-0 flex-1">
                <p className="text-[14px]">
                  <span className="font-semibold">{event.actorName}</span>{" "}
                  {meta.label}{" "}
                  <span className="text-text-2">“{event.serverName}”</span>
                </p>
                {event.detail ? (
                  <p className="mt-1 text-[13px] leading-[1.5] text-text-2">
                    {event.detail}
                  </p>
                ) : null}
              </div>
              <time
                className="whitespace-nowrap text-[12.5px] text-text-3"
                dateTime={event.createdAt}
                title={formatDateTime(event.createdAt)}
              >
                {formatRelative(event.createdAt)}
              </time>
            </li>
          );
        })}
      </ul>
      {error ? (
        <p role="alert" className="mt-2 text-[13px] text-bad">
          {error}
        </p>
      ) : null}
      {showMore ? (
        <button
          type="button"
          onClick={() => void handleShowMore()}
          disabled={loading}
          aria-busy={loading}
          className="mt-3 flex min-h-[44px] w-full items-center justify-center gap-2 rounded-control border border-line bg-ink-2 px-4 text-[14px] font-semibold disabled:cursor-wait disabled:opacity-60"
        >
          {loading ? (
            <>
              <Spinner className="size-4" /> Loading…
            </>
          ) : (
            "Show more"
          )}
        </button>
      ) : null}
    </div>
  );
}
