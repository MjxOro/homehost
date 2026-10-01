export const SESSION_MAX_AGE_S = 30 * 24 * 60 * 60;
const STATE_MAX_AGE_S = 10 * 60;

function getCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx >= 0 && part.slice(0, idx).trim() === name)
      return part.slice(idx + 1).trim();
  }
  return null;
}

/** One policy per configured panel origin; never trust proxy headers. */
export function createCookiePolicy(appOrigin: string) {
  const secure = new URL(appOrigin).protocol === "https:";
  const prefix = secure ? "__Host-" : "";
  const sessionName = `${prefix}hh_session`;
  const stateName = `${prefix}hh_oauth_state`;
  const attributes = `Path=/; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
  const build = (name: string, value: string, maxAge: number) =>
    `${name}=${encodeURIComponent(value)}; ${attributes}; Max-Age=${maxAge}`;
  const clear = (name: string) =>
    `${build(name, "", 0)}; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
  return {
    session: (token: string) => build(sessionName, token, SESSION_MAX_AGE_S),
    clearSession: () => clear(sessionName),
    state: (value: string) => build(stateName, value, STATE_MAX_AGE_S),
    clearState: () => clear(stateName),
    // Minted session tokens are hex; never decode untrusted session input.
    getSession: (header: string | undefined) => getCookie(header, sessionName),
    getState: (header: string | undefined) => {
      const raw = getCookie(header, stateName);
      if (!raw) return null;
      try {
        return decodeURIComponent(raw);
      } catch {
        return null;
      }
    },
  };
}
export type CookiePolicy = ReturnType<typeof createCookiePolicy>;
