import { useEffect, useRef } from "react";
import type { AccessToken } from "@homehost/shared";
import { useRevokeAccessToken } from "../lib/query";
import { useScrollLock } from "../lib/useScrollLock";
import {
  BUTTON_DANGER,
  BUTTON_OUTLINE,
  FORM_ERROR,
  ICON_BTN,
} from "./primitives";
import { Spinner, XIcon } from "./icons";

interface RevokeTokenDialogProps {
  token: AccessToken;
  onClose: (revoked: boolean) => void;
}

export function RevokeTokenDialog({ token, onClose }: RevokeTokenDialogProps) {
  useScrollLock(true);
  const revoke = useRevokeAccessToken();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const pendingRef = useRef(revoke.isPending);
  pendingRef.current = revoke.isPending;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    dialog.showModal();
    const onCancel = (event: Event) => {
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

  const closeWith = (revoked: boolean) => {
    dialogRef.current?.close();
    onClose(revoked);
  };

  return (
    <dialog
      ref={dialogRef}
      className="m-auto max-h-[calc(100svh-2rem)] w-[calc(100%-2rem)] max-w-[480px] overflow-y-auto overscroll-contain rounded-xl bg-transparent p-0 text-text-1 [overflow-wrap:anywhere] backdrop:bg-[rgba(4,8,10,0.72)] backdrop:animate-fade-in"
      aria-labelledby="revoke-token-dialog-title"
      onClick={(event) => {
        if (event.target === dialogRef.current && !revoke.isPending) {
          closeWith(false);
        }
      }}
    >
      <div className="animate-scale-in rounded-xl border border-line-strong bg-ink-1 p-5 shadow-pop">
        <div className="flex items-start justify-between gap-3">
          <h2 id="revoke-token-dialog-title" className="text-[18px] font-bold">
            Revoke this token?
          </h2>
          <button
            type="button"
            className={ICON_BTN}
            aria-label="Close dialog"
            onClick={() => closeWith(false)}
            disabled={revoke.isPending}
          >
            <XIcon />
          </button>
        </div>
        <p className="mt-3 text-[14px] leading-[1.6] text-text-2">
          Any agent using “{token.name}” loses access immediately. A revoked
          token cannot be restored; create a new one instead.
        </p>
        {revoke.isError ? (
          <p className={FORM_ERROR} role="alert">
            {revoke.error instanceof Error
              ? revoke.error.message
              : "Revoke failed."}
          </p>
        ) : null}
        <div className="mt-5 flex flex-wrap justify-end gap-3">
          <button
            type="button"
            className={BUTTON_OUTLINE}
            onClick={() => closeWith(false)}
            disabled={revoke.isPending}
          >
            Keep token
          </button>
          <button
            type="button"
            className={BUTTON_DANGER}
            disabled={revoke.isPending}
            onClick={() =>
              revoke.mutate(token.id, {
                onSuccess: () => closeWith(true),
              })
            }
          >
            {revoke.isPending ? <Spinner className="spinner-sm" /> : null}
            Revoke token
          </button>
        </div>
      </div>
    </dialog>
  );
}
