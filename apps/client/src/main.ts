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
import { runBoot } from "./game/boot.ts";
import { hideLoading, setLoading, showLoadingError } from "./ui/loading.ts";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T | null;
const playBtn = $<HTMLButtonElement>("play");
const params = new URLSearchParams(location.search);

// GitHub Star/Fork stay hidden until the owner makes the repo public (PUBLIC_REPO flag).
if (config.publicRepo) {
  $<HTMLAnchorElement>("repo-star")!.href = config.repoUrl;
  $<HTMLAnchorElement>("repo-fork")!.href = `${config.repoUrl}/fork`;
  $("repo")!.hidden = false;
}

$("copy-link")?.addEventListener("click", async () => {
  await navigator.clipboard.writeText(location.origin + location.pathname).catch(() => {});
  const c = $("copied");
  if (c) c.hidden = false;
});

function backToLanding() {
  hideLoading();
  const landing = $("landing");
  if (landing) landing.style.display = "";
  if (playBtn) playBtn.disabled = false;
}

/**
 * Load and start the game. A failure always ends on a screen (F12 S6 + Codex review): the error with
 * Retry (or Reload), or the removal screen when the server removed us while we were arriving.
 */
async function boot() {
  setLoading("Loading the game…", 0.02);
  await runBoot(
    async () => {
      const { startGame } = await import("./game/Game.ts");
      await startGame();
    },
    {
      hideLoading,
      showRemoved: (reason) => void import("./social/screens.ts").then((m) => m.showRemoved(reason)),
      showError: (f) =>
        showLoadingError({
          title: f.title,
          text: f.text,
          action: f.action === "reload" ? "Reload" : "Retry",
          onAction: () => {
            if (f.action === "reload") return location.reload();
            // A click again: fullscreen can be requested here.
            void document.documentElement.requestFullscreen?.().catch(() => {});
            void boot();
          },
          back: "Back to the home page",
          onBack: backToLanding,
        }),
    },
  );
}

playBtn?.addEventListener("click", async () => {
  playBtn.disabled = true;
  // Fullscreen + pointer lock must be requested inside the click.
  await document.documentElement.requestFullscreen?.().catch(() => {});
  await boot();
});

// Bench and dev shortcuts: ?autoplay skips the home page (for Codex and benchmarks); ?avatars opens the
// character lineup (4 starters x 6 palettes cycling every clip) instead of the game.
if (params.has("avatars")) {
  void import("./render/avatars/devpage.ts").then((m) => m.startAvatarDevPage());
} else if (params.has("horses")) {
  void import("./render/horses/devpage.ts").then((m) => m.startHorseDevPage()); // six coats with riders
} else if (params.has("autoplay")) playBtn?.click();
else void import("./home/home.ts").then((m) => m.initHome()).catch((err) => console.warn("home page", err));
