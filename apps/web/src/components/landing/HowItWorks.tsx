import type { CSSProperties } from "react";
import { useReveal } from "../../lib/motion";
import { STEPS } from "../SignInGate";

function Step({
  index,
  title,
  copy,
}: {
  index: number;
  title: string;
  copy: string;
}) {
  const ref = useReveal<HTMLLIElement>();
  return (
    <li
      ref={ref}
      className="reveal flex gap-4"
      style={{ "--stagger": index } as CSSProperties}
    >
      <span
        aria-hidden="true"
        className="inline-flex size-7 shrink-0 items-center justify-center rounded-full border border-line-strong font-mono text-[12px] text-text-2"
      >
        {index + 1}
      </span>
      <div className="min-w-0">
        <h3 className="text-[15px] font-[650] tracking-[-0.005em]">{title}</h3>
        <p className="m-0 mt-1 text-[14px] leading-[1.55] text-text-2">
          {copy}
        </p>
      </div>
    </li>
  );
}

export function HowItWorks() {
  return (
    <section aria-labelledby="how-heading">
      <h2
        id="how-heading"
        className="m-0 mb-6 font-mono text-[12px] font-semibold uppercase tracking-[0.12em] text-accent"
      >
        How it works
      </h2>
      <ol className="m-0 grid list-none grid-cols-1 gap-8 p-0 md:grid-cols-3 md:gap-10">
        {STEPS.map((step, i) => (
          <Step
            key={step.title}
            index={i}
            title={step.title}
            copy={step.copy}
          />
        ))}
      </ol>
    </section>
  );
}
