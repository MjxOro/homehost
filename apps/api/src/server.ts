import { buildApp } from "./app.js";
import { getEnv } from "./env.js";

const env = getEnv();
const app = buildApp();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    app.close().finally(() => process.exit(0));
  });
}

await app.listen({ port: env.port, host: env.host });
