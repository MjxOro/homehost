import type { ReactNode } from "react";
import { LINK_PRIMARY } from "../primitives";
import "./landing.css";

/** Primary sign-in anchor with glow, sheen and press feedback (see landing.css). */
export function PrimaryCta({
  href,
  children,
}: {
  href: string;
  children: ReactNode;
}) {
  return (
    <a
      className={`${LINK_PRIMARY} lc-cta min-h-12 w-full text-[15px]`}
      href={href}
    >
      <span className="lc-sheen" aria-hidden="true" />
      {children}
    </a>
  );
}
