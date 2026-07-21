#!/usr/bin/env python3
"""Offline renderer for the baked lo-fi music stems.

Renders the unpitched stem layer that sits under the generative score:
two humanized lo-fi drum grooves (day / dusk) and a dusty tape-texture bed.
Stems are deliberately non-harmonic — no pitched content — so they can never
clash with the runtime chord walk, whatever key a region is in.

Output contract (consumed by src/audio/music/stemManifest.ts):
  * 48 kHz stereo MP3s in public/audio/music/stems/
  * each groove file = exactly LOOP bars of musical time + a ringing tail;
    the runtime schedules overlapping repeats every `loopSeconds`, so encoder
    padding never causes gaps (it detects the leading pad by first-transient
    scan and lets tails overlap naturally)
  * the dust bed bakes equal-power 4 s fades at both ends; the runtime
    overlap-schedules it every (duration - 4 s)

Deterministic (fixed seeds) — re-running reproduces identical files.

  python3 tools/music/render_stems.py

Requires numpy + scipy + ffmpeg (loudness targets are peak-normalized here,
final level lives in the manifest gainTrim / runtime mixer).
"""

from __future__ import annotations

import subprocess
import tempfile
from pathlib import Path

import numpy as np
from scipy import signal
from scipy.io import wavfile

SR = 48_000
ROOT = Path(__file__).resolve().parents[2]
OUT_DIR = ROOT / "public" / "audio" / "music" / "stems"


# ----------------------------------------------------------------- helpers

def seconds(n: float) -> int:
    return int(round(n * SR))


def env_exp(length: int, tau: float) -> np.ndarray:
    t = np.arange(length) / SR
    return np.exp(-t / tau)


def lowpass(x: np.ndarray, hz: float, order: int = 2) -> np.ndarray:
    sos = signal.butter(order, hz, btype="low", fs=SR, output="sos")
    return signal.sosfilt(sos, x)


def highpass(x: np.ndarray, hz: float, order: int = 2) -> np.ndarray:
    sos = signal.butter(order, hz, btype="high", fs=SR, output="sos")
    return signal.sosfilt(sos, x)


def bandpass(x: np.ndarray, lo: float, hi: float, order: int = 2) -> np.ndarray:
    sos = signal.butter(order, [lo, hi], btype="band", fs=SR, output="sos")
    return signal.sosfilt(sos, x)


def saturate(x: np.ndarray, drive: float) -> np.ndarray:
    return np.tanh(x * drive) / np.tanh(drive)


def place(canvas: np.ndarray, sample: np.ndarray, at: int, gain: float, pan: float) -> None:
    """Mix a mono sample into a stereo canvas with constant-power panning."""
    if at < 0:
        sample = sample[-at:]
        at = 0
    n = min(len(sample), canvas.shape[0] - at)
    if n <= 0:
        return
    theta = (pan + 1) * np.pi / 4  # -1..1 → 0..π/2
    canvas[at : at + n, 0] += sample[:n] * gain * np.cos(theta)
    canvas[at : at + n, 1] += sample[:n] * gain * np.sin(theta)


# ------------------------------------------------------------------ voices

def kick(rng: np.random.Generator, deep: bool = False) -> np.ndarray:
    dur = 0.32 if deep else 0.22
    n = seconds(dur)
    t = np.arange(n) / SR
    f0, f1, tau = (34.0, 82.0, 0.055) if deep else (42.0, 96.0, 0.04)
    freq = f0 + f1 * np.exp(-t / tau)
    phase = 2 * np.pi * np.cumsum(freq) / SR
    body = np.sin(phase) * env_exp(n, 0.16 if deep else 0.11)
    click = highpass(rng.standard_normal(seconds(0.004)), 1200)
    out = body.copy()
    out[: len(click)] += click * 0.18
    return lowpass(saturate(out, 1.7), 2800)


def rim(rng: np.random.Generator, soft: bool = False) -> np.ndarray:
    n = seconds(0.14)
    t = np.arange(n) / SR
    body = np.sin(2 * np.pi * 195 * t) * env_exp(n, 0.045) * 0.7
    knock = np.sin(2 * np.pi * 720 * t) * env_exp(n, 0.012) * (0.35 if soft else 0.6)
    snap = bandpass(rng.standard_normal(n), 900, 4200) * env_exp(n, 0.028)
    out = body + knock + snap * (0.5 if soft else 0.8)
    return lowpass(saturate(out, 1.4), 3600)


def shaker(rng: np.random.Generator, open_: bool = False) -> np.ndarray:
    n = seconds(0.16 if open_ else 0.05)
    noise = highpass(rng.standard_normal(n), 6200, order=3)
    envelope = env_exp(n, 0.06 if open_ else 0.016)
    attack = np.minimum(1.0, np.arange(n) / seconds(0.004))
    return noise * envelope * attack * 0.5


# ---------------------------------------------------------------- patterns

def render_groove(
    *,
    bpm: float,
    bars: int,
    seed: int,
    deep: bool,
    density: float,
    tail: float = 2.5,
) -> np.ndarray:
    """Humanized swung lo-fi kit over `bars` bars; events stay inside the loop,
    their tails ring into the extra `tail` seconds (overlapped at runtime)."""
    rng = np.random.default_rng(seed)
    beat = 60.0 / bpm
    loop = bars * 4 * beat
    canvas = np.zeros((seconds(loop + tail), 2), dtype=np.float64)
    swing = 0.585  # position of the off-16th inside an 8th pair

    def human(t: float, first: bool = False) -> float:
        # the downbeat of bar 0 anchors the runtime's transient scan — keep it
        jitter = 0.0 if first else float(rng.normal(0, 0.008))
        return max(0.002 if first else 0.0, t + jitter)

    for bar in range(bars):
        t0 = bar * 4 * beat
        # --- kick: boom on 1, a lazy answer late in the bar, occasional pickup
        place(canvas, kick(rng, deep), seconds(human(t0, first=(bar == 0))), 0.92, -0.05)
        if not deep or bar % 2 == 1:
            if rng.random() < 0.85:
                answer = t0 + (2.5 if rng.random() < 0.6 else 1.75) * beat
                place(canvas, kick(rng, deep), seconds(human(answer)), 0.6 + 0.2 * rng.random(), -0.05)
        if rng.random() < 0.25 * density:
            place(canvas, kick(rng, deep), seconds(human(t0 + 3.75 * beat)), 0.4, -0.05)
        # --- rim/snare backbeat on 2 and 4, soft, sometimes dropped at dusk
        for b in (1.0, 3.0):
            if deep and b == 1.0 and rng.random() < 0.5:
                continue
            place(canvas, rim(rng, soft=deep), seconds(human(t0 + b * beat)), 0.55 + 0.15 * rng.random(), 0.12)
        if rng.random() < 0.35 * density:  # ghost
            place(canvas, rim(rng, soft=True), seconds(human(t0 + 3.55 * beat)), 0.18, 0.2)
        # --- shaker: swung 8ths (day) / quarters (dusk), velocity waves
        steps = 8 if not deep else 4
        for s in range(steps):
            if rng.random() > (0.94 if not deep else 0.8) * density:
                continue
            if steps == 8:  # swung 8ths: odd hits land late
                frac = s * 0.5 + ((swing - 0.5) if s % 2 == 1 else 0.0)
            else:  # dusk: straight quarters
                frac = float(s)
            when = t0 + frac * beat
            vel = 0.32 + 0.22 * np.sin(s * 1.1 + bar) + 0.1 * rng.random()
            open_ = steps == 8 and s == 7 and rng.random() < 0.3
            place(canvas, shaker(rng, open_), seconds(human(when)), max(0.12, vel), 0.3)

    mix = canvas
    # glue: gentle saturation + the "worn kit" lowpass; runtime adds wow + vinyl
    mix = saturate(mix, 1.25)
    mix = np.stack([lowpass(mix[:, 0], 3800), lowpass(mix[:, 1], 3800)], axis=1)
    mix *= 0.5 / max(1e-9, np.max(np.abs(mix)))  # peak -6 dBFS
    return mix.astype(np.float32)


def render_brush(
    *,
    bpm: float = 66,
    bars: int = 8,
    seed: int = 41,
    tail: float = 2.5,
) -> np.ndarray:
    """Organic brush kit for park regions: airy swung 16th shaker, sparse wood
    clicks, and a very soft deep kick on every other bar's downbeat only --
    no backbeat snare. Same humanize/tail contract as render_groove."""
    rng = np.random.default_rng(seed)
    beat = 60.0 / bpm
    loop = bars * 4 * beat
    canvas = np.zeros((seconds(loop + tail), 2), dtype=np.float64)
    swing = 0.585  # position of the off-16th inside a 16th pair

    def human(t: float, first: bool = False) -> float:
        jitter = 0.0 if first else float(rng.normal(0, 0.008))
        return max(0.002 if first else 0.0, t + jitter)

    for bar in range(bars):
        t0 = bar * 4 * beat
        # --- very soft deep kick, only beat 1 of every other bar
        if bar % 2 == 0:
            place(canvas, kick(rng, deep=True), seconds(human(t0, first=(bar == 0))), 0.35, -0.05)
        # --- sparse wood clicks at swung positions
        for frac in (1.5, 2.75, 3.25):
            if rng.random() < 0.5:
                when = t0 + frac * beat
                gain = 0.25 + 0.10 * rng.random()
                place(canvas, rim(rng, soft=True), seconds(human(when)), gain, 0.2)
        # --- dense brushy shaker: swung 16ths
        for s in range(16):
            if rng.random() > 0.85:
                continue
            frac = s * 0.25 + ((swing - 0.5) * 0.5 if s % 2 == 1 else 0.0)
            when = t0 + frac * beat
            vel = 0.19 + 0.09 * np.sin(s * 1.1 + bar) + 0.05 * rng.random()
            place(canvas, shaker(rng), seconds(human(when)), min(0.28, max(0.1, vel)), 0.35)
        # --- one open-shaker swirl per bar at a random beat
        swirl_when = t0 + rng.random() * 4 * beat
        place(canvas, shaker(rng, open_=True), seconds(human(swirl_when)), 0.4, 0.35)

    mix = canvas
    mix = saturate(mix, 1.15)
    mix = np.stack([lowpass(mix[:, 0], 3200), lowpass(mix[:, 1], 3200)], axis=1)
    mix *= 0.5 / max(1e-9, np.max(np.abs(mix)))  # peak -6 dBFS
    return mix.astype(np.float32)


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
        ["ffmpeg", "-y", "-loglevel", "error", "-i", str(wav_path),
         "-codec:a", "libmp3lame", "-q:a", "4", str(mp3_path)],
        check=True,
    )
    wav_path.unlink()
    rms = float(np.sqrt(np.mean(np.square(data))))
    print(f"{mp3_path.relative_to(ROOT)}  {len(data)/SR:6.2f}s  peak={np.max(np.abs(data)):.3f} rms={rms:.4f} "
          f"size={mp3_path.stat().st_size/1024:.0f}KiB")


def main() -> None:
    # manifest contract: loopSeconds derived from bpm/bars EXACTLY as below
    write_mp3("beat-warm", render_groove(bpm=72, bars=8, seed=7, deep=False, density=1.0))
    write_mp3("beat-dusk", render_groove(bpm=58, bars=8, seed=23, deep=True, density=0.8))
    write_mp3("beat-brush", render_brush())
    write_mp3("dust", render_dust())
    print("\nloopSeconds: beat-warm =", 8 * 4 * 60 / 72, " beat-dusk =", 8 * 4 * 60 / 58,
          " beat-brush =", 8 * 4 * 60 / 66, " dust = 20.0")


if __name__ == "__main__":
    main()
