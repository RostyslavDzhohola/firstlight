// Home page entry (6a). The page paints from index.html; Play works as soon as this module runs, and
// the home cards (src/home/home.ts) fill in after. The game bundle loads only after Play is pressed.

import "./ui/styles/tokens.css";
import "./ui/styles/components.css";
import "./ui/styles/icons.css";
import "./ui/styles/base.css";
import "./ui/styles/landing.css";
import "./ui/styles/home.css";
import "./ui/styles/loading.css";
import { config } from "./config.ts";
import { maybeInstallE2e } from "./debug/e2eGate.ts";
import { runBoot } from "./game/boot.ts";
import { enterFullscreen } from "./game/fullscreen.ts";
import { hideLandingUnderLoader, showLanding } from "./home/landing.ts";
import { hideLoading, setLoading, showLoadingError } from "./ui/loading.ts";
import { applyUiLook } from "./ui/look.ts";
import { funnelStep, installErrorReporting, markPlay } from "./net/beacon.ts";

// Flat surfaces, or the old blurred look with ?blur=1 (D-ui-1): before anything else draws.
applyUiLook(document.documentElement, location.search);

// Our own funnel and error reports (#85, net/beacon.ts): the server issues this page's visit (and
// records "opened the page" then), and uncaught errors are reported under it.
installErrorReporting();
if (innerWidth < 760) funnelStep("narrow", innerWidth); // a phone or a narrow window: how many get that far

// Playwright journeys only (?e2e): window.__fl, a separate chunk that is never fetched otherwise.
void maybeInstallE2e(location.search, window, () => import("./debug/e2eHook.ts"));

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T | null;
const playBtn = $<HTMLButtonElement>("play");
const params = new URLSearchParams(location.search);

// GitHub Star/Fork stay hidden until the owner makes the repo public (PUBLIC_REPO flag).
if (config.publicRepo) {
  $<HTMLAnchorElement>("repo-star")!.href = config.repoUrl;
  $<HTMLAnchorElement>("repo-fork")!.href = `${config.repoUrl}/fork`;
  $("repo")!.hidden = false;
}

// The maker's credit (#11): linked to the portfolio once config.ownerPortfolio is filled in.
const owner = $<HTMLAnchorElement>("owner-link");
if (owner && config.ownerPortfolio) {
  owner.href = config.ownerPortfolio;
  owner.target = "_blank";
  owner.rel = "noopener";
}

$("copy-link")?.addEventListener("click", async () => {
  await navigator.clipboard.writeText(location.origin + location.pathname).catch(() => {});
  const c = $("copied");
  if (c) c.hidden = false;
});

// Phones and tablets: "Try it on this device (experimental)" starts the game on the Low tier with the
// touch controls (D-controls-6). A reload with those flags, then the usual Play (autoplay).
$("try-touch")?.addEventListener("click", () => {
  const q = new URLSearchParams(location.search);
  q.set("touch", "");
  q.set("tier", "low");
  q.set("autoplay", "");
  location.search = q.toString().replace(/=(?=&|$)/g, "");
});

/** The home cards, account buttons and share row (src/home/home.ts), started once. */
let home: Promise<void> | null = null;
function startHome(): Promise<void> {
  home ??= import("./home/home.ts").then((m) => m.initHome()).catch((err) => console.warn("home page", err));
  return home;
}

function backToLanding() {
  showLanding($("landing")); // fresh data, polling again (home.ts); then the loader goes
  hideLoading();
  if (playBtn) playBtn.disabled = false;
  void startHome(); // ?autoplay never started it: a failed boot comes back to a live page
}

/**
 * Load and start the game. A failure always ends on a screen (F12 S6 + Codex review): the error with
 * Retry (or Reload), or the removal screen when the server removed us while we were arriving.
 */
async function boot() {
  setLoading("Loading the game…", 0.02);
  hideLandingUnderLoader($("landing")); // out of the page once the loader is drawn over it (D-home-8)
  await runBoot(
    async () => {
      const { startGame } = await import("./game/Game.ts");
      await startGame();
    },
    {
      hideLoading,
      showRemoved: (reason) => {
        funnelStep("removed");
        void import("./social/screens.ts").then((m) => m.showRemoved(reason));
      },
      showError: (f) => {
        funnelStep(f.id === "renderer" ? "webgl_none" : f.id === "version" ? "version" : "boot_fail", undefined, f.id);
        showLoadingError({
          title: f.title,
          text: f.text,
          action: f.action === "reload" ? "Reload" : "Retry",
          onAction: () => {
            if (f.action === "reload") return location.reload();
            // A click again: fullscreen can be requested here.
            void enterFullscreen();
            void boot();
          },
          back: "Back to the home page",
          onBack: backToLanding,
        });
      },
    },
  );
}

playBtn?.addEventListener("click", async () => {
  playBtn.disabled = true;
  markPlay();
  // Fullscreen (with Keyboard Lock for Esc) + pointer lock must be requested inside the click.
  await enterFullscreen();
  await boot();
});

// Bench and dev shortcuts: ?autoplay skips the home page (for Codex and benchmarks); ?avatars opens the
// character lineup (every starter look x 6 palettes cycling every clip) instead of the game.
if (params.has("avatars")) {
  void import("./render/avatars/devpage.ts").then((m) => m.startAvatarDevPage());
} else if (params.has("horses")) {
  void import("./render/horses/devpage.ts").then((m) => m.startHorseDevPage()); // six coats with riders
} else if (params.has("autoplay")) playBtn?.click();
else void startHome();
