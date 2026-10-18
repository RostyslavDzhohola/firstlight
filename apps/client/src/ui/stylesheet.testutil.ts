// For happy-dom tests that check what a real stylesheet does (a computed `visibility`, not a class
// name): `await withStylesheet("ui/menu.css", async () => { … })` adds that file (path from
// apps/client/src) to the document as a <style> for the duration of `run`, and removes it after.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

export async function withStylesheet(srcPath: string, run: () => unknown): Promise<void> {
  const style = document.createElement("style");
  style.textContent = readFileSync(join(SRC, srcPath), "utf8");
  document.head.append(style);
  try {
    await run();
  } finally {
    style.remove();
  }
}
