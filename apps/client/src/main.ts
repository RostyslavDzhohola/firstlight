// Landing page logic. The game bundle loads only after Play is pressed.

import { config } from "./config.ts";

const playBtn = document.getElementById("play") as HTMLButtonElement | null;
const online = document.getElementById("online");

async function refreshOnline() {
  try {
    const r = await fetch(`${config.apiUrl}/api/online`);
    const { online: n } = (await r.json()) as { online: number };
    if (online) online.textContent = n === 1 ? "1 player online" : `${n} players online`;
  } catch {
    if (online) online.textContent = "";
  }
}
void refreshOnline();
setInterval(refreshOnline, 15000);

document.getElementById("copy-link")?.addEventListener("click", async () => {
  await navigator.clipboard.writeText(location.href).catch(() => {});
});

playBtn?.addEventListener("click", async () => {
  playBtn.disabled = true;
  // Fullscreen + pointer lock must be requested inside the click.
  await document.documentElement.requestFullscreen?.().catch(() => {});
  const { startGame } = await import("./game/Game.ts");
  await startGame();
});

// Bench and dev shortcuts: ?autoplay skips the landing (for Codex and benchmarks).
if (new URLSearchParams(location.search).has("autoplay")) playBtn?.click();
