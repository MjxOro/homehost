import { useCallback, useRef } from "react";

/**
 * Motion helpers shared by every page. CSS owns the animation (`.reveal` in
 * styles.css); this module only decides when an element is shown.
 *
 * One IntersectionObserver serves the whole app: each element is revealed
 * once, then unobserved, so scrolling costs nothing after first paint.
 */

let observer: IntersectionObserver | null = null;

function sharedObserver(): IntersectionObserver | null {
  if (typeof IntersectionObserver === "undefined") return null;
  observer ??= new IntersectionObserver(
    (entries, io) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.setAttribute("data-shown", "");
        io.unobserve(entry.target);
      }
    },
    { rootMargin: "0px 0px -8% 0px", threshold: 0.12 },
  );
  return observer;
}

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * Ref callback for an element carrying the `reveal` class. It fades up the
 * first time it enters the viewport; with reduced motion (or no observer) it
 * is shown immediately. Unmounting before the reveal stops observing it.
 */
export function useReveal<T extends Element>(): (node: T | null) => void {
  const current = useRef<T | null>(null);
  return useCallback((node: T | null) => {
    if (current.current && current.current !== node) {
      observer?.unobserve(current.current);
    }
    current.current = node;
    if (!node || node.hasAttribute("data-shown")) return;
    const io = prefersReducedMotion() ? null : sharedObserver();
    if (io) io.observe(node);
    else node.setAttribute("data-shown", "");
  }, []);
}
