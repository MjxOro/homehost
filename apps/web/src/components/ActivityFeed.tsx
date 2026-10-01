import { BUTTON_OUTLINE_SM } from "./primitives";
import { useListEntrance } from "../lib/app-motion";
import { useEffect, useState } from "react";
import type { ReactElement } from "react";
import type { ActivityEvent, ActivityPageResponse } from "@homehost/shared";
import { formatDateTime, formatRelative } from "../lib/format";
import { recipeLabel, setupErrorCopy } from "../lib/concierge";
import {
  CheckCircleIcon,
  ClockIcon,
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
  setup_started: {
    icon: Spinner,
    className: "text-accent",
    label: "started setup on",
  },
  setup_done: {
    icon: CheckCircleIcon,
    className: "text-ok",
    label: "finished setup on",
  },
  setup_failed: {
    icon: XCircleIcon,
    className: "text-bad",
    label: "setup failed on",
  },
};

/** A spinning action that a newer terminal event for the same request ended. */
const SUPERSEDED_META: Partial<
  Record<ActivityEvent["action"], (typeof ACTION_META)[ActivityEvent["action"]]>
> = {
  provisioning: {
    icon: CheckCircleIcon,
    className: "text-ok",
    label: "provisioned",
  },
  setup_started: {
    icon: ClockIcon,
    className: "text-text-3",
    label: "started setup on",
  },
};

/** Setup events carry ids and codes; show their plain-language form. */
function detailText(event: ActivityEvent): string | null {
  if (event.detail === null) return null;
  switch (event.action) {
    case "setup_started":
    case "setup_done":
      return recipeLabel(event.detail);
    case "setup_failed":
      return setupErrorCopy(event.detail);
    default:
      return event.detail;
  }
}

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
  const entrance = useListEntrance(visible);
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
    setup_done: true,
    setup_failed: true,
  };
  const terminalByRequest = new Set<string>();
  const superseded = new Set<string>();
  for (const event of visible) {
    if (TERMINAL_ACTIONS[event.action]) {
      terminalByRequest.add(event.requestId);
    } else if (
      SUPERSEDED_META[event.action] &&
      terminalByRequest.has(event.requestId)
    ) {
      superseded.add(event.id);
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
          const meta =
            (superseded.has(event.id)
              ? SUPERSEDED_META[event.action]
              : undefined) ?? ACTION_META[event.action];
          const detail = detailText(event);
          const Icon = meta.icon;
          return (
            <li
              key={event.id}
              className={`${entrance(event.id).className} flex items-start gap-3 px-0.5 py-3`}
              style={entrance(event.id).style}
            >
              <Icon
                className={`mt-0.5 size-[18px] shrink-0 ${meta.className}`}
              />
              <div className="min-w-0 flex-1">
                <p className="text-[14px]">
                  <span className="font-semibold">{event.actorName}</span>{" "}
                  {meta.label}{" "}
                  <span className="text-text-2">“{event.serverName}”</span>
                </p>
                {detail ? (
                  <p className="mt-1 text-[13px] leading-[1.5] text-text-2">
                    {detail}
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
        <p role="alert" className="animate-fade-in mt-2 text-[13px] text-bad">
          {error}
        </p>
      ) : null}
      {showMore ? (
        <button
          type="button"
          onClick={() => void handleShowMore()}
          disabled={loading}
          aria-busy={loading}
          className={`${BUTTON_OUTLINE_SM} mt-3 w-full`}
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
