// `pnpm e2e:gate`: run only the journeys listed in gates.json (the ones that must pass before a deploy),
// each on the projects it names. Exits non-zero when any of them fails or the list is broken.
//
// gates.json: { "gates": [{ "id": "J2.2", "projects": ["webgl", "webgpu"], "since": "…", "note": "…" }] }
// A journey joins the list once its feature lane has landed and it passes; it never leaves silently.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { gates } = JSON.parse(readFileSync(path.join(here, "gates.json"), "utf8"));
if (!Array.isArray(gates) || gates.some((g) => !/^J\d+\.\d+$|^smoke$/.test(g.id) || !Array.isArray(g.projects) || !g.projects.length)) {
  console.error("gates.json: every gate needs an id like J2.4 (or smoke) and a non-empty projects list");
  process.exit(2);
}
if (!gates.length) {
  console.log("gates.json lists no journeys: nothing to run");
  process.exit(0);
}

const byProject = new Map();
for (const g of gates) for (const p of g.projects) byProject.set(p, [...(byProject.get(p) ?? []), g.id]);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

let failed = false;
for (const [project, ids] of byProject) {
  const grep = `(${ids.map((id) => `@${esc(id)}`).join("|")})( |$)`;
  console.log(`\n[e2e:gate] ${project}: ${ids.join(", ")}`);
  const r = spawnSync("npx", ["playwright", "test", "-c", path.join(here, "playwright.config.ts"), "--project", project, "--grep", grep, ...process.argv.slice(2)], {
    stdio: "inherit",
    cwd: path.resolve(here, ".."),
  });
  if (r.error) console.error(`[e2e:gate] ${project}: couldn't start Playwright: ${r.error.message}`);
  if (r.status !== 0) failed = true;
}
console.log(failed ? "\n[e2e:gate] FAILED: a gated journey failed; don't deploy." : "\n[e2e:gate] all gated journeys passed.");
process.exit(failed ? 1 : 0);
