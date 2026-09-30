import { useEffect } from "react";

let locks = 0;
let restore: (() => void) | undefined;

/** Native modal inertness does not stop touch or wheel scrolling. Lock the
 * document, keeping the body's overflow visible so sticky headers retain
 * their scroll ancestor. Multiple overlays share one lock. */
export function useScrollLock(active: boolean) {
  useEffect(() => {
    if (!active) return;
    if (locks === 0) {
      const root = document.documentElement;
      const rootOverflow = root.style.overflow;
      root.style.overflow = "hidden";
      restore = () => {
        root.style.overflow = rootOverflow;
      };
    }
    locks += 1;
    return () => {
      locks -= 1;
      if (locks === 0) {
        restore?.();
        restore = undefined;
      }
    };
  }, [active]);
}
