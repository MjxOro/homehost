import { useState } from "react";
import type { AccountStatus, AdminUser } from "../../lib/api-admin";
import { ModerationDialog, type ModerationAction } from "./ModerationDialog";
import {
  BUTTON_GHOST_SM,
  BUTTON_OUTLINE_SM,
  Chip,
  EmptyState,
} from "../primitives";
import { formatDateTime, formatRelative } from "../../lib/format";

const PAGE_SIZE = 25;

const ACCOUNT_PILL_BASE =
  "inline-flex items-center gap-2 text-balance rounded-full border px-2.5 py-1 text-[13px] font-semibold";

/**
 * Account statuses are operator decisions: static, never auto-flipping.
 * Every state renders as still text — no spinner on any status.
 */
const ACCOUNT_STATUS_META: Record<
  AccountStatus,
  { label: string; className: string }
> = {
  pending: {
    label: "Pending",
    className: `${ACCOUNT_PILL_BASE} border-[rgba(217,169,78,0.4)] bg-pending-dim text-pending`,
  },
  approved: {
    label: "Approved",
    className: `${ACCOUNT_PILL_BASE} border-[rgba(94,201,143,0.4)] bg-ok-dim text-ok`,
  },
  rejected: {
    label: "Rejected",
    className: `${ACCOUNT_PILL_BASE} border-[rgba(224,108,108,0.4)] bg-bad-dim text-bad`,
  },
  suspended: {
    label: "Suspended",
    className: `${ACCOUNT_PILL_BASE} border-line-strong text-text-2`,
  },
};

function AccountStatusPill({ status }: { status: AccountStatus }) {
  // Unknown future statuses must degrade to a neutral pill, never a crash:
  // `ACCOUNT_STATUS_META[status]` is undefined for any value outside the map.
  const meta = ACCOUNT_STATUS_META[status] ?? {
    label: status,
    className: `${ACCOUNT_PILL_BASE} border-line-strong text-text-2`,
  };
  return (
    <span className={meta.className}>
      <span className="size-2 rounded-full bg-current" aria-hidden="true" />
      <span translate="no">{meta.label}</span>
    </span>
  );
}

function TechnicalBadge({
  level,
}: {
  level: AdminUser["technicalLevel"];
}) {
  if (level === "technical") {
    return <Chip tone="accent">Technical</Chip>;
  }
  if (level === "non_technical") {
    return <Chip>Non-technical</Chip>;
  }
  return <Chip>Not classified</Chip>;
}

function describeUpdate(user: AdminUser, action: ModerationAction): string {
  if (action === "approve") {
    return user.technicalLevel === "non_technical"
      ? `${user.email} approved as non-technical.`
      : `${user.email} approved as technical.`;
  }
  if (action === "reject") {
    return `${user.email} rejected.`;
  }
  return user.technicalLevel === "non_technical"
    ? `${user.email} classified as non-technical.`
    : `${user.email} classified as technical.`;
}

interface UserTableProps {
  users: AdminUser[];
  onAnnounce: (message: string) => void;
}

/**
 * Operator user queue. Presentational like RequestList: the page fetches
 * (via lib/api-admin) and passes the slice; the table paginates within it
 * and opens ModerationDialog for all three moderation actions.
 */
export function UserTable({ users, onAnnounce }: UserTableProps) {
  const [page, setPage] = useState(0);
  const [target, setTarget] = useState<{
    user: AdminUser;
    action: ModerationAction;
    trigger: HTMLElement | null;
  } | null>(null);

  if (users.length === 0) {
    return (
      <EmptyState
        title="No users"
        copy="No accounts match this filter yet."
      />
    );
  }

  const pageCount = Math.max(1, Math.ceil(users.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const visible = users.slice(
    safePage * PAGE_SIZE,
    safePage * PAGE_SIZE + PAGE_SIZE,
  );

  return (
    <>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-left text-[14px]">
          <caption className="sr-only">
            User accounts pending operator review
          </caption>
          <thead>
            <tr className="border-b border-line text-[12.5px] uppercase tracking-[0.04em] text-text-3">
              <th scope="col" className="px-2 py-2.5 pr-3 font-semibold">
                User
              </th>
              <th scope="col" className="px-2 py-2.5 font-semibold">
                Status
              </th>
              <th scope="col" className="px-2 py-2.5 font-semibold">
                Technical
              </th>
              <th scope="col" className="px-2 py-2.5 font-semibold">
                Reviewed
              </th>
              <th scope="col" className="px-2 py-2.5 pl-3 font-semibold">
                <span className="sr-only">Moderation actions</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {visible.map((user) => (
              <tr key={user.id} className="align-top">
                <td className="min-w-0 px-2 py-3 pr-3">
                  <div className="flex min-w-0 flex-col gap-1">
                    <span
                      className="font-[650] text-text-1 [overflow-wrap:anywhere]"
                      translate="no"
                    >
                      {user.email}
                    </span>
                    <span className="text-[13px] text-text-3">
                      {user.name ?? "No display name"}
                    </span>
                  </div>
                </td>
                <td className="whitespace-nowrap px-2 py-3">
                  <AccountStatusPill status={user.accountStatus} />
                </td>
                <td className="whitespace-nowrap px-2 py-3">
                  <TechnicalBadge level={user.technicalLevel} />
                </td>
                <td className="whitespace-nowrap px-2 py-3 text-[13px] text-text-2">
                  {user.reviewedBy ?? user.reviewedAt ? (
                    <span className="flex flex-col gap-0.5">
                      {user.reviewedBy ? (
                        <span translate="no">{user.reviewedBy}</span>
                      ) : null}
                      {user.reviewedAt ? (
                        <time
                          dateTime={user.reviewedAt}
                          title={formatDateTime(user.reviewedAt)}
                        >
                          {formatRelative(user.reviewedAt)}
                        </time>
                      ) : null}
                    </span>
                  ) : (
                    <span className="text-text-3">Not reviewed</span>
                  )}
                </td>
                <td className="px-2 py-3 pl-3">
                  <div className="flex flex-wrap gap-2">
                    {user.accountStatus === "pending" ? (
                      <button
                        type="button"
                        className={BUTTON_OUTLINE_SM}
                        aria-label={`Approve ${user.email}`}
                        onClick={(event) =>
                          setTarget({
                            user,
                            action: "approve",
                            trigger: event.currentTarget,
                          })
                        }
                      >
                        Approve
                      </button>
                    ) : null}
                    {user.accountStatus === "pending" ? (
                      <button
                        type="button"
                        className={BUTTON_GHOST_SM}
                        aria-label={`Reject ${user.email}`}
                        onClick={(event) =>
                          setTarget({
                            user,
                            action: "reject",
                            trigger: event.currentTarget,
                          })
                        }
                      >
                        Reject
                      </button>
                    ) : null}
                    {user.accountStatus === "pending" ||
                    user.accountStatus === "approved" ? (
                      <button
                        type="button"
                        className={BUTTON_GHOST_SM}
                        aria-label={`Classify ${user.email} as technical or non-technical`}
                        onClick={(event) =>
                          setTarget({
                            user,
                            action: "classify",
                            trigger: event.currentTarget,
                          })
                        }
                      >
                        Classify
                      </button>
                    ) : null}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {pageCount > 1 ? (
        <nav
          className="mt-4 flex flex-wrap items-center justify-between gap-3"
          aria-label="User pages"
        >
          <p className="text-[13px] text-text-2" role="status">
            Page {safePage + 1} of {pageCount}
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              className={BUTTON_OUTLINE_SM}
              disabled={safePage === 0}
              onClick={() => setPage(safePage - 1)}
            >
              Previous page
            </button>
            <button
              type="button"
              className={BUTTON_OUTLINE_SM}
              disabled={safePage === pageCount - 1}
              onClick={() => setPage(safePage + 1)}
            >
              Next page
            </button>
          </div>
        </nav>
      ) : null}
      {target ? (
        <ModerationDialog
          user={target.user}
          action={target.action}
          trigger={target.trigger}
          onClose={() => {
            const trigger = target.trigger;
            setTarget(null);
            if (trigger?.isConnected) {
              trigger.focus();
            }
          }}
          onUpdated={(updated) => {
            onAnnounce(describeUpdate(updated, target.action));
          }}
        />
      ) : null}
    </>
  );
}
