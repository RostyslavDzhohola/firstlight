# UI design competition: verdict (2026-10-12)

Entries: Fable 5.1 = Entry A (`../design/fable/`), Opus 5.5 = Entry B (`../design/opus/`). Brief: `../design/BRIEF.md`.
Judge: Opus 5.5 sub-agent; every page rendered with `html_preview` at 1440×810 (plus 1280×720 HUD, 390 phone).

**Use Entry B as the base system.** It wins 10 of 14 screens. Entry A wins landing, loading, player list, onboarding.

| # | Screen | Winner | Reason |
|---|---|---|---|
| 1 | Landing | A | Clean order: wordmark, big Play, online count, credit line, Star/Fork. B's planet collides with the wordmark; a light beam cuts the tagline and Play. |
| 2 | Loading | A | Calm centred status line, 4 named boot steps and a tip. |
| 3 | Character | B | Spotlight hero preview, pixel portraits, weapon stats, live palette recolour, name validation. |
| 4 | HUD | B | Warm 80s pixel item sprites, red hatched boss bar, party frames, ammo readout, states sheet. |
| 5 | Player list | A | Tidy table, voice states in words, inline admin strip. |
| 6 | Inventory | B | Radio 1–9 with occupancy, tooltip with level gate and stat bars, drop zone. |
| 7 | Death | B | Grey freeze-frame, pile still glowing; cold Oversight killer card vs warm player-killer card. |
| 8 | Esc menu | B | Rows with descriptions, inline logout countdown + Cancel, "outside safe zone" warning. |
| 9 | Settings | B | Every control visible at once incl. 16+ opt-in, "never recorded", colour-blind preview. |
| 10 | Phrase wheel | B | Pixel icons on sectors, pixel-cornered speech bubbles. |
| 11 | Save | B (narrow) | All four states incl. "Saving is busy", resend ring. |
| 12 | Onboarding | A | 12-step checklist with key caps + big current-key card. |
| 13 | Shop | B | Keeper portrait, clear table, detail pane "214 → 94" after buying, locked tiers. |
| 14 | Map | B | Readable sphere, boss lair in red ring, "?" for undiscovered pads, pad progress. |

Fonts (all SIL OFL 1.1, self-host woff2): B uses Barlow Semi Condensed (display, HUD labels, numbers), Inter (body), JetBrains Mono (keys, counters, Oversight).

## Take from A
- Onboarding checklist layout, player-list structure (fix: each row its own grid → use `minmax(0, …)` columns or subgrid), loading layout, landing layout (keep B's thin "FIRST" / bold "LIGHT" wordmark).
- HUD: Oversight boss-bar variant (slate + amber, square, monospaced); "!" after a low HP number.
- Damage numbers: shield = white number with cyan outline.
- Shop I/II/III price buttons per weapon; "killed by a party member" joke-medal death state.

## Fix in B when porting
1. Player list: table wider than `.list` → `table-layout: fixed` with column widths.
2. HUD: medal/mission toasts overlap the mission tracker (one flex column); XP bar has a slider knob (remove); hotbar tier marks ◆◇◇ too small; `--z-vignette: 20` above `--z-hud: 10` → vignette must be 5.
3. Landing: move the green planet off the wordmark; remove the vertical beam and rings bleeding into the online row.
4. Character: first play says "Life 3 begins…" next to "LIFE 1"; palette "Night" → "Midnight"; Brother Ash = black hood + two glowing yellow eyes reads like a famous franchise's desert scavengers → give him a visible face or visor.
5. Map labels collide; inventory tooltip covers figure/footer and its tier badge overlaps the icon; shop detail labels wrap; settings "Detected High" chip misaligned; esc How-to-play keys too far from labels; "Leaving safe zone" banner wraps; death stats need a dark scrim.
6. Performance: ~24 backdrop blurs incl. inside every clipped arcade frame → blur off on Low tier; no glow filters on elements updated every frame.
7. Structure: split the 80 KB tokens.css into variables, components, icons/sprites; scope the scaling root font size to the UI root; turn inline `style=` into classes; delete `.mock-states` and hash scripts; self-host fonts.

## Tokens to adopt (B's tokens.css)
- Menu neutrals `--ink-0…6` (#05070a → #323b49), `--fog-1…4` (#4a5363, #6b7484, #949cab, #bcc2cc), `--paper` #efe9df, `--line-1…3`.
- Warm accent `--dawn-1…4` (#e48a72, #f3ae5b, #ffd99b, #fff3df) + `--horizon` gradient.
- HUD light `--photon` #c4f1ff / `--photon-2` #7ad8ff, `--hud-scrim`, `--hud-text-shadow`.
- Players (warm) `--hero-amber` #ffb547, `--hero-coral` #ff7b5c, `--hero-cream` #fff3dc, `--hero-gold` #ffc94a. Party `--party-1…4` (always with slot number).
- Enemy only (cold) `--cold-1…4`, `--cold-slit` #ffb000, `--cold-signal` #ff4b3e.
- Gameplay: `--hp` #ff6f5e; `--xp`/`--coin` #ffc94a; `--shield` #5fe3ff; `--safe` #8ff3ff; `--hostile` #ff5d4d. Damage numbers: normal white; weak point #ffd23f 1.3× + "!"; armour-reduced grey #9aa3ad smaller; shield white + cyan outline. Rarity = colour + shape (● ▲ ◆ ★).
- Planet keys and the six starter palette triplets (`--pal-*`).
- Type scale: root `clamp(14px, .39vw + 9px, 19px)`, `--t-xs` .9375rem (13 px min) … `--t-5xl` 6rem; caps tracking .16em; tabular numbers.
- Spacing `--sp-1…8` (.25–4rem); radii 2, 4, 8 px, pill. Motion `--ease-out`, `--ease-snap`, 120/200/320/600/1200 ms. Z scale 0/10/30/40/50 with vignette at 5.
