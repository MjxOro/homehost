import type { ReactNode } from "react";
import { PersonaPicker } from "./PersonaPicker";

/**
 * Gate shown wherever an authenticated view is reached without a session
 * (signed out, expired cookie). Offers the demo picker instead of a login form
 * — these personas are an explicit showcase opt-in, not a security boundary.
 */
export function SignInGate({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="mx-auto my-12 flex max-w-[660px] flex-col items-center gap-2.5 text-center">
      <h1 className="text-[clamp(22px,3.4vw,30px)] font-[750] tracking-[-0.01em]">
        {title}
      </h1>
      <p className="max-w-[54ch] leading-[1.6] text-text-2">
        {children ??
          "Pick one of the seeded demo personas to continue. Personas are showcase identities, not real accounts."}
      </p>
      <PersonaPicker />
      <p className="m-0 mt-1 max-w-[48ch] text-[12.5px] leading-[1.5] text-text-3">
        Demo identities exist only for this showcase — they are not
        authentication for real hosting.
      </p>
    </div>
  );
}
