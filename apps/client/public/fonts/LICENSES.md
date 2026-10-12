# Fonts

FIRSTLIGHT self-hosts three typefaces (latin subset, only the weights the UI uses). They are bundled
from the `@fontsource/*` npm packages by Vite into `/assets`; no font CDN is contacted at runtime.

| Family | Weights | Use | Author | Licence |
|---|---|---|---|---|
| Barlow Semi Condensed | 300, 500, 600, 700 | Display, HUD labels, numbers | Jeremy Tribby | SIL Open Font License 1.1 |
| Inter | 400, 500, 600 | Body text | Rasmus Andersson / The Inter Project Authors | SIL Open Font License 1.1 |
| JetBrains Mono | 500, 600, 700 | Keys, counters, Meridian Oversight | JetBrains | SIL Open Font License 1.1 |

Packages: `@fontsource/barlow-semi-condensed@5.3.0`, `@fontsource/inter@5.3.0`,
`@fontsource/jetbrains-mono@5.3.0` (each ships the full OFL text in its `LICENSE` file).
The OFL allows bundling and redistribution with software; the fonts are not sold on their own.
Licence text: https://openfontlicense.org/open-font-license-official-text/
