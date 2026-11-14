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

/** The build id client error reports carry (#85): VITE_BUILD_ID, else the deploy's commit, else "dev". */
const BUILD_ID = (process.env.VITE_BUILD_ID || process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 8) || "dev").slice(0, 40);

/**
 * The root `pnpm dev`'s per-run key for reading dev sign-in codes (tools/dev.ts; D-sec3-6). No request
 * returns it, so nobody can fetch it, through a proxy or otherwise (review round three, #2): the dev
 * server prints, in the developer's terminal, a link with the key in its fragment (which a browser
 * never sends), and the page opened from it keeps the key (src/net/devKey.ts). One click per run.
 */
function devSigninKey(): Plugin {
  return {
    name: "firstlight-dev-signin-key",
    apply: "serve",
    configureServer(server) {
      const key = process.env.DEV_SIGNIN_KEY ?? "";
      if (!key) return;
      const print = server.printUrls.bind(server);
      server.printUrls = () => {
        print();
        const local = server.resolvedUrls?.local[0] ?? `http://localhost:${server.config.server.port ?? 5173}/`;
        server.config.logger.info(`  ➜  Dev sign-in codes: open ${local}#fl-dev-key=${key} once (the key stays in that browser; this terminal only)`);
      };
    },
  };
}

export default defineConfig(({ mode, command }) => ({
  plugins: [dataFast({ ...loadEnv(mode, process.cwd(), "VITE_"), ...(process.env as Record<string, string>) }), devSigninKey()],
  define: {
    "import.meta.env.VITE_BUILD_ID": JSON.stringify(BUILD_ID),
    // Dev sign-in codes (#84, net/auth.ts devCode): on for the dev server, a literal false in every
    // build, so the code fetch is never in a production bundle. The key itself is never in a module
    // or a response: devSigninKey() above prints it in the terminal, as a link.
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
