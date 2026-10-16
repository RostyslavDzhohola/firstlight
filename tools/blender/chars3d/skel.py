# FIRSTLIGHT sculpted characters: rest-pose joint positions of the shared skeleton (Quaternius UAL,
# T-pose, facing -Y), dumped once from the rig by build.py into rig_rest.json.
# Our own code: MIT.

import json
import os

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))


class Skel:
    def __init__(self, path=None):
        with open(path or os.path.join(HERE, "rig_rest.json")) as fh:
            self.b = json.load(fh)

    def head(self, n):
        return np.asarray(self.b[n]["head"], dtype=np.float32)

    def tail(self, n):
        return np.asarray(self.b[n]["tail"], dtype=np.float32)

    def mid(self, n, t=0.5):
        return self.head(n) * (1 - t) + self.tail(n) * t

    def parent(self, n):
        return self.b[n]["parent"]

    def names(self):
        return list(self.b)

    def side(self, n, s):
        """bone name for side s in (+1 left, -1 right)."""
        return f"{n}_{'l' if s > 0 else 'r'}"
