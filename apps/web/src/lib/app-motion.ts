import { useEffect, useRef, type CSSProperties } from "react";

/** Keep the first populated batch's timing tied to ids, even when polling
 * prepends or reorders rows. Later additions fade in without a stagger. */
export function useListEntrance(items: readonly { id: string }[]) {
  const firstBatch = useRef<Map<string, number> | null>(null);
  const batch =
    firstBatch.current ?? new Map(items.map((item, i) => [item.id, i]));
  useEffect(() => {
    if (firstBatch.current === null && items.length > 0) {
      firstBatch.current = batch;
    }
  }, [items, batch]);
  return (id: string) => {
    const index = batch.get(id);
    return {
      className: index === undefined ? "animate-fade-in" : "animate-fade-up",
      style: {
        animationDelay:
          index !== undefined && index < 8 ? `${index * 30}ms` : "0ms",
      } satisfies CSSProperties,
    };
  };
}

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
