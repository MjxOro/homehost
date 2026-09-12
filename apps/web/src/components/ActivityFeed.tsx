import type { ReactElement } from "react";
import type { ActivityEvent } from "@homehost/shared";
import { formatDateTime, formatRelative } from "../lib/format";
import { CheckCircleIcon, PlusIcon, TrashIcon, XCircleIcon } from "./icons";

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
  rejected: { icon: XCircleIcon, className: "text-bad", label: "rejected" },
  deleted: { icon: TrashIcon, className: "text-text-3", label: "deleted" },
};

export function ActivityFeed({ events }: { events: ActivityEvent[] }) {
  return (
    <ul className="m-0 flex list-none flex-col divide-y divide-line">
      {events.map((event) => {
        const meta = ACTION_META[event.action];
        const Icon = meta.icon;
        return (
          <li key={event.id} className="flex items-start gap-3 px-0.5 py-3">
            <Icon className={`mt-0.5 size-[18px] shrink-0 ${meta.className}`} />
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
  );
}
