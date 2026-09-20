import { Link, useParams } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { isApiError } from "../lib/api";
import { useDashboard, useDesktopSession, useSession } from "../lib/query";
import { SignInGate } from "../components/SignInGate";
import { ExpandIcon } from "../components/icons";
import {
  BUTTON_OUTLINE_SM,
  CARD,
  CARD_HEAD,
  CARD_SUB,
  CARD_TITLE,
  ErrorState,
  FORM_ERROR,
  LINK_GHOST,
  LiveRegion,
  PageLoading,
} from "../components/primitives";

/**
 * Panel-hosted desktop canvas: no password form at all. The panel session
 * cookie gates `/api/requests/:id/desktop`, which returns a same-origin
 * proxied KasmVNC URL; the API injects Basic auth toward the guest from
 * `desktop_password` (never leaves the server) and the URL hash carries
 * Kasm's `password` (RFB autoconnect, no login form) plus `resize=scale`
 * so Kasm's Local Scaling fits the guest to the frame — no Kasm
 * scrollbars at any frame size. Refresh re-fetches the session URL —
 * nothing to retype, nothing stored in the browser. The root SSH one-time
 * password flow is untouched. Hooks stay unconditional: dashboard +
 * desktop session enable only once the session user id is known.
 *
 * Chrome-Remote-Desktop-style navigation on one live canvas:
 * - Preview (default): the desktop is visible but an overlay keeps wheel
 *   and keys on this page, so scrolling the page never leaks into the
 *   guest. Click the frame (or Control) to take control; Esc releases.
 * - Focused: input goes straight to the guest, like a local window.
 * - Zoom magnifies up to 3x; whenever the guest overflows the frame the
 *   view follows the cursor — the closer to an edge, the faster it pans,
 *   in both preview and focused modes. Zero scrollbars: the wrapper is
 *   overflow-hidden and the iframe moves with transform, never scrolls.
 * - A Keyboard popup sends Esc/Tab/arrows plus one-shot Ctrl/Alt/Shift/Super
 *   into the guest for touch devices with no physical keyboard.
 */

const MIN_ZOOM = 1;
const MAX_ZOOM = 3;
const ZOOM_STEP = 0.25;
const PAN_STEP = 60;
// Edge-pan feel: the outer ~22% of the frame (min 100px) is the pan zone.
// Speed eases quadratically from a gentle ~60px/s creep at the zone
// boundary to a capped ~240px/s press at the frame edge on desktop widths;
// narrow frames scale toward half speed so phones traverse, not twitch.
const EDGE_FRACTION = 0.22;
const EDGE_MIN_MARGIN = 100;
const EDGE_BASE_SPEED = 60;
const EDGE_MAX_SPEED = 240;
// Touch: a tap is a short press with almost no travel; anything beyond is a drag.
const TAP_SLOP = 10;
const TAP_MAX_MS = 400;
const FULLSCREEN_BTN = `${BUTTON_OUTLINE_SM} focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent`;
const TOOL_BTN = `${BUTTON_OUTLINE_SM} min-w-11 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent`;
const TOOL_BTN_ON = `${TOOL_BTN} border-accent-line bg-accent-dim text-accent`;
// On-screen keyboard: modifiers arm once and ride on the next key press
// (Super, not Win — the guests are Linux). Arrows carry labels for AT.
type KbModId = "ctrl" | "alt" | "shift" | "meta";
const KB_MODS: { id: KbModId; label: string }[] = [
  { id: "ctrl", label: "Ctrl" },
  { id: "alt", label: "Alt" },
  { id: "shift", label: "Shift" },
  { id: "meta", label: "Super" },
];
const KB_KEYS: { label: string; key: string; code: string; aria: string }[] = [
  { label: "Esc", key: "Escape", code: "Escape", aria: "Escape" },
  { label: "Tab", key: "Tab", code: "Tab", aria: "Tab" },
  { label: "Enter", key: "Enter", code: "Enter", aria: "Enter" },
  { label: "Bksp", key: "Backspace", code: "Backspace", aria: "Backspace" },
  { label: "Del", key: "Delete", code: "Delete", aria: "Delete" },
  { label: "←", key: "ArrowLeft", code: "ArrowLeft", aria: "Arrow left" },
  { label: "↑", key: "ArrowUp", code: "ArrowUp", aria: "Arrow up" },
  { label: "↓", key: "ArrowDown", code: "ArrowDown", aria: "Arrow down" },
  { label: "→", key: "ArrowRight", code: "ArrowRight", aria: "Arrow right" },
];

function clampPan(
  x: number,
  y: number,
  zoom: number,
  w: number,
  h: number,
): { x: number; y: number } {
  if (zoom <= MIN_ZOOM || w <= 0 || h <= 0) return { x: 0, y: 0 };
  // Stage transform is translate-then-scale from the top-left origin, so
  // offsets are screen px: [frame - zoomed frame, 0] on each axis.
  const minX = (1 - zoom) * w;
  const minY = (1 - zoom) * h;
  return {
    x: Math.min(0, Math.max(minX, x)),
    y: Math.min(0, Math.max(minY, y)),
  };
}

export function DesktopLoginPage() {
  return <DesktopCanvas />;
}

function DesktopCanvas() {
  const { data: session, isPending: sessionPending } = useSession();
  const params = useParams({ strict: false }) as { id?: string };
  const id = params.id ?? "";
  const userId = session?.user?.id;
  const dashboard = useDashboard(userId);
  const desktop = useDesktopSession(session?.user ? id : undefined);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  // Preview (false): overlay eats pointer/wheel so the page keeps them.
  // Focused (true): the guest gets input directly, like a local window.
  const [focused, setFocused] = useState(false);
  const [announce, setAnnounce] = useState<string | null>(null);
  const [fullError, setFullError] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const controlBtnRef = useRef<HTMLButtonElement>(null);
  const fullBtnRef = useRef<HTMLButtonElement>(null);
  // Cursor in wrap-relative screen px, smoothed each frame toward the raw
  // pointer (preview overlay, or the guest document listener when focused)
  // so edge traverse eases in/out instead of jumping. The rAF loop below
  // turns smoothed proximity into pan velocity.
  const cursorRef = useRef<{ x: number; y: number } | null>(null);
  const smoothRef = useRef<{ x: number; y: number } | null>(null);
  // Preview touch drag (one live pointer) pans directly, reusing clamp; a
  // second pointer switches to pinch-zoom around the pinch midpoint.
  const touchRef = useRef<{
    id: number;
    x: number;
    y: number;
    at: number;
    moved: boolean;
  } | null>(null);
  const pinchRef = useRef<{ d: number; mid: { x: number; y: number } } | null>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const suppressClickRef = useRef(false);
  const pDragRef = useRef(0);
  const viewRef = useRef({ zoom, pan });
  viewRef.current = { zoom, pan };
  const [kbOpen, setKbOpen] = useState(false);
  const [armed, setArmed] = useState<Record<KbModId, boolean>>({
    ctrl: false,
    alt: false,
    shift: false,
    meta: false,
  });
  // True while dispatching synthetic keys — the guest Esc interceptor skips.
  const sendingKeyRef = useRef(false);
  useEffect(() => {
    if (!announce) return;
    const timer = window.setTimeout(() => setAnnounce(null), 4000);
    return () => window.clearTimeout(timer);
  }, [announce]);

  const frameSize = () => ({
    w: wrapRef.current?.clientWidth ?? 0,
    h: wrapRef.current?.clientHeight ?? 0,
  });

  // Pinch-zoom keeps the screen point under the pinch midpoint fixed:
  // solve the translate-then-scale mapping for the new pan. `touchAt`
  // tolerates real TouchLists plus plain-array synthetics (tests).
  const touchAt = (
    list: { item?: (i: number) => unknown; length: number; [i: number]: unknown } | null | undefined,
    i: number,
  ) => {
    if (!list) return null;
    const item = (list as { item?: (i: number) => unknown }).item;
    if (typeof item === "function") return item.call(list, i) as { identifier: number; clientX: number; clientY: number } | null;
    return (list[i] as { identifier: number; clientX: number; clientY: number } | undefined) ?? null;
  };

  const touchList = (raw: unknown, id: number) => {
    if (!raw || typeof raw !== "object") return null;
    const rec = raw as { length?: unknown; item?: (i: number) => unknown };
    if (typeof rec.length !== "number") return null;
    for (let i = 0; i < rec.length; i += 1) {
      const t = touchAt(rec as { item?: (i: number) => unknown; length: number; [i: number]: unknown }, i);
      if (t && t.identifier === id) return t;
    }
    return touchAt(rec as { item?: (i: number) => unknown; length: number; [i: number]: unknown }, 0);
  };

  const zoomAt = (nextRaw: number, at: { x: number; y: number }) => {
    const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, nextRaw));
    const { zoom: z, pan: p } = viewRef.current;
    const { w, h } = frameSize();
    if (next <= MIN_ZOOM) {
      setPan({ x: 0, y: 0 });
      setZoom(MIN_ZOOM);
      setFullError(null);
      setAnnounce("Fit. Whole desktop visible.");
      return;
    }
    const z0 = Math.max(z, 0.001);
    setZoom(next);
    setFullError(null);
    setPan(clampPan(at.x - next * ((at.x - p.x) / z0), at.y - next * ((at.y - p.y) / z0), next, w, h));
    setAnnounce(`Zoom ${Math.round(next * 100)} percent.`);
  };

  useEffect(() => {
    const onChange = () => {
      const active = document.fullscreenElement != null;
      setIsFullscreen(active);
      setAnnounce(
        active ? "Fullscreen on. Press Escape to exit." : "Fullscreen off.",
      );
      if (!active) fullBtnRef.current?.focus();
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const exitFocus = () => {
    setFocused(false);
    cursorRef.current = null;
    smoothRef.current = null;
    setAnnounce("Preview. Wheel and keys stay on this page.");
    controlBtnRef.current?.focus();
  };

  // Preview: document mousemove is the only pointer signal that reaches
  // React past the bare iframe — convert to wrap-relative and let the
  // edge loop smooth and pan from it. Focused uses the guest listener.
  useEffect(() => {
    if (focused) return;
    const onMove = (e: MouseEvent) => {
      const frame = wrapRef.current;
      if (!frame) return;
      const r = frame.getBoundingClientRect();
      cursorRef.current = { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const onLeave = () => {
      cursorRef.current = null;
      smoothRef.current = null;
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseleave", onLeave);
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseleave", onLeave);
    };
  }, [focused]);

  // In preview the bare iframe sits under the pointer, so trap the wheel
  // at the wrapper: page zoom/scroll keeps working, the guest never sees
  // the event. Focused mode intentionally skips this — the guest owns it.
  useEffect(() => {
    if (focused) return;
    const wrap = wrapRef.current;
    if (!wrap) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) return;
      e.stopPropagation();
    };
    wrap.addEventListener("wheel", onWheel, { passive: true });
    return () => wrap.removeEventListener("wheel", onWheel);
  }, [focused]);

  // Preview touch: one finger drags the zoomed stage (same clamp as keys),
  // two fingers pinch-zoom around the midpoint, a short tap takes control.
  // Native non-passive listeners — React synthetic touch is unreliable
  // through the iframe-adjacent overlay and cannot preventDefault scroll.
  useEffect(() => {
    if (focused) return;
    const el = overlayRef.current ?? wrapRef.current;
    if (!el) return;
    const opts = { passive: false } as const;
    // Mouse/stylus/precision-trackpad drag on a touchscreen laptop fires
    // PointerEvents with no TouchEvent — pan the stage from those too.
    let pDrag: { x: number; y: number; b: number; dist: number } | null = null;
    const pDown = (e: PointerEvent) => {
      if (e.pointerType === "touch") return;
      if ((e.button ?? 0) !== 0) return;
      pDrag = { x: e.clientX, y: e.clientY, b: e.button ?? 0, dist: 0 };
      pDragRef.current = 0;
      suppressClickRef.current = false;
    };
    const pMove = (e: PointerEvent) => {
      if (e.pointerType === "touch") return;
      const wrap = wrapRef.current;
      if (!wrap) return;
      if (!pDrag) {
        if (e.buttons === 0) {
          cursorRef.current = {
            x: e.clientX - wrap.getBoundingClientRect().left,
            y: e.clientY - wrap.getBoundingClientRect().top,
          };
          return;
        }
        pDrag = { x: e.clientX, y: e.clientY, b: e.button ?? 0, dist: 0 };
        pDragRef.current = 0;
        suppressClickRef.current = false;
      }
      const dx = e.clientX - pDrag.x;
      const dy = e.clientY - pDrag.y;
      pDrag.dist += Math.abs(dx) + Math.abs(dy);
      pDragRef.current = pDrag.dist;
      // A real drag is not a click: arm suppression so the trailing
      // click event cannot steal focus into the guest mid-traverse.
      if (pDrag.dist > TAP_SLOP) suppressClickRef.current = true;
      cursorRef.current = {
        x: e.clientX - wrap.getBoundingClientRect().left,
        y: e.clientY - wrap.getBoundingClientRect().top,
      };
      if (viewRef.current.zoom > MIN_ZOOM && (Math.abs(dx) > 0 || Math.abs(dy) > 0)) {
        const { zoom: z, pan: p } = viewRef.current;
        setPan(clampPan(p.x + dx, p.y + dy, z, wrap.clientWidth, wrap.clientHeight));
      }
    };
    const pUp = () => {
      pDrag = null;
    };
    const start = (e: TouchEvent) => {
      e.preventDefault();
      const t = touchAt(e.changedTouches, 0);
      if (!t) return;
      touchRef.current = {
        id: t.identifier,
        x: t.clientX,
        y: t.clientY,
        at: performance.now(),
        moved: false,
      };
      pinchRef.current = null;
    };
    const move = (e: TouchEvent) => {
      e.preventDefault();
      const wrap = wrapRef.current;
      const cur = touchRef.current;
      if (!wrap || !cur) return;
      const r = wrap.getBoundingClientRect();
      if (e.touches.length >= 2) {
        const a = touchAt(e.touches, 0);
        const b = touchAt(e.touches, 1);
        if (!a || !b) return;
        const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
        const mid = {
          x: (a.clientX + b.clientX) / 2 - r.left,
          y: (a.clientY + b.clientY) / 2 - r.top,
        };
        const prev = pinchRef.current;
        pinchRef.current = { d, mid };
        cur.moved = true;
        if (prev && prev.d > 0 && d > 0) {
          zoomAt((viewRef.current.zoom * d) / prev.d, mid);
        }
        cursorRef.current = { ...mid };
        return;
      }
      const t = touchList(e.changedTouches, cur.id);
      if (!t) return;
      const dx = t.clientX - cur.x;
      const dy = t.clientY - cur.y;
      if (Math.abs(dx) > TAP_SLOP || Math.abs(dy) > TAP_SLOP) cur.moved = true;
      cur.x = t.clientX;
      cur.y = t.clientY;
      cursorRef.current = { x: t.clientX - r.left, y: t.clientY - r.top };
      if (cur.moved && viewRef.current.zoom > MIN_ZOOM) {
        const { zoom: z, pan: p } = viewRef.current;
        setPan(clampPan(p.x + dx, p.y + dy, z, wrap.clientWidth, wrap.clientHeight));
      }
    };
    const end = (e: TouchEvent) => {
      const cur = touchRef.current;
      touchRef.current = null;
      pinchRef.current = null;
      if (!cur) return;
      const t = touchList(e.changedTouches, cur.id);
      const dt = performance.now() - cur.at;
      const dx = t ? t.clientX - cur.x : 0;
      const dy = t ? t.clientY - cur.y : 0;
      cursorRef.current = null;
      if (!cur.moved && dt <= TAP_MAX_MS && Math.abs(dx) <= TAP_SLOP && Math.abs(dy) <= TAP_SLOP) {
        // Suppress the mouse-compat click a tap would otherwise fire —
        // preventDefault on touchstart already tries, this is the backstop.
        suppressClickRef.current = true;
        window.setTimeout(() => {
          suppressClickRef.current = false;
        }, 500);
        enterFocus();
      }
    };
    const cancel = () => {
      touchRef.current = null;
      pinchRef.current = null;
    };
    el.addEventListener("touchstart", start, opts);
    el.addEventListener("touchmove", move, opts);
    el.addEventListener("touchend", end);
    el.addEventListener("touchcancel", cancel);
    document.addEventListener("pointerdown", pDown);
    document.addEventListener("pointermove", pMove);
    document.addEventListener("pointerup", pUp);
    document.addEventListener("pointercancel", pUp);
    return () => {
      el.removeEventListener("touchstart", start);
      el.removeEventListener("touchmove", move);
      el.removeEventListener("touchend", end);
      el.removeEventListener("touchcancel", cancel);
      document.removeEventListener("pointerdown", pDown);
      document.removeEventListener("pointermove", pMove);
      document.removeEventListener("pointerup", pUp);
      document.removeEventListener("pointercancel", pUp);
    };
  }, [focused]);
  useEffect(() => {
    if (focused) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        exitFocus();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [focused]);

  // While focused the pointer lives inside the guest document, whose events
  // never bubble to the parent — so track it there (same-origin proxy, and
  // Esc, which the guest would otherwise swallow). Re-attaches on guest
  // reloads while focused.
  useEffect(() => {
    if (!focused) {
      cursorRef.current = null;
      return;
    }
    const iframe = frameRef.current;
    if (!iframe) return;
    const onGuestMove = (e: MouseEvent) => {
      const { zoom: z, pan: p } = viewRef.current;
      // Guest viewport px -> wrap-relative screen px. The stage is
      // translate-then-scale, so visual = offset + zoom * viewport.
      cursorRef.current = { x: p.x + z * e.clientX, y: p.y + z * e.clientY };
    };
    const onGuestLeave = () => {
      cursorRef.current = null;
    };
    const onGuestTouch = (e: TouchEvent) => {
      const t = e.changedTouches.item(0);
      if (!t) return;
      const { zoom: z, pan: p } = viewRef.current;
      cursorRef.current = { x: p.x + z * t.clientX, y: p.y + z * t.clientY };
    };
    const onGuestKey = (e: KeyboardEvent) => {
      // Synthetic keys from the on-screen keyboard pass through — Esc from
      // the popup belongs to the guest, physical Esc still releases.
      if (sendingKeyRef.current) return;
      if (e.key === "Escape") {
        e.preventDefault();
        exitFocus();
      }
    };
    let doc: Document | null = null;
    const opts = { capture: true } as const;
    const attach = () => {
      doc = iframe.contentDocument;
      doc?.addEventListener("mousemove", onGuestMove, opts);
      doc?.addEventListener("touchstart", onGuestTouch, opts);
      doc?.addEventListener("touchmove", onGuestTouch, opts);
      doc?.addEventListener("mouseleave", onGuestLeave, opts);
      doc?.addEventListener("keydown", onGuestKey, opts);
    };
    const detach = () => {
      doc?.removeEventListener("mousemove", onGuestMove, opts);
      doc?.removeEventListener("touchstart", onGuestTouch, opts);
      doc?.removeEventListener("touchmove", onGuestTouch, opts);
      doc?.removeEventListener("mouseleave", onGuestLeave, opts);
      doc?.removeEventListener("keydown", onGuestKey, opts);
    };
    const onLoad = () => {
      detach();
      attach();
    };
    attach();
    iframe.addEventListener("load", onLoad);
    return () => {
      detach();
      iframe.removeEventListener("load", onLoad);
    };
  }, [focused]);

  // Edge-follow traverse: whenever the guest overflows the frame, the view
  // glides with cursor depth into the edge zone — eased target velocity
  // per axis, critically-damped smoothing each frame, in preview and
  // focused modes. No scrollbars, no drag mode.
  useEffect(() => {
    if (zoom <= MIN_ZOOM) return;
    let raf = 0;
    let last = performance.now();
    let vx = 0;
    let vy = 0;
    const axisTarget = (pos: number, size: number) => {
      if (size <= 0) return 0;
      const margin = Math.max(EDGE_MIN_MARGIN, size * EDGE_FRACTION);
      if (pos < 0 || pos > size) return 0;
      const ease = (depth: number) =>
        EDGE_BASE_SPEED + (EDGE_MAX_SPEED - EDGE_BASE_SPEED) * depth * depth;
      if (pos < margin) return ease(1 - pos / margin);
      if (pos > size - margin) return -ease(1 - (size - pos) / margin);
      return 0;
    };
    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const raw = cursorRef.current;
      if (raw) {
        if (smoothRef.current) {
          const k = 1 - Math.exp(-dt / 0.09);
          smoothRef.current = {
            x: smoothRef.current.x + (raw.x - smoothRef.current.x) * k,
            y: smoothRef.current.y + (raw.y - smoothRef.current.y) * k,
          };
        } else {
          smoothRef.current = { x: raw.x, y: raw.y };
        }
      } else {
        smoothRef.current = null;
        vx = 0;
        vy = 0;
      }
      const c = smoothRef.current;
      const live = wrapRef.current;
      if (c && live) {
        const w = live.clientWidth;
        const h = live.clientHeight;
        // Narrow frames cross the range in fewer px — scale top speed toward
        // half on phones so traverse feels the same, not twitchy.
        const speedScale = Math.min(1, Math.max(0.5, w / 1024));
        const tx = axisTarget(c.x, w) * speedScale;
        const ty = axisTarget(c.y, h) * speedScale;
        const kv = 1 - Math.exp(-dt / 0.12);
        vx += (tx - vx) * kv;
        vy += (ty - vy) * kv;
        if (Math.abs(vx) > 0.5 || Math.abs(vy) > 0.5) {
          const z = viewRef.current.zoom;
          setPan((p) => clampPan(p.x + vx * dt, p.y + vy * dt, z, w, h));
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [zoom]);
  useEffect(() => {
    const frame = wrapRef.current;
    if (!frame) return;
    setPan((p) =>
      clampPan(p.x, p.y, viewRef.current.zoom, frame.clientWidth, frame.clientHeight),
    );
  }, [isFullscreen]);

  if (sessionPending) {
    return <PageLoading label="Loading session…" />;
  }
  if (!session?.user) {
    return (
      <SignInGate title="Sign in to open this desktop">
        Pick a demo persona to continue to the desktop.
      </SignInGate>
    );
  }
  if (dashboard.isPending) {
    return <PageLoading label="Loading desktop…" />;
  }
  if (dashboard.isError) {
    if (isApiError(dashboard.error) && dashboard.error.status === 401) {
      return (
        <SignInGate title="Your session has ended">
          Pick a demo persona to sign back in.
        </SignInGate>
      );
    }
    return (
      <ErrorState
        error={dashboard.error}
        onRetry={() => void dashboard.refetch()}
      />
    );
  }

  const request = dashboard.data.requests.find((r) => r.id === id);
  if (!request) {
    return (
      <ErrorState
        title="Desktop not found"
        error={new Error("No request with this id on your dashboard.")}
        onRetry={() => void dashboard.refetch()}
      />
    );
  }
  if (request.status !== "running") {
    return (
      <section className={CARD} aria-labelledby="desktop-login-heading">
        <div className={CARD_HEAD}>
          <div>
            <h1 id="desktop-login-heading" className={CARD_TITLE}>
              {request.name} — desktop offline
            </h1>
            <p className={CARD_SUB}>
              The instance is {request.status}. Start it from the dashboard,
              then return here.
            </p>
          </div>
        </div>
      </section>
    );
  }

  if (desktop.isPending) {
    return <PageLoading label="Opening desktop…" />;
  }
  if (desktop.isError) {
    if (isApiError(desktop.error) && desktop.error.status === 401) {
      return (
        <SignInGate title="Your session has ended">
          Pick a demo persona to sign back in.
        </SignInGate>
      );
    }
    if (isApiError(desktop.error) && desktop.error.status === 404) {
      return (
        <ErrorState
          title="Desktop has no saved session"
          error={
            new Error(
              "This desktop predates saved sessions — reprovision it.",
            )
          }
          onRetry={() => void desktop.refetch()}
        />
      );
    }
    return (
      <ErrorState
        error={desktop.error}
        onRetry={() => void desktop.refetch()}
      />
    );
  }

  const zoomTo = (nextRaw: number) => {
    const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, nextRaw));
    setZoom(next);
    setFullError(null);
    if (next <= MIN_ZOOM) {
      setPan({ x: 0, y: 0 });
      cursorRef.current = null;
      setAnnounce("Fit. Whole desktop visible.");
    } else {
      const { w, h } = frameSize();
      setPan((p) => clampPan(p.x, p.y, next, w, h));
      setAnnounce(
        `Zoom ${Math.round(next * 100)} percent. The view follows your mouse to the edges.`,
      );
    }
  };

  const nudge = (dx: number, dy: number) => {
    if (zoom <= MIN_ZOOM) return;
    const { w, h } = frameSize();
    setPan((p) => clampPan(p.x + dx, p.y + dy, zoom, w, h));
  };

  const enterFocus = () => {
    setFocused(true);
    setAnnounce(
      "Controlling the desktop. Wheel and keys go to the guest — press Escape to release.",
    );
    // Let state commit, then move keyboard focus into the guest.
    requestAnimationFrame(() => {
      frameRef.current?.focus();
      frameRef.current?.contentWindow?.focus();
    });
  };

  // On-screen keyboard: synthetic key events straight into the guest
  // document (same-origin proxy, so noVNC's own handlers receive them).
  // Modifiers arm once and ride on the next key — nothing latches, so no
  // stuck Ctrl when the popup closes. Sending a key takes control, like tap.
  const toggleMod = (id: KbModId) => {
    setArmed((m) => {
      const next = { ctrl: m.ctrl, alt: m.alt, shift: m.shift, meta: m.meta };
      next[id] = !m[id];
      return next;
    });
  };
  const guestKeyTarget = (doc: Document): Element =>
    doc.activeElement ?? doc.body ?? doc.documentElement;
  const sendGuestKey = (key: string, code: string) => {
    const doc = frameRef.current?.contentDocument;
    if (!doc) {
      setAnnounce("Desktop is still loading — try the keyboard again in a moment.");
      return;
    }
    const init: KeyboardEventInit = {
      key,
      code,
      ctrlKey: armed.ctrl,
      altKey: armed.alt,
      shiftKey: armed.shift,
      metaKey: armed.meta,
      bubbles: true,
      cancelable: true,
      composed: true,
    };
    sendingKeyRef.current = true;
    try {
      const target = guestKeyTarget(doc);
      target.dispatchEvent(new KeyboardEvent("keydown", init));
      target.dispatchEvent(new KeyboardEvent("keyup", init));
    } finally {
      sendingKeyRef.current = false;
    }
    if (armed.ctrl || armed.alt || armed.shift || armed.meta) {
      setArmed({ ctrl: false, alt: false, shift: false, meta: false });
    }
    if (!focused) enterFocus();
  };
  const sendCtrlAltDel = () => {
    const doc = frameRef.current?.contentDocument;
    if (!doc) {
      setAnnounce("Desktop is still loading — try the keyboard again in a moment.");
      return;
    }
    const base = { bubbles: true, cancelable: true, composed: true } as const;
    const down: KeyboardEventInit[] = [
      { ...base, key: "Control", code: "ControlLeft", ctrlKey: true },
      { ...base, key: "Alt", code: "AltLeft", ctrlKey: true, altKey: true },
      { ...base, key: "Delete", code: "Delete", ctrlKey: true, altKey: true },
    ];
    const up: KeyboardEventInit[] = [
      { ...base, key: "Delete", code: "Delete", ctrlKey: true, altKey: true },
      { ...base, key: "Alt", code: "AltLeft", ctrlKey: true },
      { ...base, key: "Control", code: "ControlLeft" },
    ];
    sendingKeyRef.current = true;
    try {
      const target = guestKeyTarget(doc);
      for (const init of down) target.dispatchEvent(new KeyboardEvent("keydown", init));
      for (const init of up) target.dispatchEvent(new KeyboardEvent("keyup", init));
    } finally {
      sendingKeyRef.current = false;
    }
    setAnnounce("Sent Ctrl Alt Delete to the desktop.");
    if (!focused) enterFocus();
  };

  const toggleFullscreen = async () => {
    setFullError(null);
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else if (wrapRef.current) {
        await wrapRef.current.requestFullscreen();
      }
    } catch {
      setFullError(
        "Fullscreen was blocked by the browser. Zoom and edge-pan work without it.",
      );
    }
  };

  const onKeys = (e: React.KeyboardEvent) => {
    if (e.key === "Escape" && focused) {
      e.preventDefault();
      exitFocus();
      return;
    }
    if (e.key === "Enter" && !focused && e.target === e.currentTarget) {
      e.preventDefault();
      enterFocus();
      return;
    }
    if (zoom <= MIN_ZOOM && e.key !== "+" && e.key !== "=" && e.key !== "0") return;
    switch (e.key) {
      case "ArrowLeft":
        e.preventDefault();
        nudge(PAN_STEP, 0);
        break;
      case "ArrowRight":
        e.preventDefault();
        nudge(-PAN_STEP, 0);
        break;
      case "ArrowUp":
        e.preventDefault();
        nudge(0, PAN_STEP);
        break;
      case "ArrowDown":
        e.preventDefault();
        nudge(0, -PAN_STEP);
        break;
      case "+":
      case "=":
        e.preventDefault();
        zoomTo(zoom + ZOOM_STEP);
        break;
      case "-":
        e.preventDefault();
        zoomTo(zoom - ZOOM_STEP);
        break;
      case "0":
        e.preventDefault();
        zoomTo(MIN_ZOOM);
        break;
    }
  };

  const fullscreenSupported =
    typeof document !== "undefined" && document.fullscreenEnabled;
  const frameTitle = `${request.name} desktop canvas (${desktop.data.desktopUser})`;
  // Zoom stage sizes itself to the frame (inset-0) instead of h-full:
  // h-full of a scaled child measures the scaled box and letterboxes the
  // Fit view. inset-0 keeps stage == frame, so Kasm's resize=scale fills
  // edge to edge at zoom 1 and transform offsets pan pixel-true at zoom.
  // The frame is locked to the guest's 16:9 geometry (1280x720) so Kasm
  // never letterboxes: a ratio-mismatched frame bakes black bars into the
  // canvas, and zooming parks one at each pan end. Sizing is width-driven
  // (aspect-video + max-width only) — a max-height cap would fight the
  // aspect ratio and reintroduce the bars. No decorative border: at
  // full-bleed zoom the frame edge is the desktop edge.
  const frameClass = isFullscreen
    ? "relative h-[100dvh] w-full overflow-hidden rounded-none border-0 bg-black"
    : "relative mx-auto aspect-video w-full touch-pan-y overflow-hidden rounded-control border-0 bg-black";
  // Width cap mirrors the old height cap (min(70svh,480px) * 16/9) so wide
  // screens hold 16:9 without growing past ~480px tall; narrow phones get a
  // shorter but exact frame. Inline style, never a Tailwind arbitrary value.
  const frameStyle = isFullscreen
    ? undefined
    : { maxWidth: "min(853px, calc(70svh * 16 / 9))" };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-[clamp(20px,2.5vw,24px)] font-bold tracking-[-0.01em]">
            {request.name} — desktop
          </h1>
          <p className={CARD_SUB}>
            {focused
              ? "Controlling the desktop — Release hands wheel and keys back to this page."
              : "Preview — wheel and keys stay on this page until you click in."}{" "}
            When zoomed, the view follows your mouse to the edges.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {request.desktopUser ?? request.desktopHostname ? (
            <span className={CARD_SUB}>
              {request.desktopUser ? `Signed in as ${request.desktopUser}` : null}
              {request.desktopUser && request.desktopHostname ? " · " : null}
              {request.desktopHostname ?? null}
            </span>
          ) : null}
          <Link to="/" className={LINK_GHOST}>
            Back to dashboard
          </Link>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-2">
        <div
          role="group"
          aria-label="Zoom"
          className="inline-flex items-stretch [&>*]:rounded-none [&>*]:-ml-px [&>*]:first:ml-0 [&>*]:first:rounded-l-control [&>*]:last:rounded-r-control"
        >
          <button
            type="button"
            onClick={() => zoomTo(MIN_ZOOM)}
            disabled={zoom <= MIN_ZOOM}
            className={TOOL_BTN}
          >
            Fit
          </button>
          <button
            type="button"
            aria-label="Zoom out"
            onClick={() => zoomTo(zoom - ZOOM_STEP)}
            disabled={zoom <= MIN_ZOOM}
            className={TOOL_BTN}
          >
            −
          </button>
          <span
            aria-label={`Zoom, ${Math.round(zoom * 100)} percent`}
            role="status"
            className={`${TOOL_BTN} min-w-[4.5rem] tabular-nums pointer-events-none`}
          >
            {Math.round(zoom * 100)}%
          </span>
          <button
            type="button"
            aria-label="Zoom in"
            onClick={() => zoomTo(zoom + ZOOM_STEP)}
            disabled={zoom >= MAX_ZOOM}
            className={TOOL_BTN}
          >
            +
          </button>
        </div>
        <button
          ref={controlBtnRef}
          type="button"
          aria-pressed={focused}
          onClick={() => (focused ? exitFocus() : enterFocus())}
          title={
            focused
              ? "Release the desktop — wheel and keys return to this page (Esc)"
              : "Control the desktop — wheel and keys go to the guest"
          }
          className={focused ? TOOL_BTN_ON : TOOL_BTN}
        >
          {focused ? "Release" : "Control desktop"}
        </button>
        <button
          type="button"
          aria-expanded={kbOpen}
          onClick={() => {
            setKbOpen((v) => !v);
            setAnnounce(
              kbOpen
                ? "On-screen keyboard closed."
                : "On-screen keyboard open. Modifiers arm for the next key.",
            );
          }}
          title={
            kbOpen
              ? "Hide the on-screen keyboard"
              : "Show an on-screen keyboard with Ctrl, Alt, Shift and more"
          }
          className={kbOpen ? TOOL_BTN_ON : TOOL_BTN}
        >
          Keyboard
        </button>
        <button
          ref={fullBtnRef}
          type="button"
          onClick={() => void toggleFullscreen()}
          disabled={!fullscreenSupported}
          title={
            fullscreenSupported
              ? isFullscreen
                ? "Exit fullscreen"
                : "Fill the screen with the desktop"
              : "Fullscreen is not supported in this browser"
          }
          className={FULLSCREEN_BTN}
        >
          <ExpandIcon />
          {isFullscreen ? "Exit fullscreen" : "Fullscreen"}
        </button>
      </div>
      {kbOpen ? (
        <div
          role="group"
          aria-label="On-screen keyboard"
          className="flex flex-wrap items-center gap-2 rounded-control border border-line-strong bg-ink-1 p-2.5"
        >
          {KB_MODS.map((m) => (
            <button
              key={m.id}
              type="button"
              aria-pressed={armed[m.id]}
              onClick={() => toggleMod(m.id)}
              title={`${m.label} — arms once for the next key`}
              className={armed[m.id] ? TOOL_BTN_ON : TOOL_BTN}
            >
              {m.label}
            </button>
          ))}
          {KB_KEYS.map((k) => (
            <button
              key={k.code}
              type="button"
              onClick={() => sendGuestKey(k.key, k.code)}
              title={`Send ${k.aria} to the desktop`}
              aria-label={`Send ${k.aria}`}
              className={TOOL_BTN}
            >
              {k.label}
            </button>
          ))}
          <button
            type="button"
            onClick={sendCtrlAltDel}
            title="Send Ctrl+Alt+Delete to the desktop"
            className={TOOL_BTN}
          >
            Ctrl+Alt+Del
          </button>
          <span className={CARD_SUB}>Modifiers arm once, for the next key only.</span>
        </div>
      ) : null}
      {fullError ? (
        <p className={FORM_ERROR} role="alert">
          {fullError}
        </p>
      ) : null}
      <LiveRegion message={announce} />
      <div
        ref={wrapRef}
        tabIndex={0}
        onKeyDown={onKeys}
        onMouseLeave={() => {
          if (!focused) {
            cursorRef.current = null;
            smoothRef.current = null;
          }
        }}
        aria-label="Desktop canvas. Click to control the desktop. Arrow keys move the viewpoint when zoomed."
        className={frameClass}
        style={frameStyle}
      >
        {isFullscreen ? (
          <button
            type="button"
            onClick={() => void toggleFullscreen()}
            aria-label="Exit fullscreen"
            className={`${FULLSCREEN_BTN} absolute right-3 top-3 z-10 bg-ink-2`}
          >
            <ExpandIcon />
            Exit
          </button>
        ) : null}
        <div
          className="absolute inset-0"
          style={{
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
            transformOrigin: "0 0",
          }}
        >
          <iframe
            ref={frameRef}
            title={frameTitle}
            src={desktop.data.url}
            tabIndex={-1}
            className="block h-full w-full border-0 bg-black"
            allow="clipboard-read; clipboard-write"
            allowFullScreen
          />
        </div>
        {focused ? null : (
          <div
            ref={overlayRef}
            role="button"
            tabIndex={0}
            aria-label="Control the desktop. Click to take control; hover the edges to look around while zoomed."
            title="Click to control the desktop"
            onClick={(e) => {
              if (suppressClickRef.current) return;
              if (e.detail === 0) return;
              enterFocus();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                enterFocus();
              }
            }}
            onMouseMove={(e) => {
              const r = wrapRef.current?.getBoundingClientRect();
              if (!r) return;
              cursorRef.current = { x: e.clientX - r.left, y: e.clientY - r.top };
            }}
            onMouseLeave={() => {
              cursorRef.current = null;
              smoothRef.current = null;
            }}
            className="absolute inset-0 z-[5] flex cursor-pointer touch-none items-center justify-center focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent [touch-action:none]"
          >
            <span className="pointer-events-none rounded-control border border-line-strong bg-ink-2 px-3 py-1.5 text-[14px] font-[650] text-text-1">
              Click to control
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
