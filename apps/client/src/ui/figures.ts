// Starter figures for the character screen (Entry B, original placeholder art until the GLB renders
// land). Palette colours come from CSS: .fp/.fs/.fa fill primary/secondary/accent; .sp/.ss/.sa stroke.
// Brother Ash shows his face under the hood with a brass face-guard (IP line: no dark hood with two
// glowing eyes). Symbols: #ch-hexwick, #ch-ash, #ch-kappa, #ch-unit7.

export const FIGURE_IDS = ["ch-hexwick", "ch-ash", "ch-kappa", "ch-unit7"] as const;

export const FIGURE_DEFS = `
<filter id="fl-fig-glow" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="3" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
<filter id="fl-fig-blade" x="-80%" y="-20%" width="260%" height="140%"><feGaussianBlur stdDeviation="5" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
<linearGradient id="fl-fig-shade" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#000" stop-opacity=".32"/><stop offset=".55" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#fff" stop-opacity=".08"/></linearGradient>

<!-- BROTHER ASH — hooded desert monk-knight, Sunbrand -->
<symbol id="ch-ash" viewBox="0 0 240 360">
  <ellipse cx="120" cy="346" rx="62" ry="8" fill="#000" opacity=".45"/>
  <!-- robe -->
  <path d="M84 124 C78 200 72 270 64 342 L178 342 C170 270 164 200 158 124 Z" class="fp"/>
  <path d="M84 124 C78 200 72 270 64 342 L178 342 C170 270 164 200 158 124 Z" fill="url(#fl-fig-shade)"/>
  <g class="ss" stroke-width="2" opacity=".55"><path d="M70 312 L172 312 M68 322 L174 322 M67 332 L175 332"/></g>
  <g class="fa" opacity=".5"><rect x="80" y="316" width="10" height="3"/><rect x="104" y="316" width="10" height="3"/><rect x="128" y="316" width="10" height="3"/><rect x="152" y="316" width="10" height="3"/></g>
  <!-- sash + belt -->
  <path d="M86 150 L158 206 L158 224 L84 168 Z" class="fs"/>
  <rect x="82" y="214" width="78" height="11" class="fs"/>
  <rect x="114" y="213" width="14" height="13" fill="#c9973f"/>
  <!-- left arm (hanging) -->
  <path d="M86 128 C72 162 68 198 70 230 L88 230 C88 198 92 168 100 148 Z" class="fp"/>
  <path d="M86 128 C72 162 68 198 70 230 L88 230 C88 198 92 168 100 148 Z" fill="#000" opacity=".22"/>
  <circle cx="79" cy="234" r="7" fill="#b88a64"/>
  <!-- layered shoulder cloth -->
  <path d="M64 120 Q96 96 132 108 Q112 150 106 204 Q86 198 60 206 Q58 160 64 120 Z" class="fp"/>
  <path d="M64 120 Q96 96 132 108 Q112 150 106 204 Q86 198 60 206 Q58 160 64 120 Z" fill="#000" opacity=".12"/>
  <path d="M64 120 Q96 96 132 108" fill="none" stroke="#fff3df" stroke-width="1.5" opacity=".35"/>
  <!-- beads -->
  <g fill="#c9973f"><circle cx="112" cy="128" r="3"/><circle cx="120" cy="131" r="3"/><circle cx="128" cy="132" r="3"/><circle cx="136" cy="131" r="3"/><circle cx="144" cy="128" r="3"/><circle cx="128" cy="140" r="4"/></g>
  <!-- right arm raised with Sunbrand -->
  <path d="M154 124 C172 138 184 160 190 182 L176 190 C168 170 158 156 148 146 Z" class="fp"/>
  <circle cx="184" cy="186" r="8" fill="#b88a64"/>
  <path d="M186 178 L226 40 L233 42 L196 182 Z" fill="#fff3d6" filter="url(#fl-fig-blade)"/>
  <path d="M190 176 L227 46" stroke="#ffb347" stroke-width="2" opacity=".8"/>
  <rect x="176" y="178" width="18" height="24" rx="3" transform="rotate(16 185 190)" fill="none" stroke="#c9973f" stroke-width="3"/>
  <circle cx="185" cy="190" r="3" class="fa" filter="url(#fl-fig-glow)"/>
  <!-- hood -->
  <path d="M86 114 Q76 60 112 34 Q134 22 152 34 Q172 50 166 84 Q162 106 156 118 Q120 128 86 114 Z" class="fp"/>
  <path d="M152 34 Q176 28 184 48 Q170 44 160 54 Z" class="fp"/>
  <path d="M86 114 Q76 60 112 34 Q134 22 152 34" fill="none" stroke="#fff3df" stroke-width="1.5" opacity=".3"/>
  <path d="M152 34 Q172 50 166 84 Q162 106 156 118 Q140 122 128 122 Q150 90 140 50 Z" fill="#000" opacity=".2"/>
  <!-- face: visible under the hood, brass face-guard over nose and mouth (no glowing eyes) -->
  <ellipse cx="122" cy="84" rx="21" ry="25" fill="#2a1d14"/>
  <ellipse cx="122" cy="87" rx="16" ry="20" fill="#c99a72"/>
  <path d="M105 76 Q122 62 139 76 Q131 70 122 70 Q113 70 105 76 Z" fill="#000" opacity=".28"/>
  <path d="M110.5 78.6 l7.5 -1.3 M126 77.3 l7.5 1.3" stroke="#4a3426" stroke-width="1.8" stroke-linecap="round"/>
  <ellipse cx="115" cy="84.5" rx="2.6" ry="3.4" fill="#1d1512"/><ellipse cx="129" cy="84.5" rx="2.6" ry="3.4" fill="#1d1512"/>
  <circle cx="116" cy="83" r=".9" fill="#fff"/><circle cx="130" cy="83" r=".9" fill="#fff"/>
  <path d="M106 92 Q122 100 138 92 L136 105 Q122 112 108 105 Z" fill="#c9973f"/>
  <path d="M108 94 Q122 101 136 94" fill="none" stroke="#ffe2a8" stroke-width="1" opacity=".7"/>
  <circle cx="112" cy="99" r="1.3" fill="#8a5a35"/><circle cx="132" cy="99" r="1.3" fill="#8a5a35"/>
  <ellipse cx="102" cy="344" rx="14" ry="5" fill="#1d1512"/><ellipse cx="140" cy="344" rx="14" ry="5" fill="#1d1512"/>
</symbol>

<!-- HEXWICK — young wizard, Hexquill -->
<symbol id="ch-hexwick" viewBox="0 0 240 360">
  <ellipse cx="120" cy="346" rx="66" ry="8" fill="#000" opacity=".45"/>
  <!-- trailing scarf (single colour) -->
  <path d="M104 116 C78 120 54 110 30 126 C50 132 70 138 100 130 Z" class="fs"/>
  <path d="M30 126 C50 132 70 138 100 130" fill="none" stroke="#000" stroke-opacity=".25" stroke-width="2"/>
  <!-- robe flaring at the hem -->
  <path d="M98 118 C92 180 82 250 56 342 L184 342 C158 250 148 180 142 118 Z" class="fp"/>
  <path d="M98 118 C92 180 82 250 56 342 L184 342 C158 250 148 180 142 118 Z" fill="url(#fl-fig-shade)"/>
  <path d="M56 342 L184 342 L180 330 L60 330 Z" class="fs" opacity=".85"/>
  <path d="M121 128 L118 338" class="ss" stroke-width="3" opacity=".7"/>
  <g class="fa" opacity=".55"><circle cx="96" cy="250" r="1.6"/><circle cx="104" cy="262" r="1.2"/><circle cx="90" cy="276" r="1.6"/><circle cx="146" cy="232" r="1.4"/><circle cx="152" cy="250" r="1.6"/><circle cx="140" cy="292" r="1.2"/><circle cx="84" cy="304" r="1.4"/></g>
  <g class="sa" stroke-width=".8" opacity=".3"><path d="M96 250 L104 262 L90 276 M146 232 L152 250"/></g>
  <!-- satchel + quills -->
  <path d="M102 122 L154 206" stroke="#6b4a32" stroke-width="4"/>
  <g stroke="#f4efe6" stroke-width="2.5" stroke-linecap="round"><path d="M140 196 L134 178 M146 196 L146 176 M152 198 L158 182"/></g>
  <rect x="132" y="196" width="28" height="30" rx="4" fill="#6b4a32"/><rect x="132" y="196" width="28" height="9" rx="3" fill="#563a27"/>
  <!-- left sleeve -->
  <path d="M98 122 C80 150 70 190 66 224 L94 226 C96 192 102 162 106 142 Z" class="fp"/>
  <path d="M98 122 C80 150 70 190 66 224 L94 226 C96 192 102 162 106 142 Z" fill="#000" opacity=".2"/>
  <circle cx="80" cy="228" r="6.5" fill="#e8c4a0"/>
  <!-- right arm raised with the Hexquill -->
  <path d="M142 122 C160 128 176 118 186 96 L198 104 C186 132 168 150 146 148 Z" class="fp"/>
  <circle cx="193" cy="99" r="7" fill="#e8c4a0"/>
  <path d="M190 102 L220 42 Q230 46 224 60 L198 104 Z" fill="#f4efe6"/>
  <path d="M194 100 L221 48" stroke="#9aa2ab" stroke-width="1"/>
  <path d="M190 104 L185 112" class="sa" stroke-width="3" stroke-linecap="round" filter="url(#fl-fig-glow)"/>
  <!-- glyphs written in the air -->
  <g fill="none" class="sa" stroke-width="2.2" stroke-linecap="round" filter="url(#fl-fig-glow)" opacity=".95">
    <path d="M206 30 q10 -14 22 -6 q-9 9 3 17"/><path d="M188 22 l8 -9 l4 10 l8 -8"/><path d="M226 74 q8 -2 9 8 q-7 4 -11 -2"/>
  </g>
  <!-- scarf at the neck -->
  <path d="M102 112 Q120 124 140 112 L142 122 Q120 134 100 122 Z" class="fs"/>
  <!-- head -->
  <circle cx="120" cy="88" r="22" fill="#e8c4a0"/>
  <path d="M97 88 Q94 60 120 57 Q148 58 145 88 Q141 74 133 72 Q128 80 117 74 Q109 82 97 88 Z" fill="#3a2a24"/>
  <path d="M100 66 l-8 -6 l12 1 M140 64 l9 -5 l-4 9 M118 58 l2 -9 l5 9" fill="#3a2a24"/>
  <ellipse cx="112.5" cy="91" rx="2.8" ry="3.6" fill="#1d1512"/><ellipse cx="127.5" cy="91" rx="2.8" ry="3.6" fill="#1d1512"/>
  <circle cx="113.5" cy="89.5" r="1" fill="#fff"/><circle cx="128.5" cy="89.5" r="1" fill="#fff"/>
  <ellipse cx="100" cy="344" rx="13" ry="5" fill="#1d1512"/><ellipse cx="142" cy="344" rx="13" ry="5" fill="#1d1512"/>
</symbol>

<!-- KAPPA — folklore river ninja, Riverstaff. Skin stays green; shell rim, hat band and wraps recolour. -->
<symbol id="ch-kappa" viewBox="0 0 240 360">
  <ellipse cx="120" cy="346" rx="76" ry="9" fill="#000" opacity=".45"/>
  <!-- shell (behind) -->
  <ellipse cx="120" cy="214" rx="80" ry="88" fill="#5a4b32"/>
  <g fill="#6f5d3e"><ellipse cx="84" cy="176" rx="18" ry="14"/><ellipse cx="156" cy="176" rx="18" ry="14"/><ellipse cx="70" cy="222" rx="14" ry="18"/><ellipse cx="170" cy="222" rx="14" ry="18"/><ellipse cx="86" cy="270" rx="18" ry="13"/><ellipse cx="154" cy="270" rx="18" ry="13"/></g>
  <ellipse cx="120" cy="214" rx="80" ry="88" fill="none" class="sp" stroke-width="6"/>
  <!-- legs -->
  <path d="M86 280 L80 338 L112 338 L112 288 Z M128 288 L128 338 L160 338 L154 280 Z" fill="#6f9a4a"/>
  <path d="M76 340 l8 -6 l8 6 l8 -6 l8 6 Z M126 340 l8 -6 l8 6 l8 -6 l8 6 Z" fill="#577a3a"/>
  <!-- body + plastron -->
  <ellipse cx="120" cy="226" rx="52" ry="62" fill="#6f9a4a"/>
  <ellipse cx="120" cy="232" rx="34" ry="46" fill="#d8c890"/>
  <g stroke="#a99a64" stroke-width="2"><path d="M88 212 L152 212 M86 236 L154 236 M90 260 L150 260 M120 188 L120 278"/></g>
  <rect x="70" y="262" width="100" height="10" class="fs"/>
  <!-- left arm -->
  <path d="M72 196 C58 214 56 238 62 256 L76 254 C72 238 76 220 86 208 Z" fill="#6f9a4a"/>
  <rect x="58" y="242" width="18" height="7" class="fs"/>
  <!-- Riverstaff + right arm -->
  <rect x="179" y="54" width="8" height="296" rx="3" fill="#8a5a35"/>
  <rect x="179" y="54" width="3" height="296" fill="#d39a5e" opacity=".55"/>
  <g fill="#d9c27a"><rect x="177" y="104" width="12" height="8"/><rect x="177" y="300" width="12" height="8"/></g>
  <path d="M164 196 C178 210 184 230 184 246 L170 250 C168 234 162 220 152 210 Z" fill="#6f9a4a"/>
  <rect x="172" y="236" width="20" height="7" class="fs"/>
  <path d="M174 250 l6 -10 l6 10 l6 -8 v10 h-18 Z" fill="#577a3a"/>
  <!-- head -->
  <ellipse cx="120" cy="146" rx="34" ry="28" fill="#6f9a4a"/>
  <path d="M104 152 Q120 172 136 152 Q120 160 104 152 Z" fill="#d9b24a"/>
  <circle cx="107" cy="140" r="5.5" fill="#1d1512"/><circle cx="133" cy="140" r="5.5" fill="#1d1512"/>
  <circle cx="108.5" cy="138" r="1.6" fill="#fff"/><circle cx="134.5" cy="138" r="1.6" fill="#fff"/>
  <!-- straw hat (kasa) -->
  <path d="M34 128 L120 70 L206 128 Q120 140 34 128 Z" fill="#d8b26e"/>
  <path d="M34 128 L120 70 L206 128" fill="none" stroke="#fff3df" stroke-width="1.5" opacity=".35"/>
  <g stroke="#a8823f" stroke-width="1.5" opacity=".7"><path d="M120 72 L60 126 M120 72 L90 130 M120 72 L120 132 M120 72 L150 130 M120 72 L180 126"/></g>
  <path d="M74 106 L166 106 L176 113 L64 113 Z" class="fp"/>
</symbol>

<!-- UNIT 7 — ivory trooper, single round lens, Pocket Carbine -->
<symbol id="ch-unit7" viewBox="0 0 240 360">
  <ellipse cx="120" cy="346" rx="60" ry="8" fill="#000" opacity=".45"/>
  <!-- radio pack + antenna -->
  <rect x="160" y="104" width="20" height="30" rx="3" fill="#4b525b"/>
  <path d="M174 106 L190 62" stroke="#4b525b" stroke-width="2.5"/><circle cx="190" cy="62" r="3" class="fa"/>
  <!-- undersuit -->
  <path d="M88 130 L152 130 L158 222 L82 222 Z" class="fs"/>
  <path d="M86 220 L82 338 L114 338 L118 230 Z M122 230 L126 338 L158 338 L154 220 Z" class="fs"/>
  <!-- leg plates -->
  <g class="fp"><rect x="84" y="232" width="30" height="40" rx="6"/><rect x="126" y="232" width="30" height="40" rx="6"/><rect x="83" y="286" width="30" height="44" rx="6"/><rect x="127" y="286" width="30" height="44" rx="6"/></g>
  <g fill="#000" opacity=".14"><rect x="84" y="232" width="10" height="40"/><rect x="83" y="286" width="10" height="44"/></g>
  <rect x="80" y="330" width="36" height="12" rx="4" fill="#3a3f46"/><rect x="124" y="330" width="36" height="12" rx="4" fill="#3a3f46"/>
  <!-- torso plates -->
  <path d="M84 132 Q120 118 156 132 L152 194 Q120 206 88 194 Z" class="fp"/>
  <path d="M84 132 Q120 118 156 132 L152 194 Q120 206 88 194 Z" fill="url(#fl-fig-shade)"/>
  <path d="M120 126 L120 200 M90 162 L150 162" stroke="#000" stroke-opacity=".18" stroke-width="1.5"/>
  <g class="fp"><rect x="96" y="200" width="48" height="9" rx="3"/><rect x="98" y="211" width="44" height="8" rx="3"/></g>
  <!-- pauldrons + stencil -->
  <ellipse cx="80" cy="140" rx="21" ry="17" class="fp"/><ellipse cx="160" cy="140" rx="21" ry="17" class="fp"/>
  <ellipse cx="80" cy="140" rx="21" ry="17" fill="#000" opacity=".15"/>
  <text x="160" y="146" text-anchor="middle" font-family="ui-monospace, Menlo, monospace" font-weight="700" font-size="15" class="fs">07</text>
  <!-- arms -->
  <path d="M66 150 C62 180 74 204 100 214 L108 202 C90 196 82 180 84 156 Z" class="fs"/>
  <rect x="64" y="160" width="18" height="26" rx="5" class="fp"/>
  <path d="M174 150 C180 176 172 196 150 206 L142 196 C156 188 160 174 156 156 Z" class="fs"/>
  <rect x="160" y="160" width="18" height="24" rx="5" class="fp"/>
  <!-- Pocket Carbine -->
  <g transform="rotate(-10 140 200)">
    <rect x="86" y="194" width="96" height="20" rx="3" fill="#3a3f46"/>
    <rect x="182" y="199" width="22" height="8" rx="2" fill="#2c3036"/>
    <rect x="108" y="184" width="30" height="11" rx="2" class="fa" filter="url(#fl-fig-glow)"/>
    <rect x="98" y="214" width="12" height="16" rx="2" fill="#2c3036"/>
    <path d="M88 198 L180 198" stroke="#9aa2ab" stroke-width="1.5" opacity=".6"/>
  </g>
  <circle cx="102" cy="212" r="7" class="fs"/><circle cx="148" cy="204" r="7" class="fs"/>
  <!-- helmet with ONE round lens -->
  <rect x="106" y="114" width="28" height="14" rx="4" class="fs"/>
  <circle cx="120" cy="90" r="33" class="fp"/>
  <path d="M90 104 Q120 120 150 104 L148 112 Q120 126 92 112 Z" fill="#000" opacity=".18"/>
  <path d="M96 66 Q120 52 146 70" fill="none" stroke="#fff" stroke-opacity=".5" stroke-width="2"/>
  <circle cx="128" cy="93" r="12.5" fill="#1f2328"/>
  <circle cx="128" cy="93" r="8" class="fa" filter="url(#fl-fig-glow)"/>
  <circle cx="125" cy="90" r="2.5" fill="#fff" opacity=".85"/>
</symbol>

`;
