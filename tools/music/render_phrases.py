#!/usr/bin/env python3
"""Offline renderer for the baked melodic phrase palette (Phase 3 hybrid).

Short Rhodes-style motifs and Karplus-Strong "guitar swell" phrases, authored
STRICTLY from pentatonic scale tones so they sit over any diatonic chord of
the runtime key. Two deliberately distinct flavors:

  * bright — brisk, playful 92 BPM major-pentatonic exploration hooks
  * dusk   — the original spacious 66 BPM minor-pentatonic phrases

All phrases are baked with root C (pc 0); the runtime transposes to the
current key via playbackRate within ±6 semitones (a little tape-speed drift is
part of the aesthetic). Rendered dry-ish — the runtime convolver supplies the
space so phrases share the score's acoustics.

Output: public/audio/music/phrases/*.mp3 (contract: phraseManifest.ts).
Deterministic — fixed seeds reproduce identical files.

  python3 tools/music/render_phrases.py
  python3 tools/music/render_phrases.py --flavor bright
"""

from __future__ import annotations

import argparse
import os
import subprocess
import tempfile
import zlib
from pathlib import Path

import numpy as np
from scipy import signal
from scipy.io import wavfile

SR = 48_000
ROOT = Path(__file__).resolve().parents[2]
OUT_DIR = ROOT / "public" / "audio" / "music" / "phrases"
FFMPEG = os.environ.get("FFMPEG_BINARY", "ffmpeg")

C4 = 60


def seconds(n: float) -> int:
    return int(round(n * SR))


def midi_freq(m: float) -> float:
    return 440.0 * 2 ** ((m - 69) / 12)


def lowpass(x: np.ndarray, hz: float, order: int = 2) -> np.ndarray:
    sos = signal.butter(order, hz, btype="low", fs=SR, output="sos")
    return signal.sosfilt(sos, x)


# ------------------------------------------------------------------ voices

def rhodes_note(f: float, dur: float, vel: float, rng: np.random.Generator) -> np.ndarray:
    """Two-operator FM electric piano: 1:1 modulator with a decaying index
    (the EP 'bark'), a fast tine partial, and a felt thump."""
    n = seconds(dur)
    t = np.arange(n) / SR
    index = 1.15 * np.exp(-t / 0.09) * vel + 0.08
    mod = np.sin(2 * np.pi * f * t) * index
    body = np.sin(2 * np.pi * f * t + mod)
    amp = np.exp(-t / 1.5) * np.minimum(1.0, t / 0.008)
    tine = np.sin(2 * np.pi * f * 3.98 * t) * np.exp(-t / 0.05) * 0.14 * vel
    thump = lowpass(rng.standard_normal(n), 300) * np.exp(-t / 0.015) * 0.4 * vel
    return (body * amp * vel + tine + thump).astype(np.float64)


def ks_swell(f: float, dur: float, vel: float, rng: np.random.Generator) -> np.ndarray:
    """Karplus-Strong pluck with the attack sanded off by a slow volume swell —
    reads as an e-bowed / reversed guitar note."""
    n = seconds(dur)
    period = max(2, int(round(SR / f)))
    buf = rng.standard_normal(period)
    out = np.empty(n)
    damp = 0.996
    prev = 0.0
    for i in range(n):
        v = buf[i % period]
        nxt = damp * 0.5 * (v + prev)
        prev = v
        buf[i % period] = nxt
        out[i] = v
    t = np.arange(n) / SR
    swell = np.minimum(1.0, (t / (dur * 0.38)) ** 2.4) * np.exp(-np.maximum(0, t - dur * 0.55) / 0.9)
    return lowpass(out * swell, 2600) * vel


def chorus(x: np.ndarray, rng: np.random.Generator) -> np.ndarray:
    """Two modulated delay taps panned apart — the classic EP shimmer."""
    n = len(x)
    t = np.arange(n) / SR
    out = np.zeros((n, 2))
    for col, (rate, phase, base) in enumerate([(0.6, 0.0, 0.012), (0.9, 1.7, 0.015)]):
        delay = base + 0.002 * np.sin(2 * np.pi * rate * t + phase)
        idx = np.arange(n) - delay * SR
        idx = np.clip(idx, 0, n - 1)
        lo = idx.astype(np.int64)
        frac = idx - lo
        hi = np.minimum(lo + 1, n - 1)
        wet = x[lo] * (1 - frac) + x[hi] * frac
        out[:, col] = x * 0.75 + wet * 0.45
    return out


# ------------------------------------------------------------------ phrases

BRIGHT = [0, 2, 4, 7, 9]  # C D E G A
DUSK = [0, 3, 5, 7, 10]  # C Eb F G Bb

# (name, flavor, voice, notes) — notes are
# (start_beats, penta_index + 5*octave, vel). Bright hooks are compact and
# syncopated; dusk retains the original long-breathing contours.
PHRASES = [
    ("sigh-bright", "bright", "rhodes",
     [(0.0, 0, 0.68), (0.5, 1, 0.5), (1.0, 2, 0.72), (2.0, 4, 0.65),
      (3.0, 2, 0.52), (3.5, 4, 0.62), (4.0, 5, 0.74), (5.5, 4, 0.5), (6.0, 2, 0.58)]),
    ("lift-bright", "bright", "rhodes",
     [(0.0, 0, 0.62), (0.5, 2, 0.5), (1.0, 4, 0.66), (1.5, 5, 0.7),
      (2.5, 4, 0.52), (3.0, 6, 0.62), (4.0, 7, 0.72), (5.0, 6, 0.48),
      (6.0, 9, 0.68), (7.0, 7, 0.56)]),
    ("turn-bright", "bright", "rhodes",
     [(0.0, 4, 0.66), (0.75, 5, 0.54), (1.25, 7, 0.68), (2.0, 5, 0.5),
      (3.0, 4, 0.62), (3.5, 2, 0.48), (4.0, 1, 0.6), (5.0, 2, 0.52),
      (6.0, 4, 0.66)]),
    ("sigh-dusk", "dusk", "rhodes",
     [(0.0, 5, 0.66), (1.1, 4, 0.48), (2.3, 2, 0.58), (4.6, 0, 0.5)]),
    ("turn-dusk", "dusk", "rhodes",
     [(0.0, 2, 0.6), (0.9, 3, 0.46), (1.8, 2, 0.52), (2.7, 1, 0.56), (5.0, 0, 0.48)]),
    ("ask-dusk", "dusk", "rhodes",
     [(0.0, 0, 0.55), (1.2, 2, 0.6), (2.4, 4, 0.5), (3.4, 3, 0.42), (5.4, 2, 0.5)]),
    ("swell-bright", "bright", "rhodes",
     [(0.0, 5, 0.7), (0.5, 7, 0.56), (1.0, 9, 0.7), (2.0, 7, 0.52),
      (3.0, 5, 0.66), (4.0, 4, 0.52), (5.0, 5, 0.7), (6.0, 7, 0.58)]),
    ("swell-dusk", "dusk", "ks",
     [(0.0, 0, 0.8), (1.8, 1, 0.6), (3.6, 3, 0.62)]),
    ("drift-bright", "bright", "rhodes",
     [(0.0, 2, 0.6), (0.5, 4, 0.54), (1.5, 5, 0.68), (2.0, 7, 0.56),
      (3.0, 5, 0.5), (3.5, 7, 0.66), (4.5, 9, 0.7), (5.5, 7, 0.52),
      (6.5, 5, 0.6)]),
    ("high-bright", "bright", "rhodes",
     [(0.0, 5, 0.58), (0.5, 7, 0.66), (1.0, 9, 0.7), (2.0, 7, 0.52),
      (2.5, 10, 0.68), (3.5, 9, 0.54), (4.0, 7, 0.64), (5.0, 6, 0.5),
      (6.0, 7, 0.66)]),
    ("step-bright", "bright", "rhodes",
     [(0.0, 0, 0.66), (0.5, 2, 0.5), (1.0, 1, 0.58), (2.0, 4, 0.68),
      (2.5, 2, 0.48), (3.0, 5, 0.7), (4.0, 4, 0.56), (5.0, 7, 0.68),
      (6.0, 5, 0.58), (7.0, 4, 0.52)]),
    ("swell2-bright", "bright", "rhodes",
     [(0.0, 2, 0.68), (0.75, 4, 0.54), (1.5, 7, 0.72), (2.5, 5, 0.5),
      (3.0, 4, 0.62), (4.0, 7, 0.7), (5.0, 9, 0.66), (6.0, 7, 0.58)]),
    ("fall-dusk", "dusk", "rhodes",
     [(0.0, 7, 0.6), (1.2, 5, 0.5), (2.4, 4, 0.55), (3.6, 2, 0.42), (5.6, 0, 0.5)]),
    ("float-dusk", "dusk", "rhodes",
     [(0.0, 4, 0.55), (1.6, 5, 0.48), (3.2, 7, 0.55), (5.4, 5, 0.4)]),
    ("step-dusk", "dusk", "rhodes",
     [(0.0, 0, 0.55), (1.0, 1, 0.5), (2.0, 2, 0.55), (3.2, 1, 0.4), (4.4, 0, 0.5), (5.8, 2, 0.35)]),
    ("swell2-dusk", "dusk", "ks",
     [(0.0, 1, 0.7), (2.2, 3, 0.6), (4.2, 5, 0.68)]),
]

BRIGHT_BEAT = 60.0 / 92.0
DUSK_BEAT = 60.0 / 66.0


def render_phrase(name: str, flavor: str, voice: str, notes) -> np.ndarray:
    rng = np.random.default_rng(zlib.crc32(name.encode()))  # stable across runs
    penta = BRIGHT if flavor == "bright" else DUSK
    beat = BRIGHT_BEAT if flavor == "bright" else DUSK_BEAT
    end_beats = max(b for b, _, _ in notes)
    tail = 2.2 if flavor == "bright" else (3.2 if voice == "rhodes" else 4.5)
    total = end_beats * beat + tail
    mono = np.zeros(seconds(total))
    for start_beats, slot, vel in notes:
        octave, idx = divmod(slot, 5)
        midi = C4 + penta[idx] + 12 * octave
        f = midi_freq(midi)
        at = seconds(start_beats * beat + float(rng.normal(0, 0.012)))
        at = max(0, at)
        if voice == "rhodes":
            max_note = 2.0 if flavor == "bright" else 3.5
            note = rhodes_note(f, min(max_note, total - at / SR), vel, rng)
        else:
            if flavor == "bright":
                # The same string model becomes a short, crisp pizzicato in
                # daylight instead of the long reversed-guitar dusk swell.
                note = ks_swell(f, min(1.5, total - at / SR), vel, rng)
            else:
                note = ks_swell(f, min(5.0, total - at / SR), vel, rng)
        n = min(len(note), len(mono) - at)
        mono[at : at + n] += note[:n]
    mono = np.tanh(mono * 1.15) / np.tanh(1.15)
    mono = lowpass(mono, 7200 if flavor == "bright" else 5400)
    stereo = chorus(mono, rng)
    stereo *= 0.5 / max(1e-9, np.max(np.abs(stereo)))
    return stereo.astype(np.float32)


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
    print(f"{mp3_path.relative_to(ROOT)}  {len(data)/SR:5.2f}s  size={mp3_path.stat().st_size/1024:.0f}KiB")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--flavor", choices=("bright", "dusk"), help="render one palette only")
    selected_flavor = parser.parse_args().flavor
    for name, flavor, voice, notes in PHRASES:
        if selected_flavor and flavor != selected_flavor:
            continue
        write_mp3(name, render_phrase(name, flavor, voice, notes))


if __name__ == "__main__":
    main()
