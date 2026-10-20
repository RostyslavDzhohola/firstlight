#!/usr/bin/env node
// The live session's command line (live/README.md): `e2e/live/fl.mjs <command> [args…]` sends one
// command to the session `pnpm e2e:live` runs and prints the answer. `fl.mjs help` lists the commands;
// `fl.mjs ready [sec]` waits for a session that is still building and loading.

const port = Number(process.env.FL_LIVE_PORT ?? 7357);
const url = `http://127.0.0.1:${port}/`;
const [cmd = "help", ...args] = process.argv.slice(2);

if (cmd === "ready") {
  const until = Date.now() + Number(args[0] ?? 180) * 1000;
  for (;;) {
    try {
      const r = await fetch(url);
      console.log(`session ready: ${await r.text()}`);
      process.exit(0);
    } catch {}
    if (Date.now() > until) {
      console.error(`no live session on 127.0.0.1:${port} after ${args[0] ?? 180} s (is \`pnpm e2e:live\` running? its log says why not)`);
      process.exit(2);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

try {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cmd, args }) });
  const text = await r.text();
  process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
  process.exit(r.ok ? 0 : 1);
} catch (e) {
  if (e?.cause?.code !== "ECONNREFUSED") throw e;
  console.error(`no live session on 127.0.0.1:${port}: start one with \`pnpm e2e:live\` (about a minute to build and load), then \`fl.mjs ready\``);
  process.exit(2);
}
