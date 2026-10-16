# Hollowmere WebGL frame dip: evidence (2026-10-16, lane/view-polish)

Codex's combined check measured 52.1 fps (p95 50 ms) on WebGL Medium at Hollowmere's walled outpost. Decision: D-view-2.

1. Uncapped (vsync off), WebGL, Medium, Hollowmere arrival outpost, 1360x765: median frame 3.9 ms (~256 fps).
   Feature costs uncapped: bloom 0.3 ms, shadows 1.4 ms, fog 0.5 ms, grass 0.4 ms, FXAA 0.3 ms.
   (The overlay's "gpu 9-12 ms" at 60 fps is the M1 GPU clocking down between frames.)
2. The dip is a run of 33/50 ms frames lasting ~0.4 s, a few times a minute, with no change in draws,
   triangles, shader builds or particles. A Chrome trace shows the GPU process blocked in
   ImageTransportSurfaceOverlayMac::Present / CommitPresentedFrameToCA (12 ms per present).
3. A trivial WebGL page that only clears the canvas shows the same clusters (2 in 150 s; 4 in 260 s).
4. Run side by side in two browsers, every stall cluster of the game (3) started within 4-37 ms of one
   on the trivial page: that strongly suggests machine-wide Chrome/GPU present stalls rather than the
   game's own work (it doesn't fully rule out the game adding to the contention).
   Two game browsers in the same server room also stalled together (WebGL and WebGPU).
5. Without a stall, Hollowmere WebGL Medium at the outpost: 60.1 fps, p95 16.7-16.8 ms (fog, drizzle,
   clear; 12-40 s windows).

Raw files (not in the repo): /tmp/fl-go/shots/view-polish/hollowmere-dip-evidence.txt and the traces under /tmp/fl-go/shots/view-polish/e2e/holl/.
