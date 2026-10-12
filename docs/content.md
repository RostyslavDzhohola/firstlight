# FIRSTLIGHT content bible (spec extract)

Built 11 Oct 2026 from `DECISIONS.md` (ground truth) plus research reports 04, 05, 06, 08, 12, 13,
r2-02, r2-04, r2-05 and r2-08. I also checked 07, 09, r2-10, r2-11, r2-15 and r3-keyframes for asset
licences, planet scale and the character/boss keyframes. Superseded report content (Zone Laws, Legend,
Continue Coin, Red Book, the Hunt, Glitch Flats/Bastion, level brackets, skulls, wanted systems,
downed state, the 8 old avatars, synthwave as the main look) is not carried forward. The last section
lists the conflicts.

**Tags:** (D) = DECISIONS.md. [05], [12], [r2-04], etc. = taken from that report. (new) = invented
here. Every number below is a starting value for the tuning sheet, not a measurement.
The models behind the tables were computed in this session. Section 1.1 gives the assumptions.

---

## 0. Global combat constants

| Constant | Value | Src |
|---|---|---|
| Move speed: run / sprint / swim | 6 / 9 / 3 m/s | [r2-10], [r2-11]; swim (new) |
| Dodge-roll (C key) | 4.5 m over 0.30 s; i-frames 0.05–0.30 s; cooldown 1.2 s; 100 ms input buffer | [05], [r2-05]; key (D) D1 |
| Fall damage | 0 up to 8 m; then 8% max HP per metre (lethal at ≥ 20.5 m); landing in water ≥ 1.5 m deep = 0 | (new) |
| Weak point / headshot | ×1.5 (Stillshot ×1.8); one multiplier per hit, no random crits | [05] |
| Friendly fire | On everywhere outside safe zones, including party, own explosives (self ×0.5) | (D); self ×0.5 (new) |
| Safe zones | All of Portus + a ring around every fast-travel pad (radius 12 m) (new radius); no damage in or out | (D) |
| Hit-stop (local only) | light 40 ms, heavy 80 ms, kill 120 ms, boss kill 400 ms | [r2-05] |
| Screen shake (trauma model) | 0.2 / 0.4 / 0.8; roll ≤ 2°; toggle in settings | [r2-05] |
| Damage numbers (colour-blind safe) | normal: white, regular size; weak point: yellow, 1.3× size + "!"; armour-reduced: grey, small; shield absorbed: cyan outline glyph | (new), per (D) settings rule |
| Telegraph floors (AI) | light ≥ 0.5 s; heavy ≥ 0.9 s; boss lethal-tier (≥ 40% HP) ≥ 1.2 s; recovery after a heavy ≥ 0.8 s | [12] |
| AI single-hit cap (code clamp) | regular/elite/beast ≤ 35% of target max HP; boss ≤ 60%; any AI sequence ≤ 80% within 1.5 s. PvP is not clamped | [12] |

---

## 1. Progression

### 1.1 Level curve (cap 20)

**Formula (new):** `XP_to_next(L) = round_to_5(50 × L^1.5)` for L = 1…19. Total to cap: **33,570 XP**.

**Model assumptions (new):** 2.5 effective kills/min including travel; tier mix ×1.15; on-level kill
XP `10 + 5E`; onboarding pays **50 XP** (3 dummies × 10 + 20 on completion), so **level 2 lands at
the end of the ~60 s tutorial**. That is also the moment the game offers "save your character" (D).
Mission XP is credited at the level it is usually done. Boss XP is excluded, so it only speeds things up.

| L | XP to next | Cumulative at start of L | Model XP/min | Min at this L | Reached at (min) |
|---:|---:|---:|---:|---:|---:|
| 1 | 50 | 0 | tutorial | 1.0 | 0.0 |
| 2 | 140 | 50 | 58 | 2.4 | 1.0 |
| 3 | 260 | 190 | 72 | 2.5 | 3.4 |
| 4 | 400 | 450 | 86 | 3.2 | 5.9 |
| 5 | 560 | 850 | 101 | 3.8 | **9.2** |
| 6 | 735 | 1,410 | 115 | 6.4 | 13.0 |
| 7 | 925 | 2,145 | 129 | 7.1 | 19.4 |
| 8 | 1,130 | 3,070 | 144 | 3.0 | 26.5 |
| 9 | 1,350 | 4,200 | 158 | 2.8 | 29.5 |
| 10 | 1,580 | 5,550 | 172 | 2.8 | 32.3 |
| 11 | 1,825 | 7,130 | 187 | 9.8 | 35.1 |
| 12 | 2,080 | 8,955 | 201 | 10.3 | 44.9 |
| 13 | 2,345 | 11,035 | 216 | 10.9 | 55.2 |
| 14 | 2,620 | 13,380 | 230 | 2.7 | 66.1 |
| 15 | 2,905 | 16,000 | 244 | 2.1 | 68.8 |
| 16 | 3,200 | 18,905 | 259 | 1.5 | 70.9 |
| 17 | 3,505 | 22,105 | 273 | 12.8 | 72.4 |
| 18 | 3,820 | 25,610 | 288 | 13.3 | 85.2 |
| 19 | 4,140 | 29,430 | 302 | 13.7 | 98.5 |
| 20 | cap | 33,570 | — | — | **112** |

Targets met: level 2 ≈ 1 min, level 5 ≈ 9–10 min (D). The cap takes about 2 h of focused play, which is
the top of the 60–120 min brief in [r2-05]. Boss kills shorten this. Retune with one knob: the 50 in
the formula.

### 1.2 XP per kill

`killXP = round(tierMult × (10 + 5E) × diffMult)`, where E = enemy level, L = player level, Δ = E − L.

| Tier | tierMult | E=1 | E=4 | E=7 | E=10 | E=13 | E=16 | E=20 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Critter (Woolback) | 0.3 | 4 | 9 | 14 | 18 | 22 | 27 | 33 |
| Regular | 1 | 15 | 30 | 45 | 60 | 75 | 90 | 110 |
| Heavy | 2 | 30 | 60 | 90 | 120 | 150 | 180 | 220 |
| Elite (camp leader) | 4 | 60 | 120 | 180 | 240 | 300 | 360 | 440 |
| Neutral beast | 10 | 150 | 300 | 450 | 600 | 750 | 900 | 1,100 |
| Boss (each eligible player) | 40 | — | — | — | — | — | — | — |

Boss XP at boss level: Tidewrath (L8) 2,000; Hollow King (L14) 3,200; The Receiver (L20) 4,400.

| Rule | Value | Src |
|---|---|---|
| diffMult | Δ ≥ +3: ×1.25 · −2…+2: ×1.0 · −3/−4: ×0.6 · ≤ −5: ×0.2 | adapted from [04] |
| Repeat-kill decay | same spawn point within 5 min: −10% per kill, floor 30% | [04] |
| Who gets XP | every player who dealt ≥ 20% of the enemy's max HP, or the killing blow (new) | (new) |
| PvP kill XP | `2 × (10 + 5 × victimLevel) × diffMult`; no coins (the victim's coins go into their pile) | (new) |
| Onboarding | 50 XP total | (new) |

### 1.3 HP and damage scaling

| Quantity | Formula | L1 | L6 | L12 | L20 | Src |
|---|---|---:|---:|---:|---:|---|
| Player max HP | `100 + 10(L−1)` | 100 | 150 | 210 | 290 | adapted [12] |
| Player damage mult | `1 + 0.03(L−1)` | 1.00 | 1.15 | 1.33 | 1.57 | [05] |
| Weapon tier mult | T1 / T2 / T3 = 1.00 / 1.35 / 1.75 (T3 sniper/bow trimmed, see 2.3) | | | | | (new) |
| Enemy HP mult | `1 + 0.12(E−1)` | 1.00 | 1.60 | 2.32 | 3.28 | adapted [12] |
| Enemy damage mult | `1 + 0.08(E−1)` | 1.00 | 1.40 | 1.88 | 2.52 | adapted [12] |

At equal level with the tier the gate allows (T1 at L1, T2 at L6, T3 at L12), player damage and player HP
grow together. PvP time-to-kill (TTK) therefore stays within about ±10% across all levels (see 2.5).
Enemy HP grows faster than player damage, so on-level PvE kills slow down by up to about 30% just
before each tier gate. That pushes players to buy the next tier.

### 1.4 Coins

| Source | Amount | Src |
|---|---|---|
| Kill (always drops, auto-credited to the top damage dealer) | `round(coinMult × (2 + 0.8E))`; coinMult: critter 0, regular 1, heavy 2, elite 5, beast 15 | shape [r2-05], formula (new) |
| Regular kill at E = 1 / 4 / 7 / 10 / 13 / 16 / 20 | 3 / 5 / 8 / 10 / 12 / 15 / 18 | computed |
| Elite kill at the same levels | 14 / 26 / 38 / 50 / 62 / 74 / 90 | computed |
| Camp chest (opens when the camp elite dies) | Blockyard 60 · Ossuary 150 · Checkpoint Seven 300 | (new) |
| Missions | see §5 (30–400 each, 1,630 total) | (new) |
| Boss purse (each eligible player) | Tidewrath 120 · Hollow King 300 · The Receiver 600 | [r2-05] scaled |
| Selling | see 1.5 | |

Modelled cumulative coins with zero spending: **315 at L6** (pays for a 300-coin T2 weapon), **1,648
at L12** (about 1,200 after T2 and tonics, enough for a 900-coin T3), **about 5,800 at L20**. Death
removes every coin (D), so prices are set for one life.

### 1.5 Portus shop: "Portus Exchange", keeper Juno Vale (new)

| Item | Price | Notes |
|---|---:|---|
| Small Tonic (potion) | 10 | +40 HP over 3 s; 0.4 s drink; move at 70% while drinking; stack 10; 8 s shared tonic cooldown; damage does not interrupt (new) |
| Large Tonic (potion) | 35 | +120 HP over 4 s; otherwise as above (new) |
| Weapon T1 / T2 / T3 (standard families) | 60 / 300 / 900 | [r2-05] |
| Stillshot Rifle, Comet Launcher T1 / T2 / T3 | 90 / 450 / 1,350 | ×1.5 heavy-weapon premium (new) |
| Scrapburst Grenade T1 / T2 / T3 (each) | 15 / 40 / 90 | (new) |
| Patchkit T1 / T2 / T3 (each) | 25 / 60 / 120 | (new) |
| Prism Bubble T1 / T2 / T3 | 120 / 400 / 1,000 | (new) |
| Radio | **100** | (D) |
| Horse (extra after the core) | 1,500 | lost on death (D); price (new) |
| Common cosmetics (5 items, §8.3) | 120 each | (new) |

Equipping still needs the level gate (T2 = L6, T3 = L12) (D). Anyone can buy, pick up or sell anything.

**Sell-back:** 25% of the shop price, rounded down, minimum 1 [r2-05]. Items the shop doesn't sell use
fixed values (new): Wool Tuft 2 · Wolf Pelt 8 · Bramblehorn Antler 120 · Fenstalker Plume 200 ·
Dunebreaker Scale 300 · cosmetics Common 30 / Uncommon 90 / Rare 250 / Legendary 500 · Ferryman's Oar 500.

---

## 2. Weapons

### 2.1 Data shape (catalog definition; instances are separate) — adapted from [05]

```ts
// weapons.json: one entry per family; tiers inline. Units: metres, seconds. No code in data. [05]
interface WeaponFamily {
  id: string;                 // "weapon.stillshot"
  name: string;               // display name; tier shown as "Stillshot Rifle II"
  class: "melee" | "magic" | "ranged" | "support" | "item";
  starterFor?: ("hexwick" | "brother_ash" | "kappa" | "unit7")[];
  tiers: WeaponTier[];        // length 3 (fists and radio: length 1)
  assets: { modelId: string; iconId: string; sfxSetId: string; vfxSetId: string };
  rights: { basis: "original" | "cc0" | "cc_by"; licenseId: string; manifestEntryId: string };
}
interface WeaponTier {
  tier: 1 | 2 | 3;
  minLevel: 1 | 6 | 12;       // equip gate (D)
  price: number;              // Portus Exchange; sell = floor(price * 0.25)
  attack: {
    kind: "melee_arc" | "hitscan" | "projectile" | "arc_projectile" | "chain" | "thrown" | "heal" | "deploy" | "none";
    damage: number;           // per hit / per pellet / per jump-0 / per explosion centre
    pellets?: number; spreadDeg?: number; adsSpreadDeg?: number;
    intervalS: number;        // onset to onset
    windupS?: number;
    rangeM: number;
    falloff?: { fullToM: number; minAtM: number; minMult: number };
    arcDeg?: number; maxTargets?: number;                       // melee
    projectile?: { speedMps: number; gravity: number; radiusM: number; maxRangeM: number };
    splash?: { radiusM: number; centreDamage: number; edgeMult: number; selfMult: number };
    chain?: { jumps: number; rangeM: number; mult: number };    // includes allies (friendly fire)
    dot?: { perS: number; durationS: number; stacks: false };
    weakPointMult: number;    // 1.5 default, 1.8 sniper, 1.0 explosives/melee
    knockbackM?: number;
    propMult?: number;        // damage multiplier vs breakable props (explosives 2)
  };
  limit:
    | { type: "magazine"; size: number; reloadS: number }
    | { type: "heat"; shotsToOverheat: number; lockoutS: 1.5; coolPerS: 35; coolDelayS: 0.5 }
    | { type: "stack"; max: number; useCooldownS: number }
    | { type: "cooldown"; s: number }
    | { type: "none" };
  alt?:                                         // right mouse button (D controls)
    | { kind: "ads"; zoom: number }
    | { kind: "scope"; zoom: number; glintAtM: 30 }
    | { kind: "block"; frontalDeg: 120; reduction: number; moveMult: 0.5 }
    | { kind: "charge"; chargeS: number; damage: number; radiusM?: number; cooldownS?: number }
    | { kind: "draw"; drawS: number; fullDamage: number; zoomAtFull: number }
    | { kind: "self_use" };
  destruction: "none" | "light" | "heavy";      // see 2.2
  moveMult?: number;                            // while held
  heal?: { pctMaxHp: number; overS: number; channelS: number; allyRangeM: number };
  bubble?: { radiusM: number; shellHpPer100MaxHp: number; durationS: number };
}
```

### 2.2 Shared weapon rules

- **Damage dealt** = `tierDamage × (1 + 0.03(L−1)) × weakPoint × falloff × (1 − armour)`. Armour only
  appears where an enemy row lists it (Enforcer shield, boss armour states). (new)
- **Reload:** auto-reload on empty plus **R**. R is not in the (D) control list; log it as a run decision. (new)
- **Inventory:** 4 hotbar slots (keys 1–4) + 16 backpack slots (D). Stacks: tonic 10, Patchkit 5,
  grenade 5. **Fists** are used when the selected hotbar slot is empty. (new)
- **Ammo:** none. Magic uses heat; guns use magazines with free reloads. This keeps the economy to
  coins only. (new)
- **Destruction classes (new) under (D) rules:**
  - Light breaks crates, barrels and fences.
  - Heavy breaks everything breakable. Heavy covers explosives, heavy weapons and spells.

| Breakable prop | Where | HP (fixed) | Broken by | Rebuild |
|---|---|---:|---|---|
| Crate, barrel | all planets | 40 | light or heavy | 180 s |
| Fence segment (2 m) | farms, camps | 60 | light or heavy | 180 s |
| Fuel drum (new) | Meridian camps | 30 | any hit; explodes for 25% max HP at centre → 8% at 3.5 m | 240 s |
| Statue | ruins, plazas (never Portus) | 300 | heavy | 300 s |
| Pillar | ruins, chapels | 500 | heavy | 300 s |
| Camp wall (4 m segment) | Blockyard, Ossuary, Checkpoint Seven | 600 | heavy | 300 s |
| Boss-arena cover | see §4 | per boss | heavy + boss attacks | 180 s, or instantly on boss reset |

Ground, mountains and Portus buildings never break. The server decides breaks; debris fades after
about 10 s (D).

### 2.3 Weapon table (every family × 3 tiers)

Damage is the base value at L1 before the level multiplier. "Rate" is seconds between attacks.
Heat = shots until a 1.5 s overheat lockout. Explosions fall off linearly from the centre to 25% at the edge.

| Weapon (class) | T | Lv | Damage | Rate s | Range | Delivery | Limit | Special / alt (RMB) | Destr. | Price |
|---|---|---|---|---|---|---|---|---|---|---|
| **Fists** (melee) | – | 1 | 8 | 0.40 | 1.6 m | melee arc 70°, 1 target | none | knockback 0.5 m; always available | none | – |
| **Sunbrand** energy blade (melee) | I | 1 | 18 | 0.45 | 2.4 m | melee arc 110°, ≤ 3 targets, windup 0.12 | none | RMB block 70% (frontal 120°: melee, bolts, hitscan), move ×0.5 | light | 60 |
| | II | 6 | 24 | 0.45 | 2.4 m | same | none | block 75% | light | 300 |
| | III | 12 | 31 | 0.45 | 2.4 m | same | none | block 80% | light | 900 |
| **Riverstaff** bo staff (melee) | I | 1 | 13 | 0.40 | 3.0 m | melee arc 150°, ≤ 4 targets, windup 0.10 | none | every 3rd hit in a row knocks back 3.0 m; RMB block 50% | light | 60 |
| | II | 6 | 18 | 0.40 | 3.0 m | same | none | knockback 3.5 m; block 55% | light | 300 |
| | III | 12 | 23 | 0.40 | 3.0 m | same | none | knockback 4.0 m; block 60% | light | 900 |
| **Bearded Axe** (melee) | I | 1 | 30 | 0.80 | 2.2 m | melee arc 90°, ≤ 2 targets, windup 0.25 | none | RMB charge 0.8 s heavy chop 66 (heavy destruction) | light / heavy on chop | 60 |
| | II | 6 | 41 | 0.80 | 2.2 m | same | none | chop 0.75 s → 90 | same | 300 |
| | III | 12 | 52 | 0.80 | 2.2 m | same | none | chop 0.70 s → 114 | same | 900 |
| **Quarry Hammer** (melee) | I | 1 | 40 | 1.10 | 2.3 m | melee arc 100°, ≤ 3 targets, windup 0.35; move ×0.9 | none | RMB charge 1.0 s ground slam 55, radius 3.0 m (edge 50%), knock-up 1 m, 6 s cooldown | heavy | 60 |
| | II | 6 | 54 | 1.10 | 2.3 m | same | none | slam 74, r 3.5 m | heavy | 300 |
| | III | 12 | 70 | 1.10 | 2.3 m | same | none | slam 96, r 4.0 m | heavy | 900 |
| **Hexquill** wand (magic) | I | 1 | 15 | 0.40 | 40 m | projectile 45 m/s, straight | heat 12 | RMB aim 1.3×; bolts pierce 0 | light | 60 |
| | II | 6 | 20 | 0.40 | 40 m | same | heat 14 | pierce 1 | light | 300 |
| | III | 12 | 26 | 0.40 | 40 m | same | heat 16 | pierce 2 | light | 900 |
| **Emberglass Staff** fire staff (magic) | I | 1 | 24 direct; splash 12 in 2.0 m; burn 4/s × 3 s | 0.80 | 35 m | projectile 28 m/s, straight | heat 5 | burn refreshes, never stacks; RMB aim 1.3× | heavy | 60 |
| | II | 6 | 32; splash 16 in 2.5 m; burn 5/s | 0.80 | 35 m | same | heat 6 | | heavy | 300 |
| | III | 12 | 42; splash 21 in 3.0 m; burn 7/s | 0.80 | 35 m | same | heat 7 | | heavy | 900 |
| **Stormcoil** chain-lightning caster (magic) | I | 1 | 20 first target; ×0.7 per jump | 0.70 | 22 m to first target; jumps 6 m | hitscan + chain, 2 jumps | heat 6 | jumps to the nearest damageable entity, **including allies**; never the caster; never the same target twice | heavy | 60 |
| | II | 6 | 27 | 0.70 | same | 3 jumps | heat 7 | | heavy | 300 |
| | III | 12 | 35 | 0.70 | same | 4 jumps | heat 8 | | heavy | 900 |
| **Pocket Carbine** blaster (ranged) | I | 1 | 9 | 0.25 | full to 25 m, 60% at 45 m | hitscan + bolt tracer; hip 1.5°, ADS 0.3° | mag 24, reload 1.4 s | RMB ADS 1.4× | light | 60 |
| | II | 6 | 12 | 0.25 | same | same | mag 28, 1.3 s | | light | 300 |
| | III | 12 | 16 | 0.25 | same | same | mag 32, 1.2 s | | light | 900 |
| **Scatterpipe** shotgun (ranged) | I | 1 | 7 pellets × 6 | 0.90 | full to 10 m, 30% at 22 m | hitscan pellets, 7° cone (ADS 5°) | mag 6, reload 2.0 s | | light | 60 |
| | II | 6 | 7 × 8 | 0.90 | same | same | mag 7, 1.8 s | | light | 300 |
| | III | 12 | 7 × 10 | 0.90 | same | same | mag 8, 1.6 s | | light | 900 |
| **Yew Longbow** (ranged) | I | 1 | tap 15; full draw 45 | tap 0.5; draw 1.0 + 0.35 recovery | ~100 m arc | arcing projectile, 25 → 55 m/s by draw, gravity 9.8 | none | hold RMB to draw (zoom 1.8× at full), LMB to loose; head ×1.5 | light | 60 |
| | II | 6 | 20; 61 | draw 0.9 | same | same | none | | light | 300 |
| | III | 12 | 25; 75 | draw 0.8 | same | same | none | T3 full draw trimmed from 79 to 75 so two body hits never kill at the L12 gate | light | 900 |
| **Stillshot Rifle** sniper (ranged) | I | 1 | 45 body; head ×1.8 = 81 | 1.40 | 150 m, no falloff | hitscan; unscoped spread 4°, scoped 0° | mag 4, reload 2.2 s | RMB scope 4×; lens glint visible to anyone ≥ 30 m away while scoped | light | 90 |
| | II | 6 | 61 (head 110) | 1.40 | same | same | mag 5, 2.0 s | scope 5× | light | 450 |
| | III | 12 | 75 (head 135) | 1.40 | same | same | mag 5, 1.8 s | scope 6× (75, not 79, to keep 3 body shots) | light | 1,350 |
| **Comet Launcher** rocket (ranged) | I | 1 | direct 70 total; splash 45 at centre, r 3.5 m | 1.80 (reload) | detonates at 80 m | projectile 30 m/s, straight | mag 1, reload 1.8 s | knockback 4 m; self ×0.5; move ×0.85; props ×2 | heavy | 90 |
| | II | 6 | 95; splash 61, r 4.0 m | 1.70 | same | same | reload 1.7 s | | heavy | 450 |
| | III | 12 | 123; splash 79, r 4.5 m | 1.60 | same | same | reload 1.6 s | | heavy | 1,350 |
| **Scrapburst Grenade** (support) | I | 1 | 70 at centre, r 4.0 m | 0.8 throw cooldown | ~20 m throw | thrown arc 18 m/s, bounces, fuse 1.6 s | stack 5 | self ×0.5; props ×2 | heavy | 15 ea |
| | II | 6 | 95, r 4.5 m | 0.8 | same | fuse 1.5 s | stack 5 | | heavy | 40 ea |
| | III | 12 | 123, r 5.0 m | 0.8 | same | fuse 1.4 s | stack 5 | | heavy | 90 ea |
| **Patchkit** heal kit (support) | I | 1 | heals 30% of the target's max HP over 2 s | 1.0 channel; 6 s shared cooldown | ally ≤ 4 m in crosshair (LMB) or self (RMB) | heal | stack 5 | damage during the channel cancels it (kit kept); heals anyone, strangers included | none | 25 ea |
| | II | 6 | 40% | 0.9 channel | same | | stack 5 | | none | 60 ea |
| | III | 12 | 50% | 0.8 channel | same | | stack 5 | | none | 120 ea |
| **Prism Bubble** shield bubble (support) | I | 1 | shell HP 150 per 100 owner max HP | cooldown 25 s | sphere r 3.0 m at feet, lasts 6 s | deploy | cooldown (item kept) | blocks hitscan, projectiles and splash crossing the shell either way; melee and walking pass through; boss split circles ignore it | none | 120 |
| | II | 6 | 200 per 100 max HP | 22 s | r 3.5 m, 7 s | | | | none | 400 |
| | III | 12 | 260 per 100 max HP | 20 s | r 4.0 m, 8 s | | | | none | 1,000 |
| **Radio** (item) | – | 1 | – | – | same planet, any distance | channels 1–9, talk on B, crackle filter, max 8 per channel | – | drops on death | none | **100** (D) |

### 2.4 Starter weapons (D)

| Character | Starter weapon | Also always has |
|---|---|---|
| Hexwick | Hexquill I | Fists |
| Brother Ash | Sunbrand I | Fists |
| Kappa | Riverstaff I (bo staff) | Fists |
| Unit 7 | Pocket Carbine I (the blaster family) | Fists |

On rebirth: level 1, the chosen starter's T1 weapon, 0 coins (D).

### 2.5 PvP time-to-kill target and check

**Target (new):** at equal level with the gated tier and 100% accuracy:
- **2.2–3.5 s** for sustained weapons.
- **1.4–1.8 s floor** for burst weapons that need a headshot, a direct rocket hit or point-blank pellets.
- **No one-shot kills at equal level.** The largest single hit is a Stillshot headshot at 73–86% of
  the target's HP.

Higher-level or higher-tier attackers can one-shot weaker players. That is accepted, because (D) allows
any level against any level.

| Weapon (all hits land, body unless stated) | L1 T1 | L6 T2 | L12 T3 | L20 T3 | L20 with T1 (under-geared) |
|---|---|---|---|---|---|
| Fists | 4.8 s / 13 | 6.4 / 17 | 7.6 / 20 | 9.2 / 24 | 9.2 / 24 |
| Sunbrand | 2.25 / 6 | 2.25 / 6 | 2.25 / 6 | 2.25 / 6 | 4.5 / 11 |
| Riverstaff | 2.8 / 8 | 2.8 / 8 | 2.4 / 7 | 3.2 / 9 | 5.6 / 15 |
| Bearded Axe | 2.4 / 4 | 2.4 / 4 | 2.4 / 4 | 2.4 / 4 | 4.8 / 7 |
| Quarry Hammer | 2.2 / 3 | 2.2 / 3 | 2.2 / 3 | 2.2 / 3 | 4.4 / 5 |
| Hexquill | 2.4 / 7 | 2.4 / 7 | 2.4 / 7 | 2.8 / 8 | 6.3 / 13 |
| Emberglass Staff (direct + burn) | 2.4 / 4 | 2.4 / 4 | 2.4 / 4 | 2.4 / 4 | 6.3 / 7 |
| Stormcoil (first target) | 2.8 / 5 | 2.8 / 5 | 2.8 / 5 | 3.5 / 6 | 7.8 / 10 |
| Pocket Carbine | 2.75 / 12 | 2.5 / 11 | 2.25 / 10 | 2.75 / 12 | 5.0 / 21 |
| Scatterpipe (all 7 pellets, ≤ 10 m) | 1.8 / 3 | 1.8 / 3 | 1.8 / 3 | 1.8 / 3 | 3.6 / 5 |
| Yew Longbow (full draws, first one pre-drawn) | 2.7 / 3 | 2.5 / 3 | 2.3 / 3 | 2.3 / 3 | 5.4 / 5 |
| Stillshot Rifle, body / head + body | 2.8 / 3 · 1.4 / 2 | same | same | same | 7.8 / 5 |
| Comet Launcher (direct hits) | 1.8 / 2 | 1.7 / 2 | 1.6 / 2 | 1.6 / 2 | 3.6 / 3 |

Format: seconds from the first hit / hits needed. PvE comparison: a regular L1 enemy with 22–60 HP dies to
the Pocket Carbine in 0.5–1.5 s, inside [05]'s 1.1–1.8 s band. Build a headless sim that fails the
build if any weapon's TTK leaves 0.6–1.6× of its class median [04].

---

## 3. Enemies and wildlife

### 3.1 Shared enemy rules

| Rule | Value | Src |
|---|---|---|
| Level | fixed per spawn area (tables below), not clamped per player, because the world is shared | (new); replaces [12] clamping |
| Spawn | 1 s materialise as light particles; no damage while materialising | [12], (D) look |
| Attack tokens on one player | 2 melee + 2 ranged (Arcadia, Hollowmere); 2 + 3 (Meridian); each held ≤ 1.5 s, released on a 0.4 s stagger | [12] |
| Perception | sight cone 90°, 25 m (Associates 35 m); hearing 12 m; gunfire is a 30 m noise event; pack mates within 15 m share the target | [12] |
| Leash | 45 m from anchor, or 20 s without line of sight, or 5 s with the target where the NPC can't reach it (inside a pad's safe ring, or out of its medium) and out of its ranged attacks; then EVADE: invulnerable, runs home at 1.5× speed, heals fully. Entering a safe zone drops all aggro instantly | [12], (new) |
| Respawn | pack 120 s after clear (×2 while a player is within 60 m); camp 300 s; neutral beast 15 min; boss 10 min (D). Timers are per copy and survive the copy emptying and server restarts | [12], (new) |
| Telegraph language | colour + shape + sound, never colour alone: red wedge = dodge; amber line = ranged lock; teal ring = step out; white flash = projectile launch | [12] |
| Death | dissolves into light particles; coins auto-credited; item drops appear as a small glowing pickup | (D) look, (new) |

Stat columns below: HP and damage are shown at the minimum–maximum level of the range. They are
computed from the L1 base (HP1 / DMG1 in brackets) with the 1.3 scaling. "%" is the largest hit as a
share of an on-level player's HP at the maximum level (cap 35%).

### 3.2 Arcadia (R 500 m, 12 pads, levels ~1–7): the Brightbits (new)

**Faction look:** chunky voxel bodies of 16 cubes per edge, 4-colour palettes per creature, hard 90°
movement, and they burst into square light-pixels on death. Avoid [12]:
- yellow wedge-mouth circles, domed ghosts with wavy skirts (Pac-Man)
- crab/squid invader silhouettes (Space Invaders), barrels thrown by an ape
- segmented centipedes in mushroom fields
- 4-square falling-block shapes (Tetris trade dress)
- green four-legged exploding cubes and bouncing translucent green slime cubes (Minecraft)

| Area | Type | Enemy Lv | Spawns |
|---|---|---|---|
| Dawnpad (main pad, guide Lark) | safe ring | – | none |
| Clover Fields | fields | 1–3 | Hopbit packs; Woolback herds (4–8); Golden Hopbit in 1 of 25 packs (egg E3) |
| Lacefall | waterfall | 2–4 | Woolbacks; 1–2 Sparkflies (egg E1) |
| Pinewhistle Wood | forest | 2–5 | Sparkfly 2–3; Dusk Wolves L3–6 |
| Glasswater Lake shore + Gull Point | lake / boss lair | 3–6 | Sparkfly + Bomblet pairs; Tidewrath L8 |
| Highscore Hill | voxel-ruin flats | 3–7 | Linewyrm 1–2; Pixel Lancer + 4 Hopbits (egg E2) |
| Kestrel Peak slopes | mountain | 4–7 | Dusk Wolves 4–5; Bramblehorn L8 roams slopes and fields |
| Blockyard Camp | walled enemy camp | 5–7 | Cabinet Golem + 2 Pixel Lancers + 2 Bomblets + 4 Hopbits; camp chest |

| Enemy | Tier | Lv | HP | Attacks: damage (telegraph) | Behaviour | Pack | Drops |
|---|---|---|---|---|---|---|---|
| Hopbit | Regular | 1–4 | 22–30 (22) | contact 6–7 (squashes flat 0.4 s before each hop) | hops a 1 m grid at 4 m/s, never diagonally; dies to 1–2 hits | 4–6 | coins; Small Tonic 1/10 |
| Sparkfly | Regular | 2–6 | 34–48 (30) | pellet 9–11 (body flashes white 0.5 s; pellet visible, 12 m/s), every 2.0 s | hovers 8–12 m away, strafes in 90° steps | 2–3 | coins; tonic 1/10 |
| Linewyrm | Regular | 3–7 | ≈ 112–155 total (head 37–52 + 5 segments of 15–21 each, rounded) | head contact 12–15 (head turns red 0.5 s, then an 8 m/s dash for 3 s); 9% | only the head hurts; each body segment destroyed shortens it; dies when the head dies | 1–2 | coins; grenade 1/25 |
| Bomblet | Regular | 3–7 | 43–60 (35) | lobbed bomb 16–21 in a 3 m circle (ground circle 1.2 s), every 3.0 s; 13% | keeps 15–20 m; backs away when approached | 2 | coins; grenade 1/25 |
| Pixel Lancer | Heavy | 4–7 | 102–129 (75) | poke 12–15 (0.5 s); charge 30–36 (1.0 s two-frame "rev" + ground line along the path), 12 m/s; 22% | lines up, then charges; stunned 1.5 s on hitting an obstacle (punish window) | 1 + Hopbits | coins ×2; weapon 1/15 |
| Cabinet Golem | Elite | 6–7 | 416–447 (260) | slam ring 4 m, 39–41 (0.9 s raised fists + teal ring); coin-cube toss 3 × 17–18 (screen face flashes 0.6 s); 26% | walking arcade-cabinet golem with a glowing screen face; guards the camp chest | 1 per camp | coins ×5; weapon 1/4; opens camp chest (1 weapon, 2 tonics, 60 coins, Voxel Visor 1/10) |

### 3.3 Hollowmere (R 750 m, 12 pads, levels ~6–13): the Hollow Court

**Faction look [12]:** bone-white with teal grave-light, chain and candle motifs. Avoid D&D
product-identity monsters and the crowned-helm/runeblade "Lich King" silhouette.

| Area | Type | Enemy Lv | Spawns |
|---|---|---|---|
| Lanternfall (main pad, guide Sexton Mabry) | safe ring | – | none |
| Whisper Fen | marsh | 6–9 | Marsh Wisps 4–6; Gnawers 2–3; bog Woolbacks (egg E4) |
| Saint Orrin's ruin | ruined chapel | 7–10 | Bonewalkers 2–3; Bone Archers 2 (egg E6) |
| Thornwood | forest | 7–10 | Gnawers 3–4; Dusk Wolves L8–12 |
| Drowned Chapel | flooded ruin | 8–11 | Bonewalkers 3 + Bone Archer 1; Crypt Sentinel (L10) at the altar (egg E5) |
| Mourning Mere | lake | 9–12 | Marsh Wisps; Fenstalker L14 wades the shallows |
| Ossuary Camp | walled camp on the causeway to the Nave | 10–13 | 2 Cantors + 4 Bonewalkers + 2 Bone Archers + Crypt Sentinel at the gate; camp chest |
| Tolling Tower approach | ridge | 11–13 | Bone Archers; Gnawers |
| The Hollow Nave | boss lair (ruined cathedral) | 14 | the Hollow King |

| Enemy | Tier | Lv | HP | Attacks: damage (telegraph) | Behaviour | Pack | Drops |
|---|---|---|---|---|---|---|---|
| Bonewalker | Regular | 6–11 | 88–121 (55) | slash 11–14 (0.6 s); overhead 28–36 (0.9 s teal blade glow + ground wedge); 18% | 2.5 m/s; flanks in pairs; holds an attack token before swinging | 3–4 | coins; tonic 1/12 |
| Bone Archer | Regular | 6–12 | 61–88 (38) | arrow 15–21 (0.8 s draw, glowing tip), 30 m/s arcing; 10% | keeps 20–25 m on high ground; relocates when approached within 8 m | 2 | coins; weapon 1/40 |
| Gnawer (ghoul) | Regular | 7–12 | 65–88 (38) | bite 13–17 (0.5 s); leap 27–34 (0.7 s crouch + screech + landing decal), from 5 m; 16% | 6 m/s; circles, then leaps; low HP | 2–4 | coins |
| Cantor | Regular (kill first) | 8–13 | 92–122 (50) | grave bolt 19–24 (0.8 s, slow 10 m/s); 11% | keeps 10 m; raises 1 Bonewalker from a bone pile every 8 s (1.5 s channel with a visible beam; any hit cancels it; max 3 alive); bone piles break to heavy damage | 1 per pack | coins; weapon 1/40 |
| Marsh Wisp | Regular (fragile) | 6–13 | 24–37 (15) | touch 8–12 + Chill (−20% move for 2 s) (brightens 0.5 s before a lunge); 5% | drifts at 3 m/s toward lights and players; scatters for 5 s from any explosion | 4–6 | coins (half) |
| Crypt Sentinel | Elite | 10–13 | 354–415 (170) | shield bash 28–31 (0.7 s, ground wedge); mace slam 45–51 (1.2 s raised mace + expanding 4 m ring), 1.0 s recovery; 23% | 2 m/s; immune to knockback; guards gates and altars | 1 per post | coins ×5; weapon 1/4; opens Ossuary chest (1 weapon, 2 tonics, 150 coins) |

### 3.4 Meridian (R 1,000 m, 20 pads, levels ~12–20): Meridian Oversight

**Faction look [12]:** slate-grey segmented hardsuits, amber single-slit visors, a hexagonal
corporate glyph, matte finish. Radio barks are passive-aggressive corporate speak, for example
"Asset non-compliant. Escalating." The rank-and-file **Associates are identical clones**: one model,
one helmet, one stance, and only the stencilled ticket number on the shoulder changes (new). Avoid the
Sixers' black-and-grey "6" look, IOI branding and Sorrento-like leaders [12].

| Area | Type | Enemy Lv | Spawns |
|---|---|---|---|
| Waystation Nine (main pad, guide Rook Calder) | safe ring | – | none |
| Cinder Canyons | red canyons | 12–15 | Associate squads of 3 + 1 Collector; Dusk Wolves L14–19 |
| Brinewater Lake | lake | 13–16 | Collector patrols; salt Woolbacks |
| Glasspan Salt Flats | salt lake | 13–17 | Auditor pairs; Dunebreaker L20 |
| Checkpoint Seven | walled camp on the road to the Yard | 14–17 | 6 Associates, 2 Enforcers, 2 Collectors, a Compliance Officer; fuel drums; camp chest (egg E9) |
| Chrome Spires / Oversight Lobby | towers | 15–19 | Associates 4, Enforcers 2, Auditors 2 (egg E7) |
| The Last Billboard mesa | landmark | 16–18 | Auditor pair (egg E8) |
| Foreclosure Yard approach | lair approach | 18–20 | Enforcers, Associates, a Compliance Officer |
| Foreclosure Yard | boss lair | 20 | The Receiver |

| Enemy | Tier | Lv | HP | Attacks: damage (telegraph) | Behaviour | Pack | Drops |
|---|---|---|---|---|---|---|---|
| Associate (clone trooper) | Regular | 12–18 | 116–152 (50) | 3-round burst, 9–12 per round (a thin amber laser settles on the target for 0.5 s first); 13% per burst | uses navmesh cover points; holds one of the ranged tokens; relocates when flanked; bark "Asset located." | 3–4 | coins; Large Tonic 1/12 |
| Enforcer | Heavy | 13–19 | 244–316 (100) + riot shield 171–221 (70) | shove 25–32 + 3 m knockback (0.6 s, shield raises); baton 20–24 (0.5 s); 11% | the shield blocks 100% of frontal damage until broken (cracks visibly at 50%); advances slowly beside Associates; flank it or break the shield | 1–2 | coins ×2; weapon 1/15 |
| Collector (drone) | Regular (support) | 12–20 | 51–72 (22) | taser 9–13 (0.4 s visible charge arc); Tag: 1.0 s scan cone, then the target takes +25% damage from Oversight units for 5 s | flies 6 m/s, about 6 m up; shoot it first | 1–2 | coins |
| Auditor (drone) | Regular (artillery) | 14–20 | 102–131 (40) | 3 mortar shells, 27–33 each in 3 m circles (ground circles 1.2 s), every 5 s; 11% | hovers 15 m up and 20–30 m away; retreats from close range | 2 | coins; grenade 1/25 |
| Compliance Officer | Elite | 16–20 | 392–459 (140) | pistol 29–33 (0.5 s laser); Cease-and-Desist field: grenade arc 1.2 s, then a 4 m dome for 3 s that disables sprint and dodge (walking still works); 11% | buffs Oversight units within 15 m by +15% damage (shown as an amber outline); kill it to drop the buff | 1 per camp | coins ×5; weapon 1/4; opens Checkpoint chest (1 weapon, 2 tonics, 300 coins) |

### 3.5 Wildlife (every planet)

| Animal | Tier | Lv by planet (A / H / M) | HP | Attacks: damage (telegraph) | Behaviour | Group | Spawns | Drops |
|---|---|---|---|---|---|---|---|---|
| **Woolback** (D) | Critter | 1–2 / 6 / 12 | 30 / 48 / 70 | **buck: fixed 2 + 2 m knockback** (rears up 0.4 s); 10% chance when struck | harmless grazer; flees at 5 m/s when hit; regroups after 20 s. Colour per planet: cream (A), peat-brown (H), salt-white (M) (new) | herd 4–8 | fields, farm pens | Wool Tuft 100% (sells for 2); Woolback Plushie 1/300 |
| **Dusk Wolf** (D) | Regular | 3–6 / 8–12 / 14–19 | 52–67 / 77–97 / 108–133 (42) | bite 9–20 (0.5 s); lunge 20–41 (0.8 s crouch + snarl + line decal); 16% | pack howl (1.5 s) before engaging. They circle at 6–8 m: one feints in front while two bite from the flanks. A wolf at < 25% HP flees if fewer than 2 pack mates remain | pack 3–5 | forests, ridges, canyon rims | Wolf Pelt 50% (8); Wolfpelt Cape 1/200 |
| **Bramblehorn** (new) | Neutral beast | Arcadia L8 | 1,656 (900) | antler charge 50 (1.2 s head lowered + ground line); stomp 34, 4 m ring (1.0 s); 29% | 6 m tall mossy grazer with flowering, branching antlers. Neutral until struck, then fights the attacker; leash 40 m | 1 per copy | Clover Fields, Kestrel slopes | 126 coins; Bramblehorn Antler 100% (120); Antler Crown 1/8; weapon T2 1/2 |
| **Fenstalker** (new) | Neutral beast | Hollowmere L14 | 2,560 (1,000) | beak spear 78 (0.9 s neck coil + line); wing buffet 41 + 5 m knockback in a 90° cone, 6 m (1.0 s wings spread); 34% | 7 m stilt-legged wading bird, grey-violet plumage; neutral; spears from the water's edge | 1 per copy | Mourning Mere shallows | 198 coins; Fenstalker Plume 100% (200); Heron Plume Hat 1/8; weapon T3 1/2 |
| **Dunebreaker** (new) | Neutral beast | Meridian L20 | 3,936 (1,200) | roll charge 101 (1.2 s curl-up + dust line 25 m long); tail swipe 66 in a 120° cone, 5 m (0.8 s); 35% | armoured, salt-crusted canyon roller; neutral; rolls in straight lines and is stunned 2 s at the end of each roll | 1 per copy | Glasspan Salt Flats | 270 coins; Dunebreaker Scale 100% (300); Saltplate Mantle 1/8; weapon T3 1/2 |

### 3.6 Drop tables (rolled for the top damage dealer) (new; rates from [r2-05])

| Roll | Rate |
|---|---|
| Coins | always (formula in 1.4) |
| Weapon (any of 15 families, excluding fists and radio, uniform) | regular 1/40 · heavy 1/15 · elite 1/4 · camp chest 1 |
| Weapon tier by enemy level | E ≤ 5: T1 · E 6–11: T1 30% / T2 70% · E ≥ 12: T2 40% / T3 60% |
| Tonic | Arcadia Small Tonic 1/10; Hollowmere and Meridian Large Tonic 1/12 |
| Scrapburst Grenade (tier as weapon) | 1/25 from listed enemies |
| Planet cosmetic (any enemy on that planet) | Arcadia Messenger's Winged Cap 1/150 · Hollowmere Crowbeak Mask 1/100 · Meridian Hard Hat (Oversight Issue) 1/75; guaranteed after 3× the expected kills in one life (pity) |

---

## 4. Bosses

### 4.1 Shared boss rules

| Rule | Value | Src |
|---|---|---|
| Availability | always up; respawns **10 min** after a kill, separately in each world copy | (D) |
| HP formula | `HP(n) = HP₂ × (1 + 0.35 × (max(n, 2) − 2))`. n = players alive inside the arena boundary plus anyone who damaged the boss in the last 10 s (any party), recounted on every change; current HP keeps its percentage; n capped at 8. The boss targets the same players. Hits from outside the boundary count only from within 10 m of it and only while someone is inside | (D), (new) |
| Solo | impossible by design: each boss has a mechanic that needs two bodies in two places, or two bodies in one circle | (D), [r2-05] |
| Hints | none: no UI, NPC or voice line explains a mechanic (D). Telegraphs are still fully readable | (D) |
| Reset | no player in the arena for 30 s → full HP, cover rebuilds. An engaged fight survives its room closing or a restart until then | (new) |
| Damage cap | boss single hit ≤ 60% of the target's max HP after all modifiers; split circles are designed to deal exactly 60% each with 2 players | [12], [r2-05] |
| Loot eligibility | alive in the arena at the kill **and** either you contributed (≥ 50% of an equal damage share, held a plate during an opened window, or stood in a split circle) **or** a party member did (party shares boss credit) | [r2-05], (D) |
| Loot delivery | personal: every eligible player rolls their own table; items go into the inventory, and overflow drops at their feet as a normal pile | (D), (new) |
| Voice | 3 lines per boss (engage, phase 2, defeat), ≤ 60 characters. Heard within 120 m; subtitles as `NAME: line`, bottom centre, ≥ 3.5 s on screen | (D), (new) |
| Hall of Firsts | the first kill of each boss engraves every eligible player's name (new; (D) only lists eggs) | (new) |

### 4.2 Tidewrath, Arcadia (lake kaiju, level 8)

**Look:**
- Low, horizontal four-legged sea reptile: crocodilian snout, turtle-like shell of black volcanic stone
  and coral, a crown of branching coral spikes, glowing cyan vents, and one exposed cyan weak point on
  the chest [r3 keyframe].
- Roar: a deep whale-foghorn [r2-04].
- Avoid [r2-04]: an upright charcoal saurian, glowing leaf-shaped back plates, a blue mouth beam, the
  famous roar, and any "-zilla" name.

**Arena:** Glasswater Lake, Gull Point shore. The playable shore is a strip 70 m long and 25 m deep;
Tidewrath stays in the shallows 10–25 m out.

| Item | Value |
|---|---|
| HP₂ | **12,000** (n = 3: 16,200 · n = 4: 20,400). Modelled 2-player kill ≈ 4.7 min with two L7 players on T2 weapons |
| Armour | takes **20%** damage except while Moored |
| **Co-op: Moored** | Two **Tide Stones** (glowing shore plates, 2 m across) sit **30 m apart** (≥ 25 m rule). Both occupied for **3 s** together → Tidewrath is Moored for **8 s**: it slumps, the chest vent opens and takes **×1.5** (100% elsewhere). Stones then go dark for 12 s. A solo player can't hold both |
| Anti-solo | +0.25% max HP/s regeneration whenever no Moor has happened in the last 45 s |
| Breakable cover | 6 **Coral Pillars** on the shore (HP 400 each, heavy destruction or boss hits). They block Brine Spit, Steam Vents and the Tide Surge for anyone directly behind |

| Phase | Trigger | Attacks: damage at L8 (telegraph) |
|---|---|---|
| P1 "Rising" | 100–60% | **Tail Slam**: a 15 × 6 m line on the shore, 70 dmg + 4 m knockback (1.2 s: tail rises, foam-line decal). **Brine Spit**: 3 lobbed globs on 3 players (or 3 around one), 3 m circles, 35 each (1.2 s). **Tide Surge** every 30 s: the lake recedes, then a wave sweeps the shore band 0–20 m from the water, 50 dmg + pushes 6 m inland; cover and high rocks protect (1.5 s: water pulls back + roar) |
| P2 "Undertow" | 60–25% | All P1 attacks, plus **Steam Vents**: a 60° cone at one target, 20 dmg per 0.5 s for 2 s, max 80 (1.0 s vents glow + hiss). **Undertow**: an 8 m whirlpool in the shallows pulls 2 m/s for 4 s, 10 dmg/s inside (1.0 s swirl) |
| P3 "Riptide" | < 25% | All attacks; cooldowns −25% (telegraphs stay at their floors); Tide Surge every 20 s and each surge smashes one Coral Pillar |

| Loot (each eligible player) | |
|---|---|
| Always | 120 coins · 2,000 XP · 1 random T2 weapon · 2 Large Tonics |
| 1/6 | Coral Crown (Rare hat) or Tide Cape (Rare cape), 50/50 |
| 1/25 | Tidewrath Tooth (Legendary backpack) |

| Voice line (≤ 60 chars) | Trigger |
|---|---|
| "The lake was quiet. You woke it." (32) | engage |
| "Every tide comes back. So do I." (31) | phase 2 |
| "The water... remembers you." (27) | defeat |

### 4.3 The Hollow King, Hollowmere (level 14)

**Look (new):**
- A gaunt 4 m figure in tattered violet funeral robes.
- A cage-crown of bone spires hung with small funeral bells. The face is hidden by a veil of hanging
  chains. Carries a bone sceptre topped with a bell.
- Avoid: a crowned plate helm, a runeblade, a frost palette (Lich King) [12].

**Arena:** the Hollow Nave, a ruined cathedral 50 × 30 m.

| Item | Value |
|---|---|
| HP₂ | **28,000** (n = 3: 37,800 · n = 4: 47,600). Modelled 2-player kill ≈ 5.2 min with two L13 players on T3 weapons |
| **Co-op: Royal Judgement** | Every 20 s (P2 18 s, P3 15 s): a **4 m cursed circle** marks one player's position (2.0 s telegraph: a crown sigil falls, a bell tolls three times, a countdown ring). Detonation deals **276 true damage (120% of a L14 player's HP), split equally among players inside**. An **empty circle deals 276 to every player in the arena**. One player inside dies; two take 138 each (60%); three take 92. The damage ignores block, Prism Bubble and i-frames, so solo is impossible |
| Breakable cover | 8 stone **Pillars** (HP 600, heavy only). A broken pillar topples along a line (1.0 s creak + dust line): 80 to anyone under it. If it hits the King: 1,000 damage + 3 s stagger, and his rib cage opens (×1.5 for 3 s). Pews (HP 60, light) block Bone Volley |

| Phase | Trigger | Attacks: damage at L14 (telegraph) |
|---|---|---|
| P1 "Audience" | 100–65% | **Sceptre Sweep**: a 180° frontal arc 6 m, 75 (0.9 s sceptre bell rings + red wedge). **Bone Volley**: a fan of 5 shards at one target, 22 each (0.8 s shards hover). **Grave Hands**: 3 circles 2.5 m under players, 55 each + 50% slow for 1.5 s (1.2 s violet cracks). **Court Summons** every 30 s: 2 Bonewalkers (L13) rise from arena-edge bone piles (1.5 s; piles break to heavy damage). Royal Judgement every 20 s |
| P2 "Procession" | 65–30% | All P1 attacks, plus **Toll of Ages**: a 360° shockwave 6 m, 60 + 4 m knockback (1.2 s King raises the bell). Judgement every 18 s |
| P3 "Requiem" | < 30% | Candles gutter and the arena darkens (telegraph decals stay bright). Sceptre Sweep becomes a double sweep 0.6 s apart, with both wedges shown up front. Judgement every 15 s; Summons stop |

| Loot (each eligible player) | |
|---|---|
| Always | 300 coins · 3,200 XP · 1 random T3 weapon |
| 1/3 | an extra random T2 weapon |
| 1/6 | Court Mantle (Rare cape) or Funeral Veil (Rare mask), 50/50 |
| 1/25 | Hollow Crown (Legendary hat) |

| Voice line | Trigger |
|---|---|
| "Kneel. The Court is in session." (31) | engage |
| "Every crown here was once a head." (33) | phase 2 |
| "Ring the bell... for me." (24) | defeat |

### 4.4 The Receiver, Meridian (12 m mech, level 20)

**Look [12]:**
- A 12 m two-legged industrial walker: forklift crossed with riot police, exposed hydraulics, amber
  floodlights.
- Corporate ad panels on the shoulders crack as it takes damage. A rear reactor hatch.
- Avoid: a super-robot silhouette, head fins, rocket fists, Mechagodzilla plating, Gundam tricolour
  or V-crest.

**Arena:** Foreclosure Yard, a 70 × 50 m container yard.

| Item | Value |
|---|---|
| HP₂ | **30,000** (n = 3: 40,500 · n = 4: 51,000). Modelled 2-player kill ≈ 5.8 min with two L19 players on T3 weapons |
| Armour | takes **25%** damage except during Asset Freeze |
| **Co-op 1: Asset Freeze** (plates) | Two **Override Consoles** **32 m apart** (≥ 25 m) at opposite yard edges. Both held for **3 s** together → the Receiver kneels for **8 s**, the rear reactor hatch opens (**×1.5**, 100% elsewhere). Consoles then lock for 15 s. +0.25% max HP/s regeneration if no Freeze in the last 45 s |
| **Co-op 2: Foreclosure** (split circle) | From P2: every 20 s (P3 18 s) a **4.5 m circle** stamps one player's position (2.0 s: amber hologram stamp + klaxon). **348 true damage (120% of a L20 player's HP), split among players inside**; an empty circle deals 348 to every player in the arena |
| Combined (P3) | Both run at once on independent timers. A 2-player team must sequence them (soak the circle together, then run to the consoles); 3–4 players can split roles |
| Breakable cover | 8 **Freight Containers** (HP 900, heavy only; Sweep Laser hits deal 300 to them). 4 **Crane Legs** (HP 1,500): breaking one drops the crane arm along a line (1.2 s groan + shadow line), 120 to players; if it hits the Receiver: 2,000 damage + a 3 s kneel (hatch open) |

| Phase | Trigger | Attacks: damage at L20 (telegraph) |
|---|---|---|
| P1 "Audit" | 100–60% | **Stomp**: a 5 m ring around one foot, 95 (1.0 s leg raise + ring decal). **Shoulder Volley**: 3 reticles track 3 players (or ring one) for 1.2 s, then lock: 3 m circles, 50 each. Asset Freeze available |
| P2 "Restructuring" | 60–25% | All P1 attacks + Foreclosure every 20 s + **Collector Drones**: 2 drones (L20) every 25 s; their Tag makes the target take +25% from the Receiver for 5 s, clamped by the 60% cap |
| P3 "Hostile Takeover" | < 25% | All attacks; Foreclosure every 18 s; **Sweep Laser**: a 1.5 s warm-up with the beam path drawn on the ground, then a 90° rotating beam over 2 s, 150 dmg, blocked by containers. Never overlaps with Stomp |

| Loot (each eligible player) | |
|---|---|
| Always | 600 coins · 4,400 XP · 1 random T3 weapon |
| 1/3 | an extra random T3 weapon |
| 1/6 | Wind-Up Key (Rare backpack) or Signal Dish (Rare backpack), 50/50 |
| 1/25 | Receiver Floodlamp (Legendary backpack) |

| Voice line | Trigger |
|---|---|
| "This planet is now under new management." (40) | engage |
| "Resistance has been noted on your file." (39) | phase 2 |
| "Shutting down... pending review." (32) | defeat |

All 9 lines total **289 characters**. ElevenLabs Voice Design (one original voice per boss) plus three
~100-character previews comes to about 590 credits, inside the 794 available until 16 Oct 2026 (D).

---

## 5. Missions (3 per planet, from the guide NPC at the main pad) (new)

Rules (new):
- All three can be active at once.
- Rewards are paid the moment the objective completes; no turn-in walk.
- Each mission can be done once per life and resets on rebirth (missions are progression, and progression is lost).
- Objective items are mission flags, not inventory items.

| # | Planet / guide | Type | Name | Exact objective | Rec. Lv | Reward | Routes the player toward |
|---|---|---|---|---|---|---|---|
| A1 | Arcadia / **Lark**, a young shepherd | hunt | Pest Control | Kill 8 Hopbits inside Clover Fields | 1–3 | 80 XP, 30 coins, 2 Small Tonics | Clover Fields' far edge looks down on Glasswater Lake; Tidewrath's coral spikes break the surface (lair sightline) |
| A2 | Arcadia | find | The Lost Bell | Pick up the Shepherd's Bell at the edge of Lacefall's plunge pool | 2–4 | 120 XP, 40 coins | **Egg E1**: the bell lies 3 m from the walk-through gap in the falling water; light motes drift out of the gap |
| A3 | Arcadia | reach | The Big Lake | Enter the 8 m trigger at the Gull Point overlook | 3–6 | 180 XP, 60 coins, 1 Large Tonic | **Boss lair**: the two Tide Stones sit on the shore below. Lark: "Folks say the lake breathes. Don't swim at Gull Point." |
| H1 | Hollowmere / **Sexton Mabry**, the chapel grave-keeper | hunt | Silence the Choir | Kill 3 Cantors (Ossuary Camp or the causeway ruins) | 7–10 | 700 XP, 120 coins | Ossuary Camp sits on the causeway to the Hollow Nave |
| H2 | Hollowmere | find | The Sexton's Ledger | Pick up the ledger from the Drowned Chapel altar (knee-deep water, guarded by a Crypt Sentinel) | 8–11 | 900 XP, 150 coins | **Egg E5**: the bell-rope riddle chest stands beside the altar |
| H3 | Hollowmere | reach | The Tolling Tower | Reach the top platform of the Tolling Tower (ramps, no climbing) | 9–12 | 1,100 XP, 180 coins | **Boss lair**: the platform looks into the Hollow Nave's broken roof |
| M1 | Meridian / **Rook Calder**, an ex-Oversight courier | hunt | Performance Review | Kill 6 Associates and the Compliance Officer at Checkpoint Seven | 13–16 | 2,000 XP, 300 coins | Checkpoint Seven guards the canyon road to Foreclosure Yard |
| M2 | Meridian | find | Whistleblower | Pick up the memo drive on the manager's desk in the Oversight Lobby | 14–17 | 2,400 XP, 350 coins | **Egg E7**: the wall safe is in the same office; the break-room mirror is next door |
| M3 | Meridian | reach | Site Visit | Reach the gantry overlook above Foreclosure Yard | 15–18 | 2,800 XP, 400 coins | **Boss lair**: both Override Consoles are visible from the gantry |

Totals: 10,280 XP and 1,630 coins per life.

---

## 6. Easter eggs (3 per planet) (new)

Rules:
- The item can be claimed once per life. It is an item, so it drops on death like everything else (D).
- The hidden medal is earned once per account and stays hidden in the medal list until earned.
- The first account to claim each egg is engraved on that egg's plaque in Portus's **Hall of Firsts**
  (D): 9 plaques.

| # | Planet | Name | Location concept | How to find it | Rare item | Hidden medal |
|---|---|---|---|---|---|---|
| E1 | Arcadia | Behind the Curtain | Lacefall waterfall, north shore of Glasswater | Walk through the left edge of the falling water. The 2 m curtain has no collision there. In the cave, press E on the offering bowl of a sleeping voxel Hopbit shrine (costs 1 coin) | **Lantern of Lacefall** (Legendary backpack: a hanging lantern shedding drifting light motes) | Behind the Curtain |
| E2 | Arcadia | Highscore Riddle Chest | A ruined voxel arcade cabinet on Highscore Hill | 4 buttons carry icons (raindrop, leaf, sun, flame). The plaque reads: *"Rain feeds the leaf, the leaf drinks the sun, the sun lights the ember."* Press raindrop → leaf → sun → flame. A wrong press resets and spawns 3 Hopbits. Icons, not colours, carry the order (colour-blind safe) | **Pixel Halo** (Legendary hat: a floating halo of square light-pixels) | New High Score |
| E3 | Arcadia | Follow the Gold | Clover Fields; a burrow under the lone oak | 1 in 25 Hopbit packs includes a non-hostile **Golden Hopbit** that flees. Stay within 15 m of it for 60 s without damaging it, and it hops into a burrow that opens into a small voxel room. Damaging it pops it for 25 coins only | **Golden Hopbit** (Legendary backpack: a tiny golden Hopbit riding the shoulders) | Follow the Gold |
| E4 | Hollowmere | The Ferryman's Lanterns | Whisper Fen and Ferryman's Isle in Mourning Mere | Light all 7 dim marsh lanterns across the Fen (E, 1 s each) within 180 s. A ghost ferry then waits at the Fen jetty for 60 s; stand on it to ride to Ferryman's Isle | **Ferryman's Oar** (Legendary weapon: Riverstaff II stats, oar model, water-wake trail; needs L6) | Paid the Ferryman |
| E5 | Hollowmere | Bellringer | Drowned Chapel, beside the altar (mission H2) | Three bell ropes carry carved icons (skull, broken lantern, candle). The plaque reads: *"Ring for the dead, then the lost, then the living."* Pull skull → broken lantern → candle. A wrong order raises 2 Bonewalkers | **Candle Crown** (Legendary hat: an iron circlet with three lit candles that drip wax) | Bellringer |
| E6 | Hollowmere | Down the Well | Saint Orrin's ruined well | Jump into the 20 m well; it ends in deep water (no fall damage, see §0). A surface-level side arch leads to the **Upside-Down Chapel**, built on its own ceiling, with the reward on the "floor" above | **Bone Bell** (Legendary backpack: a small bone bell that rings when you jump) | Down the Well |
| E7 | Meridian | Employee of the Month | Oversight Lobby manager's office (mission M2) | A wall safe has a 4-digit keypad. The break-room poster says "REFLECT ON YOUR PERFORMANCE". Digits painted mirror-reversed on the opposite wall read **7041** in the break-room mirror (a baked mirror texture, so it works on Low) | **Executive Visor** (Legendary mask: amber one-way visor with a scrolling ticker of light) | Employee of the Month |
| E8 | Meridian | Lights Out | The Last Billboard, a broken Oversight billboard on a mesa above Glasspan | Shoot out its 5 lamp targets (0.4 m each, ≥ 60 m below, no path up) within 20 s; they relight after that. A maintenance hatch at the mesa base opens into the **Signal Room** (a CRT wall) | **Static Cloak** (Legendary cape: shimmering TV-static pattern) | Lights Out |
| E9 | Meridian | Ticket #000 | Checkpoint Seven, back wall | One Associate stands facing a wall, non-hostile, with no level plate and ticket "000". Use the phrase wheel's **"Truce?"** within 5 m: it turns and walks 120 m to a freight lift, which descends to the **Vat Room** (rows of empty trooper pods, one open). Attacking it makes it vanish for 10 min | **Ticket #000 Helmet** (Legendary hat: an Associate helmet stencilled 000) | Not a Clone |

---

## 7. Achievements: 20 medals + 9 hidden egg medals (new)

Medals are account-bound and survive death (D). Wear one as a **title** under your name. "Life" means
since the last rebirth; "account" means cumulative.

| # | Medal | Type | Exact unlock condition | Scope | Title |
|---|---|---|---|---|---|
| 1 | Spark | progress | Finish onboarding | account | Newcomer |
| 2 | Ten Down | progress | Reach level 10 | life | Seasoned |
| 3 | Firstlight | progress | Reach level 20 | life | Firstlighter |
| 4 | Grand Tour | progress | Set foot on Arcadia, Hollowmere and Meridian | life | Wanderer |
| 5 | Cartographer | progress | Use every fast-travel pad on one planet (12 / 12 / 20) | life | Cartographer |
| 6 | Errand Runner | progress | Complete all 9 missions | life | Reliable |
| 7 | Tide Turner | feat | Loot-eligible on a Tidewrath kill | account | Tide Turner |
| 8 | Regicide | feat | Loot-eligible on a Hollow King kill | account | Regicide |
| 9 | Decommissioned | feat | Loot-eligible on a Receiver kill | account | Decommissioner |
| 10 | Triple Crown | feat | Loot-eligible on all three bosses | life | Triple Crown |
| 11 | Demolition Crew | feat | Break 200 props | account | Wrecker |
| 12 | Arc Welder | feat | One Stormcoil cast damages 4 different entities (needs T2+) | account | Conductor |
| 13 | Long Shot | feat | Kill a player or enemy with the Stillshot Rifle at ≥ 120 m | account | Farshot |
| 14 | Back For My Stuff | survival | After a rebirth, pick up ≥ 1 item from the pile your previous life dropped | account | Persistent |
| 15 | Untouchable | survival | Loot-eligible on a boss kill having taken 0 damage from that boss, from your first hit to the kill | account | Untouchable |
| 16 | Old Timer | survival | 3 h of online playtime in one life | life | Old Timer |
| 17 | By a Thread | survival | Drop to ≤ 5% max HP, then still be alive 60 s later | account | Lucky |
| 18 | Killed by a Woolback | joke | Die to a Woolback buck, or to fall damage within 5 s of a Woolback's knockback | account | Fleeced |
| 19 | With Friends Like These | joke | Be killed by a member of your current party | account | Trusting |
| 20 | Own Goal | joke | Die to your own Comet rocket, Scrapburst or Emberglass splash | account | Self-Starter |
| H1–H9 | the 9 egg medals in §6 | hidden | Claim that egg's item | account | same as the medal name |

---

## 8. Starter characters and cosmetics

### 8.1 Shared avatar contract

- **Rig:** one humanoid skeleton for all four starters, which differ only in looks and starter weapon (D).
- **Base mesh:** Quaternius Universal Base Characters (CC0), restyled in Blender [08] (D).
- **Budget [r2-15]:** 10–15k triangles, 1 skinned mesh, ≤ 2 materials, ≤ 75 bones, one 1024² atlas
  (512² on Low).
- **Shading [r2-15] rule 6:** anime-leaning faces with big rounded eyes that read at three-quarter
  view, chiselled planes, clumped hair, a toon ramp with a rim light, and one identity pattern mask per
  character.
- **Weapon sockets:** right hand, left hand, back.

### 8.2 Visual briefs

| Character | Silhouette | Materials | Default colours | Avoid (IP) |
|---|---|---|---|---|
| **Hexwick**: young wizard, Hexquill | Slim, a long deep-blue robe flaring at the hem; one long single-colour scarf trailing behind; a satchel stuffed with quills; the Hexquill is a quill-shaped wand that writes glowing glyphs in the air on cast [r2-04]. Pattern mask: faint constellation embroidery | brushed wool, leather satchel, ink-stained cuffs, emissive glyph strokes | Midnight palette: deep blue robe, silver trim, cyan glyphs | round glasses; a lightning-bolt scar; striped two-colour "house" scarves (the scarf is always the single primary colour); black school robes with a crest; owls; brooms; invented spell words. Any spoken words are public-domain ones (*Abracadabra*, *Fiat Lux*) [r2-04] |
| **Brother Ash**: hooded desert monk-knight, Sunbrand | Tall; the hood is deep and asymmetric, with layered sand cloth wrapped over one shoulder; a brass face-guard under the hood; brass prayer beads. Sunbrand: a lantern-cage brass hilt and an amber-white blade with a flame ribbon and forge-crackle sound [r2-04]; stowed on the back. Pattern mask: woven sun-and-ash stripes | layered linen, worn leather, hammered brass, emissive blade | Sand palette: sand cloth, umber wraps, amber accents | a brown robe over a cream tunic with a belted sash; a plain cylinder hilt with an emitter; the hum sound; **blade colour coding (the Sunbrand blade is always amber-white whatever the palette; the palette only tints the hilt inlays)**; the words "Jedi" and "lightsaber" |
| **Kappa**: folklore turtle-shell ninja, bo staff | ONE character. Squat and wide, with a domed tortoise shell patterned like river stones; a beaked face; webbed hands; the kappa's water dish on the crown, covered by a wide straw hat (kasa); a wooden Riverstaff lashed with reed cord. Pattern mask: shell-plate lines | matte green skin, shell keratin, straw, cord, wood | Moss palette: natural moss-green skin, straw hat, bark-brown wraps | coloured bandana masks; initial-letter belt buckles; elbow and knee pads; four brothers; Renaissance-artist names; pizza; a rat master; sewers; the words "Ninja Turtle". Also no yellow skin with a spiky green-and-white-rimmed shell and sneakers (a famous platformer's turtles) |
| **Unit 7**: white-armour trooper, Pocket Carbine | Compact and solid. Ivory ceramic plates over a **grey** padded undersuit (never black); a rounded helmet with **ONE round lens visor** [r3]; a "07" stencil on the shoulder; a small radio pack. Pocket Carbine: a boxy compact carbine with a top-mounted battery cell. Pattern mask: panel seams | glazed ceramic, rubberised grey suit, gunmetal | Ivory palette: ivory plates, grey suit, amber lens and bolt tracers | a T-shaped visor; a frowning mouth grille; a black undersuit showing between white plates; bucket helmets with ear caps; DL-44 / E-11 blaster silhouettes; red "pew" bolts [r2-04]. Also keep Unit 7 visibly different from Meridian's slate-grey slit-visor Associates |

### 8.3 The 6 palettes (new); any starter can wear any palette

| # | Palette | Primary | Secondary | Accent (emissive) | Default for |
|---|---|---|---|---|---|
| 1 | Ivory | #E9E4D8 | #6F7780 | #F2B544 | Unit 7 |
| 2 | Sand | #C8A97E | #6B4A32 | #F5A623 | Brother Ash |
| 3 | Midnight | #1E2F5C | #C9CED6 | #6FD3FF | Hexwick |
| 4 | Moss | #5E7A3A | #8A6A43 | #9BE564 | Kappa |
| 5 | Ember | #2E2A2B | #A3402B | #FF8A3D | – |
| 6 | Dusk | #4A3260 | #3E5568 | #F09A7A | – |

Mapping:
- **Primary** = robe, cloth, armour plates or the shell rim.
- **Secondary** = trim, wraps or undersuit.
- **Accent** = glyphs, visor lens, bolt tracers or hilt inlays.
- Kappa's skin stays in a natural green ramp (only the shell rim, hat band and wraps recolour).
- The Sunbrand blade colour never changes.

### 8.4 First cosmetics list (new names except where marked)

Rarity is shown by colour and a shape icon (colour-blind safe): Common = grey circle, Uncommon = green
triangle, Rare = blue diamond, Legendary = gold star.

Cosmetics are items: they drop on death (D). Slots are hat, cape, mask and backpack.
- **Budget:** ≤ 1,500 triangles each, sharing the character atlas or using their own 256² texture.
- **Capes:** rigid, with 2–3 bones, and no cloth simulation [08].
- **Base gear:** Kappa's straw hat and Ash's hood are part of the base model and hide when a hat is
  worn (new).

| Slot | Item | Rarity | Where it comes from |
|---|---|---|---|
| Hat | Woolly Beanie | Common | Portus shop, 120 |
| Hat | Wide Straw Hat | Common | Portus shop, 120 |
| Hat | Messenger's Winged Cap [r2-04] | Uncommon | any Arcadia enemy 1/150 |
| Hat | Hard Hat (Oversight Issue) | Uncommon | any Meridian enemy 1/75 |
| Hat | Antler Crown | Rare | Bramblehorn 1/8 |
| Hat | Heron Plume Hat | Rare | Fenstalker 1/8 |
| Hat | Coral Crown | Rare | Tidewrath 1/12 (half of 1/6) |
| Hat | Hollow Crown | Legendary | Hollow King 1/25 |
| Hat | Pixel Halo | Legendary | egg E2 |
| Hat | Candle Crown | Legendary | egg E5 |
| Hat | Ticket #000 Helmet | Legendary | egg E9 |
| Cape | Traveller's Cloak | Common | Portus shop, 120 |
| Cape | Wolfpelt Cape | Uncommon | Dusk Wolf 1/200 (any planet) |
| Cape | Tide Cape | Rare | Tidewrath 1/12 |
| Cape | Court Mantle | Rare | Hollow King 1/12 |
| Cape | Saltplate Mantle | Rare | Dunebreaker 1/8 |
| Cape | Static Cloak | Legendary | egg E8 |
| Mask | Fox Mask | Common | Portus shop, 120 |
| Mask | Voxel Visor | Uncommon | Blockyard camp chest 1/10 |
| Mask | Crowbeak Mask [r2-04] | Uncommon | any Hollowmere enemy 1/100 |
| Mask | Funeral Veil | Rare | Hollow King 1/12 |
| Mask | Executive Visor | Legendary | egg E7 |
| Backpack | Bedroll | Common | Portus shop, 120 |
| Backpack | Woolback Plushie | Uncommon | Woolback 1/300 |
| Backpack | Wind-Up Key [r2-04] | Rare | The Receiver 1/12 |
| Backpack | Signal Dish | Rare | The Receiver 1/12 |
| Backpack | Tidewrath Tooth | Legendary | Tidewrath 1/25 |
| Backpack | Receiver Floodlamp | Legendary | The Receiver 1/25 |
| Backpack | Lantern of Lacefall | Legendary | egg E1 |
| Backpack | Golden Hopbit | Legendary | egg E3 |
| Backpack | Bone Bell | Legendary | egg E6 |

For the horse (an extra after the core), [r2-04] suggests a later "Sleipnir Saddle" eight-legged horse
skin, if it is ever wanted.

---

## 9. Asset sources

**Rule (D):** code is MIT and our own art is CC BY 4.0. Keep a manifest per file: author, URL, licence,
download date, modifications and hash [13]. **ElevenLabs outputs never go in the repo** (D). Per
[r2-02]:
- No plan allows CC0/CC-BY relicensing of ElevenLabs output.
- Host the boss-line files outside git (Cloudflare asset bucket) with a "not licensed for reuse" note.
- Use Voice Design voices only. Default voices expire 31 Dec 2026, and Library voices are clones of
  real people.

| Need | Source | URL | Licence | Status |
|---|---|---|---|---|
| Rigged base characters | Quaternius Universal Base Characters (free Standard tier; ~13k triangles average) | https://quaternius.itch.io/universal-base-characters | CC0 | verified [08] |
| Outfit parts | Quaternius Modular Character Outfits: Fantasy | https://quaternius.com/packs/modularcharacteroutfitsfantasy.html | CC0 | verified [08] |
| Skeleton / NPC placeholders | KayKit Skeletons; KayKit Adventurers | https://kaylousberg.itch.io/kaykit-skeletons · https://kaylousberg.itch.io/kaykit-adventurers | CC0 | verified [08]; different body style from Quaternius, so restyle before mixing |
| Animations | Quaternius Universal Animation Library 1 and 2 (Standard tier) | https://quaternius.itch.io/universal-animation-library · https://quaternius.itch.io/universal-animation-library-2 | CC0 | licence verified [08]; **exact free-archive clip list not inspected** |
| Animations (fallback) | KayKit Character Animations, the **current** pack (161 clips), not the legacy one | https://kaylousberg.itch.io/kaykit-character-animations | CC0 | verified [08] |
| Rigging aid + clips | Mesh2Motion (code MIT; its rigs and animations CC0) | https://mesh2motion.org/ · https://github.com/Mesh2Motion/mesh2motion-assets | MIT / CC0 | verified [08]; check any third-party sample models separately |
| Prototype characters | Kenney Animated Characters (Protagonists, Retro, Survivors), Blocky Characters | https://kenney.nl/assets/animated-characters-protagonists | CC0 | verified [08] |
| Animals (horse) | Quaternius low-poly animated animals | https://quaternius.itch.io/lowpoly-animated-animals | CC0 | horse verified [r2-04]; **wolf/sheep contents unverified** |
| Props, HDRIs, textures | Poly Haven | https://polyhaven.com/license | CC0 | verified [13], [07] |
| Materials | ambientCG | https://docs.ambientcg.com/license/ | CC0 | verified [07] |
| Props, UI | Kenney asset packs | https://kenney.nl/support | CC0 | verified [13] |
| Real-object scans | Cleveland Museum of Art armour for man and horse (119.8k triangles, so decimate to ≤ 5k); Tula Arms Museum flintlock | https://sketchfab.com/3d-models/196488-armor-for-man-and-horse-faca2ad557f64809b598c3a646a8804f · https://sketchfab.com/3d-models/flintlock-pistol-792ca024195d4292829d8d0b304ced30 | CC0 | verified on page [r2-04]; other Sketchfab "CC0 heritage" items need a per-model check |
| Prop shattering | three-piñata | – | MIT per (D) | **licence not verified by any report** |
| SFX (code-generated) | ZzFX, ZzFXM | https://github.com/KilledByAPixel/ZzFX · https://github.com/keithclark/ZzFXM | MIT | verified [r2-02] |
| SFX (generator) | jsfxr | https://github.com/chr15m/jsfxr | Unlicense / MIT | tool licence verified; **output terms unstated (unverified)** [r2-02] |
| SFX packs | Kenney audio (Interface 100, Impact 130, RPG 50, Sci-fi 70, Digital 60, UI 50, Jingles 85, Voiceover 90 sounds) | https://kenney.nl/support | CC0, attribution not required | verified [r2-02] |
| SFX gaps | Freesound with the `license:"Creative Commons 0"` filter (BY 4.0 acceptable with credit; skip NC and Sampling+) | https://freesound.org/help/faq/ | CC0 / CC BY 4.0 | filter tested [r2-02]; listen for embedded franchise sounds [07] |
| Music, Arcadia | Juhani Junkala (SubspaceAudio), "5 Chiptunes (Action)" | https://opengameart.org/content/5-chiptunes-action | CC0 | verified [09] |
| Music, Portus / ambient | Kounine, "Bruno Simon Free Music Pack" | https://kounine.itch.io/bruno-simon | CC0 | verified [09]; **per-planet fit not auditioned** |
| Music, Meridian | Pro Sensory "Aerobics Synth Wave" / "Synth Wave"; cynicmusic synthwave tracks (OpenGameArt) | https://opengameart.org/content/aerobics-synth-wave | CC0 | verified [09]; synthwave fits Meridian's chrome only, not the overall look |
| Music, Hollowmere | Kevin MacLeod (incompetech), a dark-ambient track to be picked | https://www.incompetech.com/music/royalty-free/faq.html | CC BY 4.0, exact credit line: "Music by Kevin MacLeod (incompetech.com), Licensed under Creative Commons: By Attribution 4.0" | licence verified [07], [09]; **track not chosen**; Content ID claims possible on videos [07] |
| Music (alternative) | glitchart tracks on OpenGameArt | – | CC BY 4.0 | verified [09] |
| Original music (option) | ACE-Step 1.5, run offline | https://huggingface.co/ACE-Step/Ace-Step1.5 | MIT model; output rights are an inference, not an express grant | [13] |
| Fonts | Google Fonts (OFL families) | https://github.com/google/fonts#license | OFL-1.1 | verified [07] |
| Boss voice lines | ElevenLabs TTS with Voice Design | – | proprietary output; never in the repo | [r2-02]. **Unknown:** the owner's plan. Free is non-commercial and needs "elevenlabs.io" in the title, and the Use Policy forbids under-18-directed experiences without approval |

**Excluded** [08], [07], [13], [r2-02], [09]:
- Characters and animation: Mixamo library clips/characters, Synty, AccuRIG/ActorCore raw exports,
  VRoid presets, Ready Player Me (shut down 31 Jan 2026), Avaturn.
- Audio: Sonniss GDC bundles (repo-unsafe), Pixabay music (no redistribution as music files), White
  Bat Audio, Suno free tier, Udio, MusicGen weights (NC), ElevenLabs SFX/music in the repo.
- Other: British Museum CC BY-NC-SA scans, and scraping Poly Pizza.

---

## 10. Every proper name used, checked against the IP line

Check = no owner names or near-misses (Jedi, lightsaber, Hogwarts, Ninja Turtles, -zilla, one-letter
variants), no famous-franchise proper names, no exact titles of other games. This is a reasoned check,
not a trademark search.

| Group | Names | Result |
|---|---|---|
| Decided (D) | FIRSTLIGHT, Portus, Arcadia, Hollowmere, Meridian, Hall of Firsts, Hexwick, Brother Ash, Unit 7, Hexquill, Sunbrand, Pocket Carbine, Woolback, Dusk Wolf, Tidewrath, The Receiver, Meridian Oversight, Hollow Court | OK, with flags: **Hollow King** is one word from *Hollow Knight* (Team Cherry); keep, with fallback "the Barrow King". **Kappa** is folklore (fine), but also an apparel trademark and a Twitch emote; low risk in games. **Tidewrath** is flagged Y in [r2-04] because of the kaiju archetype; mitigated by the design rules in 4.2 |
| Weapons (new / [05]) | Riverstaff, Bearded Axe, Quarry Hammer, Emberglass Staff [05], Stormcoil, Scatterpipe [05], Yew Longbow, Stillshot Rifle, Comet Launcher, Scrapburst Grenade [05], Patchkit [05], Prism Bubble, Radio, Small/Large Tonic, Ferryman's Oar | OK. I rejected "Skyhammer" (Warhammer), "Boomtube" (DC's "Boom Tube"), "Farsight" (Warhammer 40k) and "Stonemaul" (WoW) |
| Arcadia creatures (new) | Brightbits (faction), Hopbit, Golden Hopbit, Sparkfly, Linewyrm, Bomblet, Pixel Lancer, Cabinet Golem | OK. Silhouettes must follow the avoid list in 3.2 |
| Hollow Court [12] / (new) | Bonewalker, Gnawer, Cantor, Crypt Sentinel [12]; Bone Archer, Marsh Wisp [r2-04] | OK (generic) |
| Meridian Oversight [12] / (new) | Associate, Enforcer, Collector, Auditor, Compliance Officer | OK (generic job titles; "Collector" is a common noun, not Marvel's character) |
| Wildlife (new) | Bramblehorn, Fenstalker, Dunebreaker | OK |
| NPCs (new) | Lark, Sexton Mabry, Rook Calder, Juno Vale | OK |
| Places (new) | Arcadia: Dawnpad, Clover Fields, Glasswater Lake, Gull Point, Tide Stones, Lacefall, Highscore Hill, Blockyard Camp, Kestrel Peak, Pinewhistle Wood. Hollowmere: Lanternfall, Whisper Fen, Drowned Chapel, Saint Orrin's Well, Upside-Down Chapel, Ossuary Camp, Mourning Mere, Ferryman's Isle, Thornwood, Tolling Tower, the Hollow Nave. Meridian: Waystation Nine, Cinder Canyons, Brinewater Lake, Glasspan Salt Flats, Checkpoint Seven, Chrome Spires, Oversight Lobby, The Last Billboard, Signal Room, Vat Room, Foreclosure Yard, Override Consoles. Portus: Portus Exchange | OK. I rejected "Silverfall" (a 2007 RPG title), "Mirrormere" (Tolkien), "Redwall" (book series), "Vesper" (superseded avatar) and "Bitworks" |
| Boss phases and attacks | Rising, Undertow, Riptide, Moored, Tail Slam, Brine Spit, Tide Surge, Steam Vents, Coral Pillars; Audience, Procession, Requiem, Royal Judgement, Sceptre Sweep, Bone Volley, Grave Hands, Toll of Ages, Court Summons; Audit, Restructuring, Hostile Takeover [12], Asset Freeze, Foreclosure, Stomp, Shoulder Volley, Sweep Laser, Freight Containers, Crane Legs | OK |
| Missions | Pest Control, The Lost Bell, The Big Lake, Silence the Choir, The Sexton's Ledger, The Tolling Tower, Performance Review, Whistleblower, Site Visit | OK |
| Eggs and medals | Behind the Curtain, New High Score, Follow the Gold, Paid the Ferryman, Bellringer, Down the Well, Employee of the Month, Lights Out, Not a Clone; Spark, Ten Down, Firstlight, Grand Tour, Cartographer, Errand Runner, Tide Turner, Regicide, Decommissioned, Triple Crown, Demolition Crew, Arc Welder, Long Shot, Back For My Stuff, Untouchable, Old Timer, By a Thread, Killed by a Woolback, With Friends Like These, Own Goal | OK. I rejected "Kingsbane" (Hearthstone weapon), "Kingslayer" (Game of Thrones epithet), "Tidebreaker" (too close to Dota's "Tidebringer"), "Hawkeye" (Marvel) and "Leap of Faith" (Assassin's Creed) |
| Titles | Newcomer, Seasoned, Firstlighter, Wanderer, Reliable, Decommissioner, Wrecker, Conductor, Farshot, Persistent, Lucky, Fleeced, Trusting, Self-Starter | OK |
| Cosmetics | Woolly Beanie, Wide Straw Hat, Messenger's Winged Cap, Hard Hat (Oversight Issue), Antler Crown, Heron Plume Hat, Coral Crown, Hollow Crown, Pixel Halo, Candle Crown, Ticket #000 Helmet, Traveller's Cloak, Wolfpelt Cape, Tide Cape, Court Mantle, Saltplate Mantle, Static Cloak, Fox Mask, Voxel Visor, Crowbeak Mask, Funeral Veil, Executive Visor, Bedroll, Woolback Plushie, Wind-Up Key, Signal Dish, Tidewrath Tooth, Receiver Floodlamp, Lantern of Lacefall, Golden Hopbit, Bone Bell; palettes Ivory, Sand, Midnight, Moss, Ember, Dusk | OK. "Hollow Crown" is Shakespeare (public domain) |

---

## 11. Conflicts between the reports and DECISIONS.md (DECISIONS wins)

| Report | Report says | DECISIONS / this bible |
|---|---|---|
| 04 | Cap 30 (99 later), `45 × L^1.8`; Tokens, Legend score, Continue Coin, Zone Laws, the Hunt, attributes, perks, Heirloom kits; 50% of tokens destroyed on death | Cap 20; level 2 in ~1 min, level 5 in ~10 min; coins only; everything drops into a permanent pile; no perks or attributes |
| 04, 05, 12 | PvE first, PvP deferred or opt-in; no friendly fire; explosions don't hit allies | Open PvP outside safe zones at any level; friendly fire on, including in parties |
| 05 | Zone capability rules (Bitcrush Commons, Elderwild Grove, Ember Foundry; tech/magic blocked) | Superseded (Zone Laws) |
| 05 | Rarity tiers (common→legendary, artifact) with mods; Echo Spool, Lane Skimmer, Foundry Walker, Palinode Bell; level cap 10 | 3 tiers per weapon, gated at L6/L12; only the (D) weapon list; rarity only on cosmetics |
| 05 | "No physical terrain destruction" | Destruction is core (props, camp walls, arena cover) |
| 05 | Shift = dodge, Q = utility, two weapon slots + utility/consumable/artifact slots | Shift = sprint, C = dodge (D1), 1–4 hotbar + 16 backpack. **R reload is needed but not in (D)**; log it |
| 05 | Pocket Carbine is the universal starter | Per-character starters; the Carbine is Unit 7's |
| 06 | Firstlight as the hub name; Quarterdeck, Hollow Vault, Gridlock, Bastion; Hunt keys, gates, Red Book, Monolith, seasons; Tally Corp, the Architect; a Hollow King who duels at a game table | Portus hub + Arcadia, Hollowmere, Meridian; Hall of Firsts; the Hollow King is a co-op combat boss |
| 08 | 8 presets (Relay, Vesper, Rivet, Dawn/Night Reed, Ledger, Moss Circuit, Beacon); a parts-based creator | 4 starters × 6 palettes + cosmetics |
| 08 vs r2-15 | Avatar 8–12k triangles / 64 bones | Report-vs-report; this bible uses r2-15's later 10–15k / 75 |
| 12 | Zones Z1 Glitch Flats, Z2 Hollow Court, Z3 Meridian Perimeter, Z4 Castle Siege; Bitrot Leviathan; Meridian Incursion event; siege final battle | Three planets with the (D) bosses; no siege or Incursion |
| 12 | Enemy level clamped to the player's level | Fixed level per area (shared world) |
| 12 | Evac pads, a bail-out teleport, death recap card, arena gate locks at fight start | No evac or bail-out in (D); death card cut; bosses always open, no gate lock |
| 12 | 80–150 ambient crowd avatars in the hub | "No fake players, ever" (D); NPCs must read as NPCs |
| 12 | The Receiver at L15 with 4,000 HP as a solo final-battle boss | L20, co-op-tuned, 30,000 HP₂ |
| r2-04 | Clone soldiers: avoid **white armour** and T-visors | (D) chose a white-armour trooper. Mitigated with ivory plates over grey (never black), one round lens, no T-visor |
| r2-04 vs r3 | Tidewrath as a "low serpentine sea-dragon in verdigris and rust" | Report-vs-report; this bible follows the later keyframe (crocodilian-turtle quadruped, stone and coral) |
| r2-04 | Energy sword named "Thirty-Torch Brand" | (D) named it Sunbrand; the lantern-cage design is kept |
| r2-04 | Clone troopers as "Toothsown Hoplites", every face different | Brief: Meridian clones are identical armoured troopers (Associates) |
| r2-05 | PvP off on planet 1, consent on planet 2, ±5 levels on planet 3; skull, new-player shield, PvP off in boss arenas; coins-only drops; no trading | Open PvP everywhere outside safe zones; no wanted system or brackets; everything drops; trade by dropping |
| r2-05 | Downed-not-dead in arenas (mechanic C) | No downed state (D) |
| r2-05 | Perks at L5/10/15/20; cosmetic wardrobe "decide" | No perks in (D). Cosmetics are items, so they drop on death (D lists only account, name, medals and Hall of Firsts as kept). **This is an interpretation; confirm** |
| r2-05 | 10 s combat tag, 5 s logout channel, body stays 60 s; killer-only loot window | 30 s countdown, 10 s after combat, body stays 30 s; piles last forever and anyone can loot |
| r2-08 | Book: logging out leaves you exposed for about a minute (unverified) | 30 s (D) |
| 13 | CC0 for original art; a "retro future" neon direction | Own art CC BY 4.0 (D); look per R3 Q2 (muted menus, saturated planets) |
| 07 | Apache-2.0 for code | MIT (D) |
| 09 | Synthwave palette and music as the main identity | Palette superseded; synthwave tracks kept only as a Meridian music option |
| r2-02 | ElevenLabs for ~25 SFX, 3 loops, 3 tracks and 30 lines | Only a few boss lines now (794 credits) (D); this bible uses 9 lines (289 characters) |

**Open items for the builder to log as run decisions:**
1. R as the reload key.
2. Confirm that cosmetics drop on death.
3. Safe-zone ring radius of 12 m around pads.
4. Hollow King name risk.
5. three-piñata licence check.
6. Which ElevenLabs plan the owner is on.
