import { CheckIcon } from "../icons";
import "./landing.css";
import { usePauseOffscreen } from "./usePauseOffscreen";

const STEPS = [
  { n: 1, title: "Request", sub: "Pick a plan and send it" },
  { n: 2, title: "Approved", sub: "A lab operator signs off" },
  { n: 3, title: "Provisioned", sub: "A real box on the homelab" },
] as const;

const PILL = "col-start-1 row-start-1 text-center";

export function LifecycleDiagram({ showcase }: { showcase: boolean }) {
  const ref = usePauseOffscreen<HTMLDivElement>();
  return (
    <div ref={ref} className="lc w-full max-w-[520px]">
      <div
        aria-hidden="true"
        className="lc-hl lc-hl-on rounded-card border border-line bg-ink-1/80 p-5 shadow-pop backdrop-blur-sm sm:p-6"
      >
        <div className="mb-4 flex items-center justify-between gap-3 font-mono text-[12px]">
          <span className="text-text-2">
            request <span className="ml-1 text-text-3">#a1f3</span>
          </span>
          <span className="inline-grid rounded-full border border-line-strong px-2.5 py-0.5 text-[11.5px]">
            <span className={`lc-anim lc-st1 ${PILL} text-pending opacity-0`}>
              pending
            </span>
            <span className={`lc-anim lc-st2 ${PILL} text-accent opacity-0`}>
              approved
            </span>
            <span className={`lc-anim lc-st3 ${PILL} text-ok`}>running</span>
          </span>
        </div>
        <div className="relative h-48">
          <div className="absolute left-[13px] top-8 h-32 w-0.5 bg-line" />
          <div className="lc-anim lc-fill absolute left-[13px] top-8 h-32 w-0.5 bg-accent" />
          <div className="lc-anim lc-pulse absolute left-[10px] top-7 size-2 rounded-full bg-accent-strong shadow-[0_0_10px_2px_rgba(79,224,200,0.6)]" />
          {STEPS.map((step) => (
            <div
              key={step.n}
              className={`lc-anim lc-row${step.n} flex h-16 items-center gap-4`}
            >
              <span className="relative inline-flex size-7 shrink-0 items-center justify-center rounded-full border border-line-strong bg-ink-2 font-mono text-[12px] text-text-3">
                {step.n}
                <span
                  className={`lc-anim lc-dot${step.n} absolute -inset-px inline-flex items-center justify-center rounded-full border border-accent bg-accent-dim text-accent`}
                >
                  {step.n}
                </span>
              </span>
              <span className="min-w-0">
                <span className="block text-[14px] font-[650] text-text-1">
                  {step.title}
                </span>
                <span className="block text-[12.5px] text-text-3">
                  {step.sub}
                </span>
              </span>
            </div>
          ))}
        </div>
        <div className="lc-anim lc-term mt-4 rounded-control border border-line-strong bg-ink-0 px-4 py-3 font-mono text-[13px] leading-5">
          <div className="flex items-center gap-2">
            <span className="text-accent">$</span>
            <span className="relative inline-block h-5 w-[27ch] whitespace-pre text-text-1">
              <span className="lc-anim lc-cmd">
                ssh root@mybox.homehost.dev
              </span>
              <span className="lc-anim lc-cover absolute inset-0 bg-ink-0" />
              <span className="lc-anim lc-cursor absolute left-0 top-0.5 h-4 w-[0.6ch]">
                <span className="lc-blink block size-full bg-accent" />
              </span>
            </span>
          </div>
          <div className="lc-anim lc-out">
            <div className="flex items-center gap-1.5 text-accent">
              <CheckIcon className="size-3.5" /> connected over IPv6
            </div>
            <div className="text-text-3">2001:db8:a1::7c</div>
          </div>
        </div>
      </div>
      {showcase ? (
        <p className="m-0 mt-3 text-[12.5px] leading-[1.5] text-text-3">
          Illustration of the live flow. This demo never creates a server.
        </p>
      ) : null}
    </div>
  );
}
