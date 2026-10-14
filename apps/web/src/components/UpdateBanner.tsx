import { useState } from "react";
import { useNewerDeploy } from "../lib/query";
import { InfoIcon, XIcon } from "./icons";
import { BUTTON_OUTLINE_SM, ICON_BTN_QUIET } from "./primitives";

/**
 * Shown once a deploy finished while this tab kept running the previous
 * bundle. Never reloads on its own (a half-filled form would be lost);
 * dismissing hides it until the next deploy.
 */
export function UpdateBanner() {
  const deployed = useNewerDeploy();
  const [dismissed, setDismissed] = useState<string | null>(null);
  if (!deployed || dismissed === deployed) return null;
  return (
    <div
      role="status"
      className="animate-fade-in flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-accent-line bg-accent-dim py-1.5 pl-[clamp(16px,4vw,44px)] pr-[clamp(8px,2vw,32px)] text-[13.5px] text-text-2"
    >
      <InfoIcon className="size-[18px] shrink-0 text-accent" />
      <p className="m-0 min-w-0 flex-1 leading-[1.5]">
        A new version of Homehost is available. Refresh to get the latest.
      </p>
      <div className="flex items-center gap-1">
        <button
          type="button"
          className={BUTTON_OUTLINE_SM}
          onClick={() => window.location.reload()}
        >
          Refresh
        </button>
        <button
          type="button"
          className={ICON_BTN_QUIET}
          aria-label="Dismiss update notice"
          onClick={() => setDismissed(deployed)}
        >
          <XIcon />
        </button>
      </div>
    </div>
  );
}
