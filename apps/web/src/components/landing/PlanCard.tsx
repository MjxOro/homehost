import type { CSSProperties } from "react";
import type { Plan } from "@homehost/shared";
import { formatMemory } from "../../lib/format";
import { useReveal } from "../../lib/motion";
import { LockIcon } from "../icons";
import { Chip } from "../primitives";

const SPECS = (plan: Plan): Array<[string, string]> => [
  ["CPU", String(plan.cpu)],
  ["RAM", formatMemory(plan.memoryMb)],
  ["Disk", `${plan.diskGb} GB`],
];

/**
 * One catalog card. The <li> owns the scroll reveal (opacity/transform); the
 * inner card owns hover, so the two transitions never fight over transform.
 */
export function PlanCard({ plan, index }: { plan: Plan; index: number }) {
  const ref = useReveal<HTMLLIElement>();
  return (
    <li
      ref={ref}
      className="reveal"
      style={{ "--stagger": index } as CSSProperties}
    >
      <div
        className={`flex h-full flex-col rounded-card border border-line bg-ink-1 p-4 transition-[transform,border-color,background-color] duration-(--duration-base) ease-out-quint hover:-translate-y-0.5 hover:border-accent-line hover:bg-ink-2 ${
          plan.technicalOnly ? "opacity-[0.85]" : ""
        }`}
      >
        <div className="mb-3.5 flex flex-wrap items-center justify-between gap-2 [&>*]:min-w-0">
          <h3 className="text-[15px] font-[650] tracking-[-0.005em]">
            {plan.name}
          </h3>
          {plan.technicalOnly ? (
            <Chip>
              <LockIcon className="size-3" /> technical only
            </Chip>
          ) : null}
        </div>
        <dl className="m-0 mt-auto grid grid-cols-3 gap-2 border-t border-line pt-3">
          {SPECS(plan).map(([label, value]) => (
            <div key={label}>
              <dt className="text-[11px] font-bold uppercase tracking-[0.07em] text-text-3">
                {label}
              </dt>
              <dd className="m-0 mt-0.5 text-[14.5px] font-[650] tabular-nums text-text-1">
                {value}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </li>
  );
}
