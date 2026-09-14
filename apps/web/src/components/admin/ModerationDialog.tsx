import { useEffect, useId, useRef, useState } from "react";
import { ApiError } from "../../lib/api";
import {
  adminApi,
  type AdminUser,
  type TechnicalLevel,
} from "../../lib/api-admin";
import {
  BUTTON_DANGER,
  BUTTON_OUTLINE,
  BUTTON_PRIMARY,
  FORM_ERROR,
  ICON_BTN,
} from "../primitives";
import { Spinner, XIcon } from "../icons";

export type ModerationAction = "approve" | "reject" | "classify";

export interface ModerationDialogUser {
  id: string;
  email: string;
  name: string | null;
  accountStatus: AdminUser["accountStatus"];
  technicalLevel: TechnicalLevel | null;
}

interface ModerationDialogProps {
  user: ModerationDialogUser;
  action: ModerationAction;
  /** Invoking control, for the caller's post-close focus restore in onClose. */
  trigger: HTMLElement | null;
  onClose: (confirmed: boolean) => void;
  /** Optimistic refresh hook: parent applies the returned user to its rows. */
  onUpdated?: (user: AdminUser) => void;
}

const TITLES: Record<ModerationAction, string> = {
  approve: "Approve account",
  reject: "Reject account",
  classify: "Change classification",
};

const CONFIRM_LABELS: Record<ModerationAction, string> = {
  approve: "Approve",
  reject: "Reject account",
  classify: "Save classification",
};

function describeUser(user: ModerationDialogUser): string {
  return user.name ? `${user.name} (${user.email})` : user.email;
}

/**
 * Operator moderation dialog built on the native <dialog> element, following
 * the CancelDialog pattern: showModal() gives focus handling, inert
 * background and Escape-to-close for free. Padding lives on the inner panel,
 * so only clicks on the dialog canvas/backdrop (target === dialog) dismiss
 * it. Focus after close is owned solely by the caller's onClose.
 *
 * - approve: technical/non-technical radio, defaults to technical.
 * - reject: optional reason + required explicit-confirm checkbox; the confirm
 *   button stays disabled until the checkbox is checked.
 * Validation failures move focus to the first error; a role=status region
 * announces the in-flight state while the request runs.
 */
export function ModerationDialog({
  user,
  action,
  onClose,
  onUpdated,
}: ModerationDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const levelGroupRef = useRef<HTMLFieldSetElement>(null);
  const confirmCheckRef = useRef<HTMLInputElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const [level, setLevel] = useState<TechnicalLevel>(
    user.technicalLevel ?? "technical",
  );
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState<string | null>(null);
  const pendingRef = useRef(false);
  pendingRef.current = pending;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const levelName = useId();
  const reasonId = useId();
  const confirmId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    dialog.showModal();
    const onCancel = (event: Event) => {
      // Escape pressed — keep the dialog open while a request is in flight.
      event.preventDefault();
      if (!pendingRef.current) {
        dialog.close();
        onCloseRef.current(false);
      }
    };
    dialog.addEventListener("cancel", onCancel);
    return () => {
      dialog.removeEventListener("cancel", onCancel);
      if (dialog.open) dialog.close();
    };
    // Mount-once: latest callbacks flow through refs, like CancelDialog.
    // Focus after close is owned solely by the caller's onClose, which
    // receives the trigger element back via closure — same as CancelDialog.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Move focus to the first error whenever a failure appears.
  const focusFirstError = () => {
    if (action === "reject" && !confirmed) {
      confirmCheckRef.current?.focus();
      return;
    }
    const firstLevel = levelGroupRef.current?.querySelector("input");
    if (firstLevel instanceof HTMLElement) firstLevel.focus();
    else errorRef.current?.focus();
  };

  const closeWith = (confirmed: boolean) => {
    dialogRef.current?.close();
    onClose(confirmed);
  };

  const submit = async () => {
    if (pending) return;
    if (action === "reject" && !confirmed) {
      setError("Confirm the rejection to continue.");
      focusFirstError();
      return;
    }
    setError(null);
    setPending(true);
    setAnnouncement(
      action === "reject"
        ? `Rejecting ${describeUser(user)}…`
        : action === "approve"
          ? `Approving ${describeUser(user)}…`
          : `Saving classification for ${describeUser(user)}…`,
    );
    try {
      const updated =
        action === "approve"
          ? await adminApi.approveUser(user.id, { technicalLevel: level })
          : action === "reject"
            ? await adminApi.rejectUser(
                user.id,
                reason.trim() ? { reason: reason.trim() } : {},
              )
            : await adminApi.updateClassification(user.id, {
                technicalLevel: level,
              });
      onUpdated?.(updated);
      closeWith(true);
    } catch (submitError) {
      setError(
        submitError instanceof Error ? submitError.message : "Moderation failed.",
      );
      setAnnouncement(null);
      setPending(false);
      // Focus lands via the error effect; fall back to the first control
      // when the alert itself did not take focus.
      requestAnimationFrame(() => {
        if (!errorRef.current || document.activeElement !== errorRef.current)
          focusFirstError();
      });
    }
  };

  const confirmClass =
    action === "reject" ? BUTTON_DANGER : BUTTON_PRIMARY;
  const confirmDisabled =
    pending || (action === "reject" && !confirmed);

  return (
    <dialog
      ref={dialogRef}
      className="m-auto w-full max-w-[480px] bg-transparent p-0 text-text-1 backdrop:bg-[rgba(4,8,10,0.72)]"
      aria-labelledby="moderation-dialog-title"
      aria-describedby="moderation-dialog-desc"
      onClick={(event) => {
        if (event.target === dialogRef.current && !pending) {
          closeWith(false);
        }
      }}
    >
      <div className="max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-xl border border-line-strong bg-ink-1 p-5 shadow-pop">
        <div className="flex items-start justify-between gap-3">
          <h2 id="moderation-dialog-title" className="text-[18px] font-bold">
            {TITLES[action]}
          </h2>
          <button
            type="button"
            className={ICON_BTN}
            aria-label="Close dialog"
            onClick={() => closeWith(false)}
            disabled={pending}
          >
            <XIcon />
          </button>
        </div>
        <p
          id="moderation-dialog-desc"
          className="mt-3 text-[14px] leading-[1.6] text-text-2"
        >
          {action === "approve"
            ? `Approve ${describeUser(user)} and set their technical level.`
            : action === "reject"
              ? `Reject ${describeUser(user)}. They stay signed in but cannot use requests.`
              : `Change the technical classification for ${describeUser(user)}.`}
        </p>

        {action !== "reject" ? (
          <fieldset ref={levelGroupRef} className="mt-4">
            <legend className="text-[14px] font-[650]">
              Technical level
            </legend>
            <div className="mt-2 flex flex-col gap-2">
              {(
                [
                  { value: "technical", label: "Technical" },
                  { value: "non_technical", label: "Non-technical" },
                ] as const
              ).map((option) => (
                <label
                  key={option.value}
                  className="inline-flex min-h-11 cursor-pointer items-center gap-3 rounded-control border border-line-strong bg-ink-2 px-3 py-2 text-[14px]"
                >
                  <input
                    type="radio"
                    name={levelName}
                    value={option.value}
                    checked={level === option.value}
                    onChange={() => setLevel(option.value)}
                    disabled={pending}
                    className="size-[18px] accent-[var(--color-accent)]"
                  />
                  {option.label}
                </label>
              ))}
            </div>
          </fieldset>
        ) : null}

        {action === "reject" ? (
          <>
            <div className="mt-4">
              <label
                htmlFor={reasonId}
                className="text-[14px] font-[650]"
              >
                Reason <span className="font-normal text-text-3">(optional)</span>
              </label>
              <textarea
                id={reasonId}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                disabled={pending}
                rows={3}
                maxLength={500}
                placeholder="Why is this account being rejected?"
                className="mt-2 min-h-11 w-full rounded-control border border-line-strong bg-ink-2 px-3 py-2.5 text-[14px] leading-[1.5] text-text-1 placeholder:text-text-3"
              />
            </div>
            <label
              htmlFor={confirmId}
              className="mt-3 inline-flex min-h-11 cursor-pointer items-start gap-3 rounded-control border border-line-strong bg-ink-2 px-3 py-2.5 text-[14px] leading-[1.5]"
            >
              <input
                id={confirmId}
                ref={confirmCheckRef}
                type="checkbox"
                checked={confirmed}
                onChange={(event) => setConfirmed(event.target.checked)}
                disabled={pending}
                className="mt-0.5 size-[18px] shrink-0 accent-[var(--color-accent)]"
              />
              Yes, reject this account. I understand this blocks their access
              to requests.
            </label>
          </>
        ) : null}

        {error ? (
          <p
            ref={errorRef}
            tabIndex={-1}
            className={`${FORM_ERROR} mt-4 outline-none`}
            role="alert"
          >
            {error}
          </p>
        ) : null}
        {announcement && !error ? (
          <p role="status" className="sr-only">
            {announcement}
          </p>
        ) : null}

        <div className="mt-5 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <button
            type="button"
            className={`${BUTTON_OUTLINE} w-full sm:w-auto`}
            onClick={() => closeWith(false)}
            disabled={pending}
          >
            Cancel
          </button>
          <button
            type="button"
            className={`${confirmClass} w-full sm:w-auto`}
            disabled={confirmDisabled}
            onClick={submit}
          >
            {pending ? <Spinner className="spinner-sm" /> : null}
            {CONFIRM_LABELS[action]}
          </button>
        </div>
      </div>
    </dialog>
  );
}
