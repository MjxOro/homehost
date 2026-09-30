import type { ReactNode } from "react";
import { LINK_PRIMARY } from "../primitives";
import "./landing.css";

export function PrimaryCta({
  href,
  children,
  landing = false,
}: {
  href: string;
  children: ReactNode;
  landing?: boolean;
}) {
  return (
    <a
      className={`${LINK_PRIMARY} lc-cta min-h-12 w-full text-[15px] ${
        landing ? "px-6 sm:w-auto sm:min-w-[260px]" : ""
      }`}
      href={href}
    >
      <span className="lc-sheen" aria-hidden="true" />
      {children}
      {landing ? (
        <svg
          className="lc-arrow size-4"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M5 12h14M13 6l6 6-6 6" />
        </svg>
      ) : null}
    </a>
  );
}
