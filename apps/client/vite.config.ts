import { defineConfig, loadEnv, type Plugin } from "vite";
import { DATAFAST_GUARD, dataFastScript } from "./src/home/datafast.ts";
import { localPage } from "./src/net/devKeyGuard.ts";

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

/** The build id client error reports carry (#85): VITE_BUILD_ID, else the deploy's commit, else "dev". */
const BUILD_ID = (process.env.VITE_BUILD_ID || process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 8) || "dev").slice(0, 40);

/**
 * The root `pnpm dev`'s per-run key for reading dev sign-in codes (tools/dev.ts), served at
 * /@firstlight/dev-key (no-store) to this machine's own pages only, never inside a module: the
 * dev server listens on every interface (host: true), and a LAN neighbour must not read it.
 */
function devSigninKey(): Plugin {
  return {
    name: "firstlight-dev-signin-key",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/@firstlight/dev-key", (req, res) => {
        const key = process.env.DEV_SIGNIN_KEY ?? "";
        res.setHeader("Cache-Control", "no-store");
        if (!key || req.method !== "GET" || !localPage(req)) {
          res.statusCode = 404;
          res.end();
          return;
        }
        res.setHeader("Content-Type", "text/plain");
        res.end(key);
      });
    },
  };
}

export default defineConfig(({ mode, command }) => ({
  plugins: [dataFast({ ...loadEnv(mode, process.cwd(), "VITE_"), ...(process.env as Record<string, string>) }), devSigninKey()],
  define: {
    "import.meta.env.VITE_BUILD_ID": JSON.stringify(BUILD_ID),
    // Dev sign-in codes (#84, net/auth.ts devCode): on for the dev server, a literal false in every
    // build, so the code fetch is never in a production bundle. The key itself is never in a module:
    // devSigninKey() below hands it to this machine's own pages.
    __FL_DEV_CODES__: JSON.stringify(command === "serve" && !!process.env.DEV_SIGNIN_KEY),
  },
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
