#!/usr/bin/env node
// Command line for the FIRSTLIGHT agent bridge (serve.ts), for a model or a person with a shell:
//
//   node tools/agent/serve.ts &                      # start the bridge once (127.0.0.1:7361)
//   node tools/agent/fl-agent.mjs join --name Scout_7 --starter unit7 [--dev]
//   node tools/agent/fl-agent.mjs observe [--detail full]
//   node tools/agent/fl-agent.mjs move guide          # or: move --bearing 90 --distance 40 --sprint
//   node tools/agent/fl-agent.mjs attack n12 --seconds 20
//   node tools/agent/fl-agent.mjs missions take
//   node tools/agent/fl-agent.mjs shop buy --item tonic_small --qty 2
//   node tools/agent/fl-agent.mjs item use --item tonic_small
//   node tools/agent/fl-agent.mjs travel --portal arcadia
//   node tools/agent/fl-agent.mjs cast skipstep --bearing 180      # or: cast wishfall --target n12
//   node tools/agent/fl-agent.mjs trial A4                         # play a race / defend / collect mission
//   node tools/agent/fl-agent.mjs tools               # every tool with its arguments
//   node tools/agent/fl-agent.mjs quit                # leave the game and stop the bridge
//
// `--key value` pairs become the tool's JSON arguments (numbers and true/false are converted). The
// first bare word after the tool is its main argument (move/attack/interact: target; missions/shop/
// item: action; say: phrase; cast: spell; trial: mission). `--pos x,y,z` and `--ids A1,A4` are lists. Prints the game's text summary when there is one, else JSON. Exit code
// 0 when the result is ok, 1 when it isn't, 2 when the bridge can't be reached.

const base = `http://127.0.0.1:${process.env.FL_AGENT_PORT ?? 7361}`;
const [tool, ...rest] = process.argv.slice(2);
const MAIN = { move: "target", attack: "target", interact: "target", missions: "action", shop: "action", item: "action", say: "phrase", cast: "spell", trial: "mission" };

function parse(words) {
  const args = {};
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w.startsWith("--")) {
      const next = words[i + 1];
      const v = next === undefined || next.startsWith("--") ? "true" : words[++i];
      const key = w.slice(2);
      args[key] =
        key === "pos" ? v.split(",").map(Number)
        : key === "ids" ? v.split(",")
        : v === "true" ? true
        : v === "false" ? false
        : v !== "" && !Number.isNaN(Number(v)) && key !== "target" && key !== "name" && key !== "item" && key !== "mission" && key !== "spell" ? Number(v)
        : v;
    } else if (MAIN[tool] && args[MAIN[tool]] === undefined) args[MAIN[tool]] = w;
    else if (tool === "shop" || tool === "item") args.item ??= w;
  }
  return args;
}

async function main() {
  if (!tool || tool === "help" || tool === "--help") {
    console.log("usage: fl-agent.mjs <join|observe|move|stop|attack|dodge|interact|missions|trial|shop|item|travel|cast|say|respawn|leave|tools|quit> [main argument] [--key value …]\nStart the bridge first: node tools/agent/serve.ts");
    return 0;
  }
  let res;
  try {
    if (tool === "tools") res = await fetch(`${base}/`);
    else if (tool === "quit") res = await fetch(`${base}/quit`, { method: "POST" });
    else res = await fetch(`${base}/${tool}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(parse(rest)) });
  } catch {
    console.error(`no agent bridge on ${base}: start it with "node tools/agent/serve.ts"`);
    return 2;
  }
  const r = await res.json();
  if (tool === "tools") {
    for (const t of r.tools) console.log(`${t.name.replace("firstlight_", "")}  ${Object.entries(t.inputSchema.properties).map(([k, p]) => `--${k}${p.enum ? ` <${p.enum.join("|")}>` : ""}`).join(" ")}\n    ${t.description}\n`);
    return 0;
  }
  const { summary, look, ...more } = r;
  const text = summary ?? look;
  if (text) console.log(text);
  if (!text || Object.keys(more).length > 1 || more.ok !== true) console.log(JSON.stringify(more, null, text ? 0 : 1));
  return r.ok === false ? 1 : 0;
}

process.exitCode = await main();
