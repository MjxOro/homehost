import { useSession, useSwitchPersona } from "../lib/query";
import { initials } from "../lib/format";
import { Spinner } from "./icons";

const PICKER_GRID =
  "m-0 mt-3.5 grid list-none grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-3";

/**
 * Large persona cards used on the signed-out home view and sign-in gates.
 * Personas come from the live /api/session payload — nothing is hardcoded.
 */
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
            className="pointer-events-none flex w-full cursor-default flex-col items-center gap-2.5 rounded-card border border-line bg-ink-1 px-3.5 py-[18px]"
            aria-hidden="true"
          >
            <span className="skeleton skeleton-avatar" />
            <span className="skeleton skeleton-line w-24" />
            <span className="skeleton skeleton-line w-16" />
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
        {personas.map((persona) => (
          <li key={persona.id}>
            <button
              type="button"
              className="flex w-full cursor-pointer flex-col items-center gap-2.5 rounded-card border border-line bg-ink-1 px-3.5 py-[18px] font-[inherit] text-text-1 transition-colors enabled:hover:border-accent-line enabled:hover:bg-ink-2 disabled:cursor-wait"
              disabled={switchPersona.isPending}
              onClick={() => switchPersona.mutate(persona.id)}
            >
              {switchPersona.isPending ? (
                <Spinner className="spinner-sm" />
              ) : (
                <span
                  className="inline-flex size-11 shrink-0 items-center justify-center rounded-full bg-accent-dim text-[15px] font-bold tracking-[0.02em] text-accent"
                  aria-hidden="true"
                >
                  {initials(persona.name)}
                </span>
              )}
              <span className="text-[14.5px] font-[650]">{persona.name}</span>
              <span className="flex gap-1.5">
                <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-md border border-line-strong px-[7px] py-[3px] font-mono text-[11px] uppercase tracking-[0.04em] text-text-2">
                  {persona.tier}
                </span>
                {persona.role === "operator" ? (
                  <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-md border border-accent-line bg-accent-dim px-[7px] py-[3px] font-mono text-[11px] uppercase tracking-[0.04em] text-accent">
                    operator
                  </span>
                ) : null}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
