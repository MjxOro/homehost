export interface OAuthProviderConfig {
  clientId: string;
  clientSecret: string;
}

/** Paired client id/secret, or null when the provider is not configured. */
function readProvider(prefix: string): OAuthProviderConfig | null {
  const clientId = process.env[`${prefix}_CLIENT_ID`];
  const clientSecret = process.env[`${prefix}_CLIENT_SECRET`];
  if (clientId && !clientSecret) {
    throw new Error(
      `${prefix}_CLIENT_SECRET is required with ${prefix}_CLIENT_ID`,
    );
  }
  if (!clientId && clientSecret) {
    throw new Error(
      `${prefix}_CLIENT_ID is required with ${prefix}_CLIENT_SECRET`,
    );
  }
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

export interface ApiEnv {
  databaseUrl: string;
  baseDomain: string;
  port: number;
  host: string;
  /**
   * Exact browser origin permitted to issue mutations, e.g. the Vite loopback
   * proxy (default http://127.0.0.1:5173). Origins are compared exactly as
   * full `scheme://host:port` strings; localhost subdomains/ports are NOT
   * wildcards, and no X-Forwarded-* proxy headers are trusted.
   */
  appOrigin: string;
  /**
   * Extra browser origins permitted to issue mutations (e.g. LAN IP when
   * opening dev to 0.0.0.0). Canonical OAuth redirects still use appOrigin.
   */
  appExtraOrigins: string[];
  /**
   * Exact origin of this API itself, derived as http://HOST:PORT, so
   * same-origin API calls are allowed alongside APP_ORIGIN.
   */
  apiOrigin: string;
  /** Google OAuth client, or null when unconfigured. Redirects use appOrigin. */
  google: OAuthProviderConfig | null;
  /** GitHub OAuth client, or null when unconfigured. Redirects use appOrigin. */
  github: OAuthProviderConfig | null;
  /** Lowercased operator allowlist; required when any OAuth provider is configured. */
  operatorEmails: string[];
  /**
   * False only when SHOWCASE_MODE=false is set explicitly. Live mode hides
   * demo personas and disables demo logins; it requires real auth (an OAuth
   * provider plus the operator allowlist) so the panel can never boot into a
   * state with no possible admin.
   */
  showcase: boolean;
}

function httpOrigin(raw: string, name: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} must be a valid http(s) origin, got ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${name} must be a valid http(s) origin, got ${raw}`);
  }
  return url.origin;
}

/** Showcase boot gates. Throws instead of booting when unsafe. */
export function getEnv(): ApiEnv {
  const showcase = process.env.SHOWCASE_MODE !== "false";
  if (process.env.NODE_ENV === "production" && showcase) {
    throw new Error("refusing showcase boot when NODE_ENV=production");
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const host = process.env.HOST ?? "127.0.0.1";
  const port = Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(
      `PORT must be an integer from 1 to 65535, got ${process.env.PORT ?? ""}`,
    );
  }
  const google = readProvider("GOOGLE");
  const github = readProvider("GITHUB");
  const operatorEmails = (process.env.OPERATOR_EMAILS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
  if ((google || github) && operatorEmails.length === 0) {
    throw new Error("OPERATOR_EMAILS is required when OAuth is configured");
  }
  if (!showcase && !(google || github)) {
    throw new Error(
      "SHOWCASE_MODE=false requires an OAuth provider (GITHUB_ or GOOGLE_ client pair)",
    );
  }
  if (!showcase && operatorEmails.length === 0) {
    throw new Error("SHOWCASE_MODE=false requires OPERATOR_EMAILS");
  }
  return {
    databaseUrl,
    baseDomain: process.env.BASE_DOMAIN ?? "lab.example.test",
    port,
    host,
    appOrigin: httpOrigin(
      process.env.APP_ORIGIN ?? "http://127.0.0.1:5173",
      "APP_ORIGIN",
    ),
    appExtraOrigins: (process.env.APP_EXTRA_ORIGINS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((s) => httpOrigin(s, "APP_EXTRA_ORIGINS")),
    apiOrigin: httpOrigin(`http://${host}:${port}`, "API_ORIGIN"),
    google,
    github,
    operatorEmails,
    showcase,
  };
}
