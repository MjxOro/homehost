import { useLogout, useSession, useSwitchPersona } from "../lib/query";
import { BUTTON_OUTLINE } from "./primitives";
import { Spinner } from "./icons";

const SELECT_CLASS =
  "min-h-11 max-w-[128px] cursor-pointer appearance-none rounded-full border border-line-strong bg-ink-1 bg-[url(data:image/svg+xml,%3Csvg%20xmlns=%27http://www.w3.org/2000/svg%27%20viewBox=%270%200%2024%2024%27%20fill=%27none%27%20stroke=%27%237e939a%27%20stroke-width=%272%27%20stroke-linecap=%27round%27%20stroke-linejoin=%27round%27%3E%3Cpath%20d=%27m6%209%206%206%206-6%27/%3E%3C/svg%3E)] bg-[position:right_12px_center] bg-[size:16px] bg-no-repeat py-2 pe-[38px] ps-3.5 text-[14px] font-semibold text-text-1 transition-colors enabled:hover:border-text-3 disabled:cursor-wait disabled:opacity-60 sm:max-w-60";

/**
 * Topbar persona switcher built on a native <select> — keyboard, screen-reader
 * and focus behaviour come from the platform, not a hand-rolled menu. Personas
 * come from the live /api/session payload; "Sign out" is an extra option that
 * only appears while signed in.
 */
export function PersonaMenu() {
  const { data: session, isPending } = useSession();
  const switchPersona = useSwitchPersona();
  const logout = useLogout();
  const user = session?.user ?? null;
  const personas = session?.personas ?? [];
  const busy = switchPersona.isPending || logout.isPending;
  // Live mode serves no personas, so the switcher collapses to sign-out —
  // still rendered for signed-in users, who otherwise lose their exit.
  if (personas.length === 0) {
    if (!user) return null;
    return (
      <button
        type="button"
        className={BUTTON_OUTLINE}
        disabled={logout.isPending}
        onClick={() => logout.mutate()}
      >
        Sign out
      </button>
    );
  }
  return (
    <div className="flex min-w-0 flex-col items-end gap-1">
      <div className="flex min-w-0 items-center gap-2.5">
        {switchPersona.isPending ? (
          <Spinner className="spinner-sm" aria-hidden="true" />
        ) : null}
        <label className="sr-only" htmlFor="persona-select">
          Demo persona
        </label>
        <select
          id="persona-select"
          className={SELECT_CLASS}
          value={user?.id ?? ""}
          disabled={isPending || busy}
          onChange={(event) => {
            const value = event.target.value;
            if (value === "__logout__") {
              logout.mutate();
            } else if (value.length > 0) {
              switchPersona.mutate(value);
            }
          }}
        >
          {user ? null : (
            <option value="" disabled>
              Signed out — pick a persona
            </option>
          )}
          {personas.map((persona) => (
            <option key={persona.id} value={persona.id}>
              {persona.name} — {persona.tier}
              {persona.role === "operator" ? " · operator" : ""}
            </option>
          ))}
          {user ? <option value="__logout__">Sign out</option> : null}
        </select>
      </div>
      {switchPersona.isError ? (
        <p
          className="m-0 max-w-[min(70vw,320px)] text-right text-[12.5px] text-[#f0a8a8]"
          role="alert"
        >
          Persona switch failed — is the API running?
        </p>
      ) : null}
    </div>
  );
}
