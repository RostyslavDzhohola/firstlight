# Third-party software in the FIRSTLIGHT web client

The client bundle that Vite builds into `/assets` contains code from the npm packages below. Vite
removes their licence comments when it minifies, so their notices are collected here and served
with the site. All of them use the MIT License, reproduced once at the end. Fonts are covered
separately in `/fonts/LICENSES.md` (SIL Open Font License 1.1).

List made on 2026-10-12 from the source maps of a client build (`vite build --sourcemap` into a
temporary folder). Rebuild it the same way when client dependencies change.

| Package | Version | Copyright notice (from the package's LICENSE file) | Source |
|---|---|---|---|
| three | 0.186.1 | Copyright © 2010-2026 three.js authors | https://github.com/mrdoob/three.js |
| meshoptimizer decoder (bundled in three's `examples/jsm/libs/meshopt_decoder.module.js`) | 1.1 | Copyright (C) 2016-2026, by Arseny Kapoulkine | https://github.com/zeux/meshoptimizer |
| @dgreenheck/three-pinata | 2.0.1 | Copyright (c) 2023 Daniel Greenheck | https://github.com/dgreenheck/three-pinata |
| zzfx | 1.4.0 | Copyright (c) 2019 Frank Force | https://github.com/KilledByAPixel/ZzFX |
| @colyseus/sdk | 0.18.5 | Copyright (c) 2015-2026 Endel Dreyer | https://github.com/colyseus/colyseus |
| @colyseus/shared-types | 0.18.3 | Copyright (c) 2015-2026 Endel Dreyer | https://github.com/colyseus/colyseus |
| @colyseus/schema | 5.0.36 | Copyright (c) 2018 Endel Dreyer | https://github.com/colyseus/schema |
| msgpackr | 2.1.0 | Copyright (c) 2020 Kris Zyp | https://github.com/kriszyp/msgpackr |
| ws (browser stub) | 8.22.0 | Copyright (c) 2011 Einar Otto Stangvik | https://github.com/websockets/ws |
| better-auth | 1.7.7 | Copyright (c) 2024 - present, Bereket Engida | https://github.com/better-auth/better-auth |
| @better-auth/core | 1.7.7 | Copyright (c) 2024 - present, Bereket Engida | https://github.com/better-auth/better-auth |
| better-call | 1.4.0 | Copyright (c) 2025 Bereket Engida | https://github.com/better-auth/better-call |
| @better-fetch/fetch | 1.3.2 | Copyright (c) Bereket Engida | https://github.com/better-auth/better-fetch |
| nanostores | 1.5.5 | Copyright 2020 Andrey Sitnik | https://github.com/nanostores/nanostores |
| defu | 6.1.7 | Copyright (c) Pooya Parsa | https://github.com/unjs/defu |

## MIT License

Each package above is distributed under this licence, with its own copyright notice from the table
in place of "the above copyright notice".

```
Copyright (c) <year> <copyright holders>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```
