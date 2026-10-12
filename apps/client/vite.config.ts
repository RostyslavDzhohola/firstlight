import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In production Vercel proxies /api/auth/* (and /admin/*) to the game server; in dev Vite does, so the
// Better Auth session cookie stays first-party on the client origin.
const API_TARGET = process.env.API_PROXY_TARGET ?? "http://localhost:2567";

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.CLIENT_PORT ?? 5173),
    host: true,
    proxy: {
      "/api/auth": { target: API_TARGET, changeOrigin: false, xfwd: true },
      "/admin": { target: API_TARGET, changeOrigin: false, xfwd: true },
    },
  },
  build: {
    target: "es2023",
    sourcemap: true,
    chunkSizeWarningLimit: 2000,
  },
  worker: { format: "es" },
});
