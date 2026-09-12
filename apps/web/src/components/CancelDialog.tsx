import { useEffect, useRef } from "react";
import type { ServerRequest } from "@homehost/shared";
import { useCancelRequest } from "../lib/query";
import {
  BUTTON_DANGER,
  BUTTON_OUTLINE,
  FORM_ERROR,
  ICON_BTN,
} from "./primitives";
import { Spinner, XIcon } from "./icons";

const COPY: Record<
  ServerRequest["status"],
  { title: string; confirm: string }
> = {
  pending_approval: {
    title: "Cancel this request?",
    confirm: "Withdraw request",
  },
  approved: {
    title: "Release this reservation?",
    confirm: "Release reservation",
  },
  rejected: {
    title: "Remove this rejected request?",
    confirm: "Remove request",
  },
  deleted: {
    title: "Remove this request?",
    confirm: "Remove request",
  },
};

function bodyText(request: ServerRequest): string {
  switch (request.status) {
    case "pending_approval":
      return `“${request.name}” is still waiting for operator review. Withdrawing it releases the reserved capacity immediately.`;
    case "approved":
      return `“${request.name}” is approved but was never provisioned. Releasing it frees the reserved capacity — there is no running server to shut down.`;
    case "rejected":
      return `“${request.name}” holds no capacity. Removing it simply clears it from your list.`;
    default:
      return `Remove “${request.name}”?`;
  }
}

interface CancelDialogProps {
  request: ServerRequest;
  trigger: HTMLElement | null;
  onClose: (confirmed: boolean) => void;
}

/**
 * Confirmation dialog for tenant-scoped cancellation, built on the native
 * <dialog> element. showModal() gives focus handling, inert background and
 * Escape-to-close for free. The mount effect runs once and reads the latest
 * callbacks/refs so parent re-renders can never re-show or tear down the
 * dialog mid-task. Padding lives on the inner panel, so only clicks on the
 * dialog canvas/backdrop (target === dialog) dismiss it. Focus after close is
 * owned solely by the caller's onClose.
 */
export function CancelDialog({ request, trigger, onClose }: CancelDialogProps) {
  const cancel = useCancelRequest();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const pendingRef = useRef(cancel.isPending);
  pendingRef.current = cancel.isPending;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const copy = COPY[request.status];

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    dialog.showModal();
    const onCancel = (event: Event) => {
      // Escape pressed — keep the dialog open while a DELETE is in flight.
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
  }, []);

  const closeWith = (confirmed: boolean) => {
    dialogRef.current?.close();
    onClose(confirmed);
  };

  return (
    <dialog
      ref={dialogRef}
      className="m-auto w-full max-w-[480px] bg-transparent p-0 text-text-1 backdrop:bg-[rgba(4,8,10,0.72)]"
      aria-labelledby="cancel-dialog-title"
      onClick={(event) => {
        // Clicks on the backdrop/canvas are delivered with the dialog itself
        // as target; clicks inside the panel target panel content.
        if (event.target === dialogRef.current && !cancel.isPending) {
          closeWith(false);
        }
      }}
    >
      <div className="rounded-xl border border-line-strong bg-ink-1 p-5 shadow-pop">
        <div className="flex items-start justify-between gap-3">
          <h2 id="cancel-dialog-title" className="text-[18px] font-bold">
            {copy.title}
          </h2>
          <button
            type="button"
            className={ICON_BTN}
            aria-label="Close dialog"
            onClick={() => closeWith(false)}
            disabled={cancel.isPending}
          >
            <XIcon />
          </button>
        </div>
        <p className="mt-3 text-[14px] leading-[1.6] text-text-2">
          {bodyText(request)}
        </p>
        {cancel.isError ? (
          <p className={FORM_ERROR} role="alert">
            {cancel.error instanceof Error
              ? cancel.error.message
              : "Cancellation failed."}
          </p>
        ) : null}
        <div className="mt-5 flex flex-wrap justify-end gap-3">
          <button
            type="button"
            className={BUTTON_OUTLINE}
            onClick={() => closeWith(false)}
            disabled={cancel.isPending}
          >
            Keep request
          </button>
          <button
            type="button"
            className={BUTTON_DANGER}
            disabled={cancel.isPending}
            onClick={() =>
              cancel.mutate(request.id, {
                onSuccess: () => closeWith(true),
              })
            }
          >
            {cancel.isPending ? <Spinner className="spinner-sm" /> : null}
            {copy.confirm}
          </button>
        </div>
      </div>
    </dialog>
  );
}
