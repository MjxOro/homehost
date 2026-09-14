import { useEffect, useState } from "react";
import type { ReactElement } from "react";
import { formatDateTime, formatRelative } from "../../lib/format";
import {
  CheckCircleIcon,
  Spinner,
  UserIcon,
  XCircleIcon,
} from "../icons";

export interface AuditTrailItem {
  id: string;
  targetUserId: string;
  actorId: string;
  action: string;
  detail: string | null;
  createdAt: string;
}

interface AuditTrailPage {
  actions: AuditTrailItem[];
  hasMore: boolean;
  nextCursor: string | null;
}

const PAGE_SIZE = 20;

function encodeCursor(createdAt: string, id: string): string {
  return btoa(`${createdAt}|${id}`)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

const ACTION_META: Record<
  string,
  {
    icon: (props: { className?: string }) => ReactElement;
    className: string;
    label: string;
  }
> = {
  approve: {
    icon: CheckCircleIcon,
    className: "text-ok",
    label: "approved",
  },
  reject: { icon: XCircleIcon, className: "text-bad", label: "rejected" },
  classification: {
    icon: UserIcon,
    className: "text-accent",
    label: "updated classification for",
  },
};

function fallbackMeta(action: string) {
  return {
    icon: UserIcon,
    className: "text-text-3",
    label: action,
  };
}

export function AuditTrail({
  items = [],
  targetUserId,
}: {
  items?: AuditTrailItem[];
  targetUserId?: string;
}) {
  // Bare `<AuditTrail />` fetches its own first page on mount; a supplied
  // `items` head is rendered as-is and only paged forward.
  const needsFetch = items.length === 0;
  const [head, setHead] = useState<AuditTrailItem[] | null>(null);
  const [extraPages, setExtraPages] = useState<AuditTrailItem[][]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(needsFetch);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setHead(null);
    setExtraPages([]);
    setNextCursor(null);
    setHasMore(null);
    setError(null);
    if (!needsFetch) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
        if (targetUserId !== undefined) {
          params.set("targetUserId", targetUserId);
        }
        const response = await fetch(
          `/api/admin/actions?${params.toString()}`,
          { credentials: "same-origin" },
        );
        if (!response.ok) {
          throw new Error(
            `Could not load audit entries (server returned ${response.status}).`,
          );
        }
        const page = (await response.json()) as AuditTrailPage;
        if (cancelled) return;
        setHead(page.actions);
        setHasMore(page.hasMore);
        setNextCursor(page.nextCursor);
      } catch (err) {
        if (cancelled) return;
        setError(
          err instanceof Error ? err.message : "Could not load entries.",
        );
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [needsFetch, targetUserId]);

  const firstPage = (needsFetch ? (head ?? []) : items).slice(0, PAGE_SIZE);
  const seen = new Set(firstPage.map((item) => item.id));
  const appended: AuditTrailItem[] = [];
  for (const page of extraPages) {
    for (const item of page) {
      if (!seen.has(item.id)) {
        seen.add(item.id);
        appended.push(item);
      }
    }
  }
  const visible = [...firstPage, ...appended];

  const showMore = hasMore ?? firstPage.length >= PAGE_SIZE;

  async function handleShowMore() {
    if (loading) return;
    setLoading(true);
    setError(null);
    try {
      const last = visible[visible.length - 1];
      const params = new URLSearchParams({
        limit: String(PAGE_SIZE),
        cursor:
          nextCursor ?? (last ? encodeCursor(last.createdAt, last.id) : ""),
      });
      if (targetUserId !== undefined) {
        params.set("targetUserId", targetUserId);
      }
      const response = await fetch(`/api/admin/actions?${params.toString()}`, {
        credentials: "same-origin",
      });
      if (!response.ok) {
        throw new Error(
          `Could not load more audit entries (server returned ${response.status}).`,
        );
      }
      const page = (await response.json()) as AuditTrailPage;
      setExtraPages((prev) => [...prev, page.actions]);
      setHasMore(page.hasMore);
      setNextCursor(page.nextCursor);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not load more entries.",
      );
    } finally {
      setLoading(false);
    }
  }

  if (loading && visible.length === 0) {
    return (
      <p className="flex min-h-[44px] items-center gap-2 py-3 text-[14px] text-text-2">
        <Spinner className="size-4" /> Loading audit entries…
      </p>
    );
  }

  if (visible.length === 0 && !showMore) {
    return (
      <p className="py-3 text-[14px] text-text-2">No moderation actions yet.</p>
    );
  }

  return (
    <div>
      <ul className="m-0 flex list-none flex-col divide-y divide-line">
        {visible.map((item) => {
          const meta = ACTION_META[item.action] ?? fallbackMeta(item.action);
          const Icon = meta.icon;
          return (
            <li key={item.id} className="flex items-start gap-3 px-0.5 py-3">
              <Icon
                className={`mt-0.5 size-[18px] shrink-0 ${meta.className}`}
              />
              <div className="min-w-0 flex-1">
                <p className="text-[14px]">
                  <span className="font-semibold">{item.actorId}</span>{" "}
                  {meta.label}{" "}
                  <span className="text-text-2">{item.targetUserId}</span>
                </p>
                {item.detail ? (
                  <p className="mt-1 text-[13px] leading-[1.5] text-text-2">
                    {item.detail}
                  </p>
                ) : null}
              </div>
              <time
                className="whitespace-nowrap text-[12.5px] text-text-3"
                dateTime={item.createdAt}
                title={formatDateTime(item.createdAt)}
              >
                {formatRelative(item.createdAt)}
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
