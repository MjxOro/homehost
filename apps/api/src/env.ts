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
   * Exact origin of this API itself, derived as http://HOST:PORT, so
   * same-origin API calls are allowed alongside APP_ORIGIN.
   */
  apiOrigin: string;
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
  if (process.env.NODE_ENV === "production") {
    throw new Error("refusing showcase boot when NODE_ENV=production");
  }
  if (process.env.SHOWCASE_MODE !== "true") {
    throw new Error("SHOWCASE_MODE=true is required");
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
  return {
    databaseUrl,
    baseDomain: process.env.BASE_DOMAIN ?? "lab.example.test",
    port,
    host,
    appOrigin: httpOrigin(
      process.env.APP_ORIGIN ?? "http://127.0.0.1:5173",
      "APP_ORIGIN",
    ),
    apiOrigin: httpOrigin(`http://${host}:${port}`, "API_ORIGIN"),
  };
}
