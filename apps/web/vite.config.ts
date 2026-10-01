import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Same-origin dev server: the browser talks to Vite only, and /api is proxied
// to the Fastify control plane (override with API_PROXY_TARGET).
const apiTarget = process.env.API_PROXY_TARGET ?? "http://127.0.0.1:3000";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    strictPort: true,
    // Loopback and LAN only: the dev stack is never published on a public
    // name (see infra/dev/compose.yml).
    allowedHosts: ["localhost", "127.0.0.1", "192.168.1.16"],
    proxy: {
      "/api": {
        target: apiTarget,
        changeOrigin: false,
        ws: true,
      },
    },
  },
});
