import { useEffect, useRef } from "react";

let spinnerObserver: IntersectionObserver | undefined;

/** One observer pauses all decorative spinners while they are offscreen. */
export function useVisibleSpinner() {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (typeof IntersectionObserver === "undefined") {
      element.dataset.motionVisible = "";
      return;
    }
    spinnerObserver ??= new IntersectionObserver((entries) => {
      for (const entry of entries) {
        entry.target.toggleAttribute(
          "data-motion-visible",
          entry.isIntersecting,
        );
      }
    });
    spinnerObserver.observe(element);
    return () => spinnerObserver?.unobserve(element);
  }, []);
  return ref;
}
