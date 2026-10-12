import { defineConfig } from "vite";

// In production Vercel proxies /api/auth/* (and /admin/*, /stats) to the game server; in dev Vite does, so the
// Better Auth session cookie stays first-party on the client origin.
const API_TARGET = process.env.API_PROXY_TARGET ?? "http://localhost:2567";

export default defineConfig({
  server: {
    port: Number(process.env.CLIENT_PORT ?? 5173),
    host: true,
    proxy: {
      "/api/auth": { target: API_TARGET, changeOrigin: false, xfwd: true },
      "/admin": { target: API_TARGET, changeOrigin: false, xfwd: true },
      "/stats": { target: API_TARGET, changeOrigin: false, xfwd: true },
    },
  },
  build: {
    target: "es2023",
    // No production source maps: they would be served from the public site next to the bundle.
    sourcemap: false,
    chunkSizeWarningLimit: 2000,
  },
  worker: { format: "es" },
});
