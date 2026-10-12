// Static examples of the kit's inventory and onboarding markup (dev gallery only; the same markup is
// documented in src/ui/README.md). Lanes building these screens copy the structure, not this file.

export const INVENTORY_HTML = `
<div class="fl-overlay fl-ui fl-overlay--modal">
  <section class="fl-inv fl-panel" aria-label="Inventory">
    <header>
      <h1>Inventory<small>Drag to move · right-click to use · drop to leave it in the world</small></h1>
      <div class="fl-inv__purse"><i class="px px-coin"></i><b class="num">214</b></div>
    </header>
    <div class="fl-inv__cols">
      <div>
        <div class="fl-inv__group">
          <div class="fl-label">Hotbar <span>1–4</span></div>
          <div class="fl-inv__grid">
            <div class="fl-islot fl-arcade is-sel"><span class="fl-islot__k">1</span><i class="px px-carbine"></i><span class="fl-tier"><i class="on"></i><i class="on"></i><i></i></span><span class="fl-islot__q num">21</span></div>
            <div class="fl-islot fl-arcade is-hover"><span class="fl-islot__k">2</span><i class="px px-stormcoil"></i><span class="fl-tier"><i class="on"></i><i class="on"></i><i></i></span></div>
            <div class="fl-islot fl-arcade"><span class="fl-islot__k">3</span><i class="px px-grenade"></i><span class="fl-tier"><i class="on"></i><i></i><i></i></span><span class="fl-islot__q num">×3</span></div>
            <div class="fl-islot fl-arcade is-gated"><span class="fl-islot__k">4</span><i class="px px-sunbrand"></i><i class="px px-lock fl-islot__lock"></i><span class="fl-islot__q num fl-danger">Lv 12</span></div>
          </div>
        </div>
        <div class="fl-inv__group">
          <div class="fl-label">Backpack <span>6 / 16</span></div>
          <div class="fl-inv__grid">
            <div class="fl-islot fl-arcade"><i class="px px-patchkit"></i><span class="fl-islot__q num">×2</span></div>
            <div class="fl-islot fl-arcade"><i class="px px-tonic-l"></i><span class="fl-islot__q num">×5</span></div>
            <div class="fl-islot fl-arcade"><i class="px px-radio"></i></div>
            <div class="fl-islot fl-arcade"><i class="px px-foxmask"></i><span class="fl-rar fl-rar--common"></span></div>
            <div class="fl-islot fl-arcade"><i class="px px-cloak"></i><span class="fl-rar fl-rar--rare"></span></div>
            <div class="fl-islot fl-arcade"><i class="px px-wool"></i><span class="fl-islot__q num">×7</span></div>
            <div class="fl-islot fl-arcade is-empty"></div><div class="fl-islot fl-arcade is-empty"></div>
          </div>
        </div>
      </div>
      <div class="fl-inv__tipwrap">
        <div class="fl-itip fl-itip--static">
          <div class="fl-itip__head"><i class="px px-stormcoil"></i><div><b>Stormcoil II</b><div class="fl-itip__meta"><span class="fl-tierbadge">◆◆◇ II</span>Magic · chain lightning</div></div></div>
          <div class="fl-itip__gate"><i class="px px-lock"></i><span>Tier III needs <b>level 12</b> to equip. You're level 7.</span></div>
          <dl class="fl-stats">
            <dt>Damage</dt><span class="fl-bar"><i style="--fill:.55"></i></span><dd>27<span class="is-up">+7</span></dd>
            <dt>Jumps</dt><span class="fl-bar"><i style="--fill:.6"></i></span><dd>3</dd>
            <dt>Casts before heat</dt><span class="fl-bar"><i style="--fill:.7"></i></span><dd>7</dd>
          </dl>
          <p class="fl-itip__note">Arcs between up to three targets. Breaks light props.</p>
          <div class="fl-itip__foot"><span>Sells for</span><span class="fl-coin">75</span></div>
        </div>
      </div>
      <aside>
        <div class="fl-panel fl-panel--quiet fl-panel--pad">
          <div class="fl-label">Radio channel</div>
          <div class="fl-chans" role="radiogroup">
            <button class="fl-ch"><b>1</b><span>2 on</span></button><button class="fl-ch"><b>2</b><span>—</span></button><button class="fl-ch is-on"><b>3</b><span>4 on</span></button>
            <button class="fl-ch"><b>4</b><span>—</span></button><button class="fl-ch"><b>5</b><span>1 on</span></button><button class="fl-ch is-full"><b>6</b><span>full</span></button>
            <button class="fl-ch"><b>7</b><span>—</span></button><button class="fl-ch"><b>8</b><span>—</span></button><button class="fl-ch"><b>9</b><span>—</span></button>
          </div>
        </div>
        <div class="fl-dropzone fl-inv__drop"><b><i class="li li-drop"></i>Drop here</b>It stays on the ground. Anyone can pick it up.</div>
      </aside>
    </div>
    <footer><span><span class="fl-key">I</span>Close</span><span><span class="fl-key">1</span>–<span class="fl-key">4</span>Equip</span><span class="fl-end">Everything here drops when you die.</span></footer>
  </section>
</div>`;

export const ONBOARDING_HTML = `
<div class="fl-onb fl-ui" data-hud>
  <section class="fl-onb__list fl-holo">
    <h3>First minute · 4 / 12</h3>
    <div class="fl-onb__st is-done"><i></i>Move<span class="fl-keys"><span class="fl-key">W</span><span class="fl-key">A</span><span class="fl-key">S</span><span class="fl-key">D</span></span></div>
    <div class="fl-onb__st is-done"><i></i>Look<span class="fl-keys"><span class="fl-key">Mouse</span></span></div>
    <div class="fl-onb__st is-done"><i></i>Jump<span class="fl-keys"><span class="fl-key fl-key--wide">Space</span></span></div>
    <div class="fl-onb__st is-now"><i></i>Sprint<span class="fl-keys"><span class="fl-key fl-key--wide">Shift</span></span></div>
    <div class="fl-onb__st"><i></i>Dodge<span class="fl-keys"><span class="fl-key">C</span></span></div>
    <div class="fl-onb__st"><i></i>Attack the dummy<span class="fl-keys"><span class="fl-key">LMB</span></span></div>
    <div class="fl-onb__st"><i></i>Switch weapons<span class="fl-keys"><span class="fl-key">1</span><span class="fl-key">4</span></span></div>
    <div class="fl-onb__st"><i></i>Pick up<span class="fl-keys"><span class="fl-key">E</span></span></div>
    <div class="fl-onb__st"><i></i>Open the map<span class="fl-keys"><span class="fl-key">M</span></span></div>
    <div class="fl-onb__st"><i></i>Phrase wheel<span class="fl-keys"><span class="fl-key">G</span></span></div>
    <div class="fl-onb__st is-opt"><i></i>Voice (optional)<span class="fl-keys"><span class="fl-key">V</span></span></div>
    <div class="fl-onb__st"><i></i>Walk through a portal<span class="fl-keys"></span></div>
  </section>
  <div class="fl-onb__rail"><span class="fl-onb__rail-t">Step <b>4</b> of 12</span><div class="fl-onb__segs"><i class="is-done"></i><i class="is-done"></i><i class="is-done"></i><i class="is-now"></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div></div>
  <div class="fl-onb__skip"><button class="fl-btn fl-btn--sm">Skip tutorial</button><small>You can replay it from the Esc menu</small></div>
  <section class="fl-onb__step fl-holo fl-corners" aria-live="polite">
    <span class="fl-onb__step-k">Step 4 · Sprint</span>
    <h2>Run faster</h2>
    <div class="fl-onb__keys"><span class="fl-key fl-key--wide">Shift</span><span class="fl-onb__plus">+</span><span class="fl-key">W</span></div>
    <p>Hold <b>Shift</b> while you move. Sprinting is <b>9 m/s</b>; you can't attack while you sprint.</p>
    <div class="fl-onb__hold"><span class="fl-bar"><i style="--fill:.62"></i></span><span class="num">1.9 / 3 s</span></div>
    <div class="fl-onb__next"><span>Next</span><b>Dodge <span class="fl-key">C</span></b></div>
  </section>
  <div class="fl-callout" style="--x: 41vw; --y: 40vh"><div class="fl-callout__line"></div><div class="fl-callout__dot"></div><div class="fl-callout__box fl-holo">Training dummies · 3<small>10 XP each. They hold still. The world won't.</small></div></div>
</div>`;
