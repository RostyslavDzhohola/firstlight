# FIRSTLIGHT sculpted characters: smoke test for a recipe (construction, field and paint calls on a few
# points) before spending minutes on a build.
#   blender -b --factory-startup --python check_recipe.py -- hexwick,ninja,...
import importlib
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import numpy as np  # noqa: E402

from part import Ctx  # noqa: E402

names = sys.argv[sys.argv.index("--") + 1].split(",")
rng = np.random.default_rng(1)
for n in names:
    t = time.time()
    try:
        parts = importlib.import_module(f"recipes.{n}").parts()
    except Exception as e:  # noqa: BLE001
        import traceback
        traceback.print_exc()
        print("CHECK", n, "construct FAILED", e)
        continue
    print("CHECK", n, "constructed", len(parts), "parts", f"{time.time() - t:.1f}s")
    P = (rng.random((2000, 3)) * np.array([1.6, 0.8, 2.0]) - np.array([0.8, 0.4, 0.0])).astype(np.float32)
    N = rng.normal(size=(2000, 3)).astype(np.float32)
    N /= np.linalg.norm(N, axis=1, keepdims=True)
    for p in parts:
        try:
            d = p.field(P)
            assert d.shape == (2000,), d.shape
            ctx = Ctx(p, P, N, np.zeros(2000, np.float32), np.ones(2000, np.float32))
            if p.paint:
                r = p.paint(ctx)
                rgb = r[0] if isinstance(r, tuple) else r
                assert rgb.shape == (2000, 3), rgb.shape
            if p.weights and p.weights[0] == "fn":
                p.weights[1](P)
            if p.weights and p.weights[0] == "auto" and len(p.weights) > 3 and p.weights[3]:
                p.weights[3](P)
            print("CHECK", n, p.name, "ok", f"min {float(d.min()):.3f}")
        except Exception as e:  # noqa: BLE001
            import traceback
            traceback.print_exc()
            print("CHECK", n, p.name, "FAILED", e)
