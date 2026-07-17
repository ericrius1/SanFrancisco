#!/usr/bin/env python3
"""Bake a beach-pianist note timeline from an audio recording.

Transcribes polyphonic piano audio with Spotify basic-pitch and writes the
compact JSON the beach-pianist site consumes (see src/world/beachPianist/notes.ts):

    {"v":1,"durationMs":<int>,"notes":[[startMs,durMs,midi,vel,hand],...]}

hand: 0 = left, 1 = right — assigned by local pitch clustering (±0.4 s window;
a tight cluster (<=7 semitones) goes whole to one hand by its mean vs middle C,
otherwise notes split at the window median).

Setup (one-time):
    python3 -m venv /tmp/bp-venv && /tmp/bp-venv/bin/pip install 'basic-pitch[onnx]'

Usage:
    ffmpeg -y -i song.m4a -ac 1 -ar 22050 /tmp/song.wav
    /tmp/bp-venv/bin/python tools/transcribe-piano-song.py /tmp/song.wav \
        public/audio/pianist/song-2.notes.json

Then copy the original (untranscoded) m4a next to it and append an entry in
src/world/beachPianist/songs.ts. Keep sources mono AAC — mono feeds the 3D
panner directly and AAC decodes everywhere.
"""

import json
import statistics
import subprocess
import sys


def main() -> None:
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    wav_path, out_path = sys.argv[1], sys.argv[2]

    from basic_pitch.inference import predict

    _model_output, _midi, note_events = predict(wav_path)
    events = sorted(
        (float(s), float(e), int(p), float(a)) for (s, e, p, a, _bends) in note_events
    )
    if not events:
        sys.exit("no notes transcribed")

    notes = []
    for start, end, pitch, amp in events:
        local = [q for (s2, _e2, q, _a2) in events if abs(s2 - start) <= 0.4]
        lo, hi = min(local), max(local)
        if hi - lo <= 7:
            hand = 0 if (lo + hi) / 2 < 60 else 1
        else:
            hand = 0 if pitch <= statistics.median(local) else 1
        vel = max(20, min(127, int(amp * 180)))
        notes.append([int(start * 1000), max(80, int((end - start) * 1000)), pitch, vel, hand])

    duration_ms = int(
        float(
            subprocess.check_output(
                ["ffprobe", "-v", "error", "-show_entries", "format=duration",
                 "-of", "csv=p=0", wav_path]
            ).strip()
        )
        * 1000
    )

    with open(out_path, "w") as f:
        json.dump({"v": 1, "durationMs": duration_ms, "notes": notes}, f, separators=(",", ":"))

    left = sum(1 for n in notes if n[4] == 0)
    print(f"{out_path}: {len(notes)} notes ({left} L / {len(notes) - left} R), {duration_ms} ms")


if __name__ == "__main__":
    main()
