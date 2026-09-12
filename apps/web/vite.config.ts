import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Same-origin dev server: the browser talks to Vite only, and /api is proxied
// to the Fastify control plane (override with API_PROXY_TARGET).
const apiTarget = process.env.API_PROXY_TARGET ?? "http://127.0.0.1:3000";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: apiTarget,
        changeOrigin: false,
      },
    },
  },
});
