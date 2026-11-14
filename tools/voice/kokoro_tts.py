"""Speak a batch of lines with Kokoro-82M (Apache-2.0) through kokoro-onnx (MIT), on the CPU.

    <venv>/bin/python -I tools/voice/kokoro_tts.py <model dir> <jobs.json>

jobs.json: [{"id", "text", "voice": "am_fenrir" | [["am_fenrir", 0.6], ["bm_george", 0.4]],
"lang": "en-us" | "en-gb", "speed": 1.0, "out": "/tmp/.../id.wav"}]. Writes one 24 kHz WAV per job
and prints one line per file. tools/voice/generate.ts makes the jobs and processes the WAVs.
"""

import json
import sys
import time

import numpy as np
import soundfile as sf
from kokoro_onnx import Kokoro


def main() -> None:
    model_dir, jobs_file = sys.argv[1], sys.argv[2]
    kokoro = Kokoro(f"{model_dir}/kokoro-v1.0.onnx", f"{model_dir}/voices-v1.0.bin")
    jobs = json.load(open(jobs_file))
    for i, job in enumerate(jobs):
        voice = job["voice"]
        if isinstance(voice, list):
            # A blend: the weighted mean of the voices' style vectors.
            style = sum(kokoro.get_voice_style(name) * w for name, w in voice) / sum(w for _, w in voice)
            voice = style.astype(np.float32)
        t = time.time()
        samples, rate = kokoro.create(job["text"], voice=voice, speed=job.get("speed", 1.0), lang=job.get("lang", "en-us"))
        sf.write(job["out"], samples, rate)
        print(f"{i + 1}/{len(jobs)} {job['id']} {len(samples) / rate:.2f}s in {time.time() - t:.1f}s", flush=True)


if __name__ == "__main__":
    main()
