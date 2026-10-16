import { defineConfig, loadEnv, type Plugin } from "vite";
import { DATAFAST_GUARD, dataFastScript } from "./src/home/datafast.ts";

// In production Vercel proxies /api/auth/* (and /admin/*, /stats) to the game server; in dev Vite does, so the
// Better Auth session cookie stays first-party on the client origin.
const API_TARGET = process.env.API_PROXY_TARGET ?? "http://localhost:2567";

/** DataFast's tracking script in index.html, only when it's configured at build time (6f). */
function dataFast(env: Record<string, string>): Plugin {
  const s = dataFastScript(env);
  return {
    name: "firstlight-datafast",
    transformIndexHtml: {
      order: "post",
      handler: (_html, ctx) =>
        s && ctx.path === "/index.html"
          ? [
              { tag: "script", children: DATAFAST_GUARD, injectTo: "head" },
              { tag: "script", attrs: { defer: true, "data-website-id": s.websiteId, "data-domain": s.domain, src: s.src }, injectTo: "head" },
            ]
          : [],
    },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [dataFast({ ...loadEnv(mode, process.cwd(), "VITE_"), ...(process.env as Record<string, string>) })],
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
}));
