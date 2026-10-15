// Once per run: start the screenshot folder fresh, so a run's shots are only that run's.

import { rmSync } from "node:fs";
import path from "node:path";
import { OUT } from "./stack.ts";

export default function globalSetup() {
  rmSync(path.join(OUT, "shots"), { recursive: true, force: true });
}
