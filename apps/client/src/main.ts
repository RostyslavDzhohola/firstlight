// Landing page logic. The game bundle loads only after Play is pressed.

import "./ui/styles/tokens.css";
import "./ui/styles/components.css";
import "./ui/styles/icons.css";
import "./ui/styles/base.css";
import "./ui/styles/landing.css";
import "./ui/styles/loading.css";
import { config } from "./config.ts";
import { maybeInstallE2e } from "./debug/e2eGate.ts";
import { runBoot } from "./game/boot.ts";
import { hideLoading, setLoading, showLoadingError } from "./ui/loading.ts";

// Playwright journeys only (?e2e): window.__fl, a separate chunk that is never fetched otherwise.
void maybeInstallE2e(location.search, window, () => import("./debug/e2eHook.ts"));

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T | null;
const playBtn = $<HTMLButtonElement>("play");

/** "N players online"; 0 reads as an invitation, not an empty room. */
function onlineLabel(n: number): string {
  if (n <= 0) return "Be the first one online";
  return n === 1 ? "player online" : "players online";
}

async function refreshOnline() {
  const box = $("online");
  try {
    const r = await fetch(`${config.apiUrl}/api/online`);
    const { online: n } = (await r.json()) as { online: number };
    if (!box || typeof n !== "number") return;
    $("online-n")!.textContent = n > 0 ? n.toLocaleString("en-US") : "";
    $("online-n")!.hidden = n <= 0;
    $("online-label")!.textContent = onlineLabel(n);
    box.hidden = false;
  } catch {
    if (box) box.hidden = true;
  }
}
void refreshOnline();
setInterval(refreshOnline, 15000);

// GitHub Star/Fork stay hidden until the owner makes the repo public (PUBLIC_REPO flag).
if (config.publicRepo) {
  $<HTMLAnchorElement>("repo-star")!.href = config.repoUrl;
  $<HTMLAnchorElement>("repo-fork")!.href = `${config.repoUrl}/fork`;
  $("repo")!.hidden = false;
}

$("copy-link")?.addEventListener("click", async () => {
  await navigator.clipboard.writeText(location.href).catch(() => {});
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
          back: "Back to the start page",
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

$("signin")?.addEventListener("click", async (e) => {
  e.preventDefault();
  const { showSignIn } = await import("./ui/account.ts");
  const r = await showSignIn();
  if (r === "signed-in") playBtn?.click();
});

// Bench and dev shortcuts: ?autoplay skips the landing (for Codex and benchmarks); ?avatars opens the
// character lineup (4 starters x 6 palettes cycling every clip) instead of the game.
if (new URLSearchParams(location.search).has("avatars")) {
  void import("./render/avatars/devpage.ts").then((m) => m.startAvatarDevPage());
} else if (new URLSearchParams(location.search).has("horses")) {
  void import("./render/horses/devpage.ts").then((m) => m.startHorseDevPage()); // six coats with riders
} else if (new URLSearchParams(location.search).has("autoplay")) playBtn?.click();
