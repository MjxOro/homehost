import type { CSSProperties } from "react";
import { useSession, useSwitchPersona } from "../lib/query";
import { initials } from "../lib/format";
import { useReveal } from "../lib/motion";
import { Spinner } from "./icons";
import "./landing/landing.css";

const PICKER_GRID =
  "m-0 mt-4 grid list-none grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-4 p-0";

const CARD_BASE =
  "flex w-full items-center gap-3.5 rounded-card border border-line bg-ink-1 px-4 py-3.5 text-left";

type Persona = NonNullable<
  ReturnType<typeof useSession>["data"]
>["personas"][number];

function PersonaCard({
  persona,
  index,
  disabled,
  pending,
  onPick,
}: {
  persona: Persona;
  index: number;
  disabled: boolean;
  pending: boolean;
  onPick: () => void;
}) {
  const ref = useReveal<HTMLLIElement>();
  return (
    <li
      ref={ref}
      className="reveal"
      style={{ "--stagger": Math.min(index, 5) } as CSSProperties}
    >
      <button
        type="button"
        className={`lc-hl ${CARD_BASE} cursor-pointer font-[inherit] text-text-1 transition-[transform,border-color] duration-(--duration-base) ease-out-quint enabled:hover:-translate-y-0.5 enabled:hover:border-accent-line enabled:active:scale-[0.98] disabled:cursor-wait`}
        disabled={disabled}
        onClick={onPick}
      >
        {pending ? (
          <Spinner className="spinner-sm size-8" />
        ) : (
          <span
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-accent-dim text-[12px] font-bold tracking-[0.02em] text-accent"
            aria-hidden="true"
          >
            {initials(persona.name)}
          </span>
        )}
        <span className="min-w-0">
          <span className="block text-[14.5px] font-[650]">{persona.name}</span>
          <span className="block text-[12.5px] text-text-3">
            {persona.tier} tier
            {persona.role === "operator" ? " · operator" : ""}
          </span>
        </span>
      </button>
    </li>
  );
}

export function PersonaPicker() {
  const { data: session, isPending } = useSession();
  const switchPersona = useSwitchPersona();
  const personas = session?.personas ?? [];

  if (isPending) {
    return (
      <div
        className={PICKER_GRID}
        role="status"
        aria-label="Loading demo personas"
      >
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className={`${CARD_BASE} pointer-events-none cursor-default`}
            aria-hidden="true"
          >
            <span className="skeleton size-8 shrink-0 rounded-full" />
            <span className="skeleton skeleton-line w-24" />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="w-full">
      {switchPersona.isError ? (
        <p
          className="m-0 rounded-control border border-[rgba(224,108,108,0.45)] bg-bad-dim px-3 py-2.5 text-[13.5px] leading-[1.5] text-[#f0a8a8]"
          role="alert"
        >
          Persona switch failed. Is the API running?
        </p>
      ) : null}
      <ul className={PICKER_GRID}>
        {personas.map((persona, i) => (
          <PersonaCard
            key={persona.id}
            persona={persona}
            index={i}
            disabled={switchPersona.isPending}
            pending={switchPersona.isPending}
            onPick={() => switchPersona.mutate(persona.id)}
          />
        ))}
      </ul>
    </div>
  );
}
