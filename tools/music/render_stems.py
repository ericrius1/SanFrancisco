#!/usr/bin/env python3
"""Offline renderer for the baked tape-texture stem.

Renders the one unpitched bed that still earns being baked: a dusty tape
texture that sits under the generative score. It is deliberately non-harmonic
— no pitched content — so it can never clash with the runtime chord walk,
whatever key a region is in.

The three drum loops this script used to render are gone. Rhythm is now
synthesized and performed per region at runtime by src/audio/music/groove.ts +
percussionWorker.ts, which is where the ported kick/rim/shaker DSP lives now.

Output contract (consumed by src/audio/music/stemManifest.ts):
  * a 48 kHz stereo MP3 in public/audio/music/stems/
  * the dust bed bakes equal-power 4 s fades at both ends; the runtime
    overlap-schedules it every (duration - 4 s)

Deterministic (fixed seed) — re-running reproduces an identical file.

  python3 tools/music/render_stems.py

Requires numpy + scipy + ffmpeg (loudness targets are peak-normalized here,
final level lives in the manifest gainTrim / runtime mixer).
"""

from __future__ import annotations

import argparse
import os
import subprocess
import tempfile
from pathlib import Path

import numpy as np
from scipy import signal
from scipy.io import wavfile

SR = 48_000
ROOT = Path(__file__).resolve().parents[2]
OUT_DIR = ROOT / "public" / "audio" / "music" / "stems"
FFMPEG = os.environ.get("FFMPEG_BINARY", "ffmpeg")


# ----------------------------------------------------------------- helpers

def seconds(n: float) -> int:
    return int(round(n * SR))


def env_exp(length: int, tau: float) -> np.ndarray:
    t = np.arange(length) / SR
    return np.exp(-t / tau)


def lowpass(x: np.ndarray, hz: float, order: int = 2) -> np.ndarray:
    sos = signal.butter(order, hz, btype="low", fs=SR, output="sos")
    return signal.sosfilt(sos, x)


def bandpass(x: np.ndarray, lo: float, hi: float, order: int = 2) -> np.ndarray:
    sos = signal.butter(order, [lo, hi], btype="band", fs=SR, output="sos")
    return signal.sosfilt(sos, x)


# ------------------------------------------------------------------ texture

def render_dust(*, loop_s: float = 20.0, overlap_s: float = 4.0, seed: int = 11) -> np.ndarray:
    """Tape-dust texture: pink hiss waves, soft crackle clusters, slow reversed
    swells. Equal-power fades of `overlap_s` baked at both ends."""
    rng = np.random.default_rng(seed)
    n = seconds(loop_s + overlap_s)
    t = np.arange(n) / SR

    pink = signal.lfilter([0.049922, -0.095993, 0.050612, -0.004408],
                          [1, -2.494956, 2.017265, -0.522189], rng.standard_normal(n))
    waves = 0.55 + 0.3 * np.sin(2 * np.pi * 0.05 * t) + 0.15 * np.sin(2 * np.pi * 0.013 * t + 1.3)
    bed = lowpass(pink, 3200) * waves * 0.16

    crackle = np.zeros(n)
    pos = 0
    while pos < n:
        pos += int(rng.exponential(SR * 0.45))
        if pos >= n:
            break
        size = rng.random() ** 2
        pop = env_exp(seconds(0.004 + 0.01 * size), 0.004) * (rng.random() * 2 - 1)
        end = min(n, pos + len(pop))
        crackle[pos:end] += pop[: end - pos] * 0.5 * size
    crackle = lowpass(crackle, 5200) * 0.4

    swells = np.zeros(n)
    for start in np.arange(2.0, loop_s + overlap_s - 4.0, 7.5):
        s0 = seconds(start + rng.random() * 2)
        length = seconds(2.6)
        if s0 + length >= n:
            continue
        grain = bandpass(rng.standard_normal(length), 400, 2400)
        rise = (np.arange(length) / length) ** 2.2
        swells[s0 : s0 + length] += grain * rise * 0.12

    mono = bed + crackle + swells
    left = mono
    right = np.roll(mono, seconds(0.011)) * 0.96 + lowpass(rng.standard_normal(n), 2800) * 0.015
    mix = np.stack([left, right], axis=1)

    fade = seconds(overlap_s)
    ramp = np.sin(np.linspace(0, np.pi / 2, fade)) ** 2
    mix[:fade] *= ramp[:, None]
    mix[-fade:] *= ramp[::-1][:, None]

    mix *= 0.5 / max(1e-9, np.max(np.abs(mix)))
    return mix.astype(np.float32)


# ------------------------------------------------------------------ output

def write_mp3(name: str, data: np.ndarray) -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        wav_path = Path(tmp.name)
    wavfile.write(wav_path, SR, (np.clip(data, -1, 1) * 32767).astype(np.int16))
    mp3_path = OUT_DIR / f"{name}.mp3"
    subprocess.run(
        [FFMPEG, "-y", "-loglevel", "error", "-i", str(wav_path),
         "-codec:a", "libmp3lame", "-q:a", "4", str(mp3_path)],
        check=True,
    )
    wav_path.unlink()
    rms = float(np.sqrt(np.mean(np.square(data))))
    print(f"{mp3_path.relative_to(ROOT)}  {len(data)/SR:6.2f}s  peak={np.max(np.abs(data)):.3f} rms={rms:.4f} "
          f"size={mp3_path.stat().st_size/1024:.0f}KiB")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--stem",
        action="append",
        choices=("dust",),
        help="render only the selected stem (repeatable); default renders all",
    )
    selected = set(parser.parse_args().stem or ("dust",))

    if "dust" in selected:
        write_mp3("dust", render_dust())
    print("\nloopSeconds: dust = 20.0")


if __name__ == "__main__":
    main()
