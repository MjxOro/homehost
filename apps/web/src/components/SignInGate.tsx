import type { ReactNode } from "react";
import { useSession } from "../lib/query";
import { PersonaPicker } from "./PersonaPicker";
import { BUTTON_OUTLINE, LINK_PRIMARY } from "./primitives";

interface ProviderTarget {
  href: string;
  label: string;
}

const STEPS: Array<{ title: string; copy: string }> = [
  { title: "Request a box.", copy: "Pick a plan and send a request." },
  {
    title: "Operator approves.",
    copy: "A lab operator reviews it and provisions a real machine.",
  },
  {
    title: "SSH over IPv6.",
    copy: "Connect straight to your box — no leased ports.",
  },
];

const LIVE_FACTS = [
  "SSH on your bare subdomain",
  "A dedicated IPv6 address per box",
  "No leased ports to manage",
];

/**
 * Live-mode sign-in panel. Leads with what Homehost is, how a box goes from
 * request to SSH, and the network facts that matter — then the real login
 * buttons. Rendered wherever sign-in is offered; the buttons are plain
 * anchors so the provider dance runs outside the SPA.
 */
export function OAuthButtons() {
  const { data: session, isPending } = useSession();
  const providers = session?.providers;
  const targets: ProviderTarget[] = [
    providers?.google
      ? { href: "/api/auth/google", label: "Continue with Google" }
      : null,
    providers?.github
      ? { href: "/api/auth/github", label: "Continue with GitHub" }
      : null,
  ].filter((t): t is ProviderTarget => t !== null);
  const [primary, ...secondary] = targets;

  return (
    <div className="flex w-full flex-col gap-4 text-left">
      <p className="m-0 text-[15.5px] font-[700] tracking-[-0.005em] text-text-1">
        Your personal homelab control panel.
      </p>
      <ol
        aria-label="How it works"
        className="m-0 flex list-none flex-col gap-2.5 p-0"
      >
        {STEPS.map((step, i) => (
          <li
            key={step.title}
            className="flex gap-3 text-[14px] leading-[1.55]"
          >
            <span aria-hidden="true" className="font-[750] text-accent">
              {i + 1}
            </span>
            <span className="text-text-2">
              <strong className="font-[650] text-text-1">{step.title}</strong>{" "}
              {step.copy}
            </span>
          </li>
        ))}
      </ol>
      <ul
        aria-label="Connection facts"
        className="m-0 flex list-none flex-wrap gap-2 p-0"
      >
        {LIVE_FACTS.map((fact) => (
          <li
            key={fact}
            className="rounded-full border border-line bg-ink-2 px-2.5 py-1 text-[12.5px] font-[600] text-text-2"
          >
            {fact}
          </li>
        ))}
      </ul>
      {primary ? (
        <div className="flex w-full flex-col gap-2.5">
          <a
            className={`${LINK_PRIMARY} min-h-12 w-full text-[15px]`}
            href={primary.href}
          >
            {primary.label}
          </a>
          {secondary.map((t) => (
            <a
              key={t.href}
              className={`${BUTTON_OUTLINE} w-full`}
              href={t.href}
            >
              {t.label}
            </a>
          ))}
        </div>
      ) : isPending || providers === undefined ? (
        <div className="flex w-full flex-col gap-2.5" aria-hidden="true">
          <div className="skeleton min-h-12 w-full rounded-control" />
        </div>
      ) : (
        <p className="m-0 text-[14px] leading-[1.6] text-text-2">
          Sign-in is not configured on this server yet — ask the operator to
          enable a sign-in provider.
        </p>
      )}
    </div>
  );
}

/**
 * Gate shown wherever an authenticated view is reached without a session
 * (signed out, expired cookie). Showcase mode renders the demo persona
 * picker with the caller's copy; live mode renders the real provider
 * sign-in panel plus the product context from OAuthButtons.
 */
export function SignInGate({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  const { data: session } = useSession();
  const showcase = session?.mode === "showcase";
  return (
    <div className="mx-auto my-12 flex max-w-[660px] flex-col items-center gap-2.5 text-center">
      <h1 className="text-[clamp(22px,3.4vw,30px)] font-[750] tracking-[-0.01em]">
        {title}
      </h1>
      <p className="max-w-[54ch] leading-[1.6] text-text-2">
        {children ?? "Sign in with your provider account to continue."}
      </p>
      {showcase ? <PersonaPicker /> : <OAuthButtons />}
    </div>
  );
}
