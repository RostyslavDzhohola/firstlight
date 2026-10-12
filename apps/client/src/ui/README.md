# FIRSTLIGHT UI kit

Plain DOM + CSS (D25). The look is the design verdict in `docs/design/ui-judging.md`: Entry B's system
("first light": muted ink menus with one warm horizon line, a HUD made of light over dark scrims, warm
80s arcade sprites for anything the player owns, cold mono only for Meridian Oversight).

See every screen and state with mock data, no server needed: run the client dev server and open
`/ui-gallery.html?screen=hud&nav` (screens: landing, loading, charpick, hud, hud-oversight, death,
menu, settings, save-code, players, compass, wheel, shop, inventory, inventory-drag, onboarding,
onboarding-attack, onboarding-done, kit-inventory, kit-onboarding, …). Add
`&live` to keep animations running and `&low` for the Low-tier look (no blur).

## Rules

- **Classes, not inline styles,** for anything static. Inline is fine only for dynamic values
  (`el.style.setProperty("--fill", "0.42")`, positions from projected 3D coordinates).
- **13 px minimum** (`--t-xs`). **Colour is never the only signal**: add text, a number or a shape
  (party slots always show their number, rarity has ● ▲ ◆ ★, weak points get "!").
- **Warm = yours** (arcade frames, hotbar, toasts, bubbles) · **photon = world info** (compass, missions,
  prompts) · **red hatch = hostile** · **cold mono = Oversight**. Don't mix inside one component.
- **Per-frame updates touch the DOM only when a value changes** (cache the last value). Fills use
  `transform: scaleX(var(--fill))`, never `width`. No layout reads in the frame loop.
- **No glow filters on things that update every frame.** Backdrop blur is off on the Low tier
  automatically (`fl-lowfx` on `<html>`), so don't fake it with images.
- **HUD roots** carry `.fl-hud` or `data-hud` so photo mode (F9) hides them. Menus and overlays don't.
- **Full-screen overlays that free the mouse** call `overlayOpened(name)` / `overlayClosed(name)`
  (`ui/dom.ts`) so the Esc menu doesn't pop over them.

## Files

| File | What |
|---|---|
| `styles/tokens.css` | Variables (colours, type scale, spacing, radii, motion, z-scale) on `:root` and `.fl-ui`, fonts |
| `styles/components.css` | Primitives: panel, holo, buttons, keycaps, chips, bars, tier pips, forms, tabs, table, tooltip, overlay/modal, wordmark, Oversight and arcade frames, icons, portraits, pips, rarity |
| `styles/icons.css` | 48 line icons: `<i class="li li-mic"></i>` (take `currentColor`) |
| `sprites.ts` | 16×16 pixel sprites as editable maps; `installSprites()` adds `.px-<name>`; `itemSprite(id)`, `portraitSprite(starter)` |
| `styles/kit.css` | Inventory and onboarding pieces (below) |
| `styles/compat.css` | Legacy `.fl-overlay > .fl-panel` markup gets the kit's centred card |
| `dom.ts` | `el`, `sprite`, `icon`, `button`, `keycaps`, `uiRoot`, `isolateKeys`, overlay registry |
| `hud.ts` | The HUD (API below) |

**Size unit.** Use `calc(N * var(--u))` where a design says N rem (`--u` is 14 px at 1280 wide, 19 px
at 2560). Tokens: `--t-xs … --t-5xl`, `--sp-1 … --sp-8`, `--r-1/2/3/pill`, `--z-vignette 5`,
`--z-hud 10`, `--z-toast 30`, `--z-menu 40`, `--z-modal 50`, `--z-loading 60`.

## HUD API (`game.hud`)

```ts
hud.setYou(you)                       // level, coins, XP, hotbar, ammo (from the `you` message)
hud.setIdentity(name, starter, palette)
hud.setHp(hp, max)                    // "!" after the number and a heartbeat vignette under 25%
hud.setSafe(on)                       // 2.5 s zone banner on change + "Safe" chip
hud.setLogout(endsAt, serverNow)      // 30 s ring
hud.setPrompt("E — take everything from Wren's pile")   // or setPrompt(text, "E")
hud.hit(weak); hud.hurt()
hud.damageNumber(x, y, amount, weak, kind?)              // kind: "normal" | "weak" | "armour" | "shield" | "heal"
hud.toast(text, kind?, { title?, sub?, sprite?, ms? })   // kind: info | xp | coins | medal | warn | mission
hud.bubble(x, y, text, { name?, slot? })                 // phrase-wheel lines get their icon
hud.subtitle(speaker, text, ms?)
hud.bossBar({ name, hp, max, level?, phase?, phaseName?, variant?: "monster" | "oversight", notches?, note? })
hud.hideBossBar()                     // already driven by world/npcs/bossStore via ui/bossHud.ts
hud.setParty(members)                 // already driven by the social lane (ui/partyFrames.ts)
hud.setMissions(lines, header)        // already driven by the quests MissionTracker
hud.voiceSlot                         // bottom-right container for voice indicators
hud.death(info) / hud.characterPick(opts)   // both resolve { starter, palette }
```

## Markup

### Panel, buttons, keycaps, chips

```html
<section class="fl-panel fl-panel--pad">            <!-- ink glass with the horizon line -->
  <div class="fl-eyebrow">Portus Exchange</div>
  <h2 class="fl-title">Buy</h2>
  <p class="fl-lede">Anyone can buy anything.</p>
  <div class="fl-actions fl-actions--end">
    <button class="fl-btn fl-btn--ghost">Close</button>
    <button class="fl-btn fl-btn--primary">Buy <span class="fl-key">E</span></button>
  </div>
  <span class="fl-chip fl-chip--dawn">Tier II</span> <span class="fl-chip fl-chip--danger">Needs Lv 12</span>
</section>
```

Buttons: `fl-btn` + `--primary` (one per screen) `--ghost` `--danger` `--sm` `--lg` `--icon` `--block`.
Chips: `fl-chip` + `--dawn` `--ok` `--danger` `--photon` `--cold`. HUD frames: `fl-holo` (+ `fl-corners`).
Yours: `fl-arcade` (+ `fl-arcade--lit`). Oversight: `fl-cold` with `<span class="fl-hex">`.

### Overlay / modal

```html
<div class="fl-overlay fl-overlay--modal fl-ui">    <!-- centred, scrim; register it with overlayOpened() -->
  <section class="fl-modal fl-panel">
    <h2>Pick a name</h2><p>Other players see it above your head.</p>
    <input class="fl-input" placeholder="Your name"><div class="fl-status">3–16 letters, numbers or _</div>
    <div class="fl-actions fl-actions--split"><button class="fl-btn fl-btn--ghost">Later</button><button class="fl-btn fl-btn--primary">Play</button></div>
  </section>
</div>
```

Forms: `fl-input` (`is-error` / `is-ok`), `fl-switch` (checkbox), `fl-check`, `fl-range` (set
`--val: 40%`), `fl-seg` (buttons, `.is-on`), tabs `fl-tabs > button.fl-tab.is-on`.

### Table / player list (fixed layout, never wider than its panel)

```html
<table class="fl-table">
  <colgroup><col><col class="fl-col-xs"><col class="fl-col-md"><col class="fl-col-md"><col class="fl-col-lg"></colgroup>
  <thead><tr><th>Player</th><th class="r">Lv</th><th>Character</th><th>Voice</th><th></th></tr></thead>
  <tbody>
    <tr class="is-me"><td><span class="fl-pip">1</span>Wren_07 <span class="fl-chip">You</span></td><td class="r num">7</td><td>Unit 7</td><td class="fl-ok">voice on</td><td></td></tr>
  </tbody>
</table>
```

The live player list is `social/playerList.ts` (styles in `social/social.css`).

### Item slot + tooltip (inventory)

```html
<div class="fl-inv__grid">
  <div class="fl-islot fl-arcade is-sel"><span class="fl-islot__k">1</span><i class="px px-carbine"></i>
    <span class="fl-tier"><i class="on"></i><i class="on"></i><i></i></span><span class="fl-islot__q num">21</span></div>
  <div class="fl-islot fl-arcade is-gated"><i class="px px-sunbrand"></i><i class="px px-lock fl-islot__lock"></i><span class="fl-islot__q fl-danger">Lv 12</span></div>
  <div class="fl-islot fl-arcade"><i class="px px-cloak"></i><span class="fl-rar fl-rar--rare"></span></div>
  <div class="fl-islot fl-arcade is-empty"></div>
</div>
<!-- placed beside the hovered slot (left/top set by code), never over the figure or footer -->
<div class="fl-itip">
  <div class="fl-itip__head"><i class="px px-stormcoil"></i><div><b>Stormcoil II</b>
    <div class="fl-itip__meta"><span class="fl-tierbadge">◆◆◇ II</span>Magic</div></div></div>
  <div class="fl-itip__gate"><i class="px px-lock"></i><span>Needs <b>level 12</b>.</span></div>
  <dl class="fl-stats"><dt>Damage</dt><span class="fl-bar"><i></i></span><dd>27<span class="is-up">+7</span></dd></dl>
  <div class="fl-itip__foot"><span>Sells for</span><span class="fl-coin">75</span></div>
</div>
```

Radio picker: `.fl-chans > button.fl-ch(.is-on|.is-full) > b + span`. Drop zone: `.fl-dropzone` (`.is-armed`).
Full example: `ui/gallery/kitExamples.ts` (`INVENTORY_HTML`).

### Onboarding (checklist + current key card)

```html
<div class="fl-onb fl-ui" data-hud>
  <section class="fl-onb__list fl-holo"><h3>First minute · 4 / 12</h3>
    <div class="fl-onb__st is-done"><i></i>Move<span class="fl-keys"><span class="fl-key">W</span>…</span></div>
    <div class="fl-onb__st is-now"><i></i>Sprint<span class="fl-keys"><span class="fl-key fl-key--wide">Shift</span></span></div>
  </section>
  <div class="fl-onb__rail"><span class="fl-onb__rail-t">Step <b>4</b> of 12</span><div class="fl-onb__segs"><i class="is-done"></i><i class="is-now"></i><i></i></div></div>
  <div class="fl-onb__skip"><button class="fl-btn fl-btn--sm">Skip tutorial</button></div>
  <section class="fl-onb__step fl-holo fl-corners"><span class="fl-onb__step-k">Step 4 · Sprint</span><h2>Run faster</h2>
    <div class="fl-onb__keys"><span class="fl-key fl-key--wide">Shift</span><span class="fl-onb__plus">+</span><span class="fl-key">W</span></div>
    <p>Hold <b>Shift</b> while you move.</p>
    <div class="fl-onb__hold"><span class="fl-bar"><i></i></span><span class="num">1.9 / 3 s</span></div>
    <div class="fl-onb__next"><span>Next</span><b>Dodge <span class="fl-key">C</span></b></div></section>
  <div class="fl-callout"><div class="fl-callout__line"></div><div class="fl-callout__dot"></div><div class="fl-callout__box fl-holo">Training dummies<small>10 XP each</small></div></div>
</div>
```

Set the bar fill with `--fill` (0–1) and the callout position with `--x` / `--y`.
Full example: `ui/gallery/kitExamples.ts` (`ONBOARDING_HTML`).

### Phrase wheel, shop, map, journal

Built by their lanes (`ui/phraseWheel.ts`, `ui/panels.ts`, `ui/map.ts`) and restyled with the kit
(`ui/phraseWheel.css`, `ui/quests.css`); keep their class names when changing markup.
