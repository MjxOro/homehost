import { buildApp } from "./app.js";
import { getEnv } from "./env.js";

const env = getEnv();
// Rolling deploys stop the old replica with SIGTERM while the new one already
// serves. Draining first flips /api/health to 503 so Traefik stops routing
// here, keeps answering whatever is still in flight for SHUTDOWN_DRAIN_MS, and
// only then closes. A second signal falls through to the default and exits.
let draining = false;
const app = buildApp({ draining: () => draining });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    draining = true;
    setTimeout(() => {
      app.close().finally(() => process.exit(0));
    }, env.shutdownDrainMs);
  });
}

await app.listen({ port: env.port, host: env.host });
