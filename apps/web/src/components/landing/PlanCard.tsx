import type { CSSProperties } from "react";
import type { Plan } from "@homehost/shared";
import { useReveal } from "../../lib/motion";
import { CursorIcon, DashboardIcon, LockIcon, ServerIcon } from "../icons";
import { Chip } from "../primitives";
import "./landing.css";

function planKind(plan: Plan) {
  if (plan.desktop) return { label: "Desktop", Icon: CursorIcon };
  if (plan.kind === "vm") return { label: "VM", Icon: DashboardIcon };
  return { label: "Container", Icon: ServerIcon };
}

function specs(plan: Plan): Array<[string, string]> {
  const gb = plan.memoryMb / 1024;
  return [
    ["vCPU", String(plan.cpu)],
    plan.memoryMb >= 1024
      ? ["GB RAM", String(+gb.toFixed(1))]
      : ["MB RAM", String(plan.memoryMb)],
    ["GB disk", String(plan.diskGb)],
  ];
}

const CARD_SHELL =
  "flex h-full flex-col rounded-card border border-line bg-ink-1 p-5";

export function PlanCard({ plan, index }: { plan: Plan; index: number }) {
  const ref = useReveal<HTMLLIElement>();
  const { label, Icon } = planKind(plan);
  return (
    <li
      ref={ref}
      className="reveal"
      style={{ "--stagger": Math.min(index, 5) } as CSSProperties}
    >
      <div
        className={`lc-hl ${CARD_SHELL} transition-[transform,border-color] duration-(--duration-base) ease-out-quint hover:-translate-y-0.5 hover:border-accent-line`}
      >
        <div className="mb-5 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-[15px] font-[650] tracking-[-0.005em]">
              {plan.name}
            </h3>
            <p className="m-0 mt-1.5 inline-flex items-center gap-1.5 text-[12px] text-text-3">
              <Icon className="size-3.5" /> {label}
            </p>
          </div>
          {plan.technicalOnly ? (
            <span className="shrink-0">
              <Chip>
                <LockIcon className="size-3" /> Technical only
              </Chip>
            </span>
          ) : null}
        </div>
        <dl className="m-0 mt-auto grid grid-cols-3 divide-x divide-line border-t border-line pt-4">
          {specs(plan).map(([unit, value]) => (
            <div
              key={unit}
              className="flex flex-col-reverse px-3 first:pl-0 last:pr-0"
            >
              <dt className="text-[11.5px] text-text-3">{unit}</dt>
              <dd className="m-0 font-mono text-[20px] font-[600] leading-7 tabular-nums text-text-1">
                {value}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </li>
  );
}

export function PlanCardSkeleton() {
  return (
    <li aria-hidden="true">
      <div className={CARD_SHELL}>
        <div className="mb-5 h-[53px]">
          <div className="skeleton h-[22px] w-28 rounded-control" />
          <div className="skeleton mt-1.5 h-[18px] w-20 rounded-control" />
        </div>
        <div className="mt-auto grid grid-cols-3 gap-3 border-t border-line pt-4">
          {[0, 1, 2].map((i) => (
            <div key={i} className="skeleton h-[46px] rounded-control" />
          ))}
        </div>
      </div>
    </li>
  );
}
