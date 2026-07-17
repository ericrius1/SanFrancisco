// Full 88-key layout (A0..C8) mapped to chunky voxel keys. Precomputes each
// MIDI note's key-centre X (local keyboard space) and colour so both the key
// press animation and the hand IK targets read the same table.
//
// Orientation: bass (low MIDI) sits at +X, treble at -X. That matches the rig,
// whose left hand (rig "L", the +X shoulder) plays the low half exactly as a
// real player's left hand covers the bass end.

export const KEYBOARD = {
  lowMidi: 21, // A0
  highMidi: 108, // C8
  whiteCount: 52,
  /** Total span of the white-key row along local X (m). */
  width: 1.25,
  /** White key length front (player) to back (m), along local Z. */
  whiteDepth: 0.15,
  whiteHeight: 0.024,
  /** Black keys are narrower, shorter and raised. */
  blackWidthFrac: 0.56,
  blackDepthFrac: 0.62,
  blackHeight: 0.03,
  blackRise: 0.014
} as const;

export const WHITE_WIDTH = KEYBOARD.width / KEYBOARD.whiteCount;

// C C# D D# E F F# G G# A A# B
const PC_BLACK = [false, true, false, true, false, false, true, false, true, false, true, false];

export function isBlackMidi(m: number): boolean {
  return PC_BLACK[((m % 12) + 12) % 12];
}

/** Local X of a key centre by MIDI (bass at +X). */
export const KEY_CENTER_X = new Float32Array(128);
export const KEY_IS_BLACK = new Uint8Array(128);
/** Instance slot within the note's own InstancedMesh (whites and blacks each
 * counted from 0), or -1 outside the 88-key range. */
export const KEY_SLOT = new Int16Array(128).fill(-1);
/** MIDI note played by white/black instance `slot`. */
export const WHITE_MIDIS: number[] = [];
export const BLACK_MIDIS: number[] = [];

(function buildKeyTable() {
  const centre = (KEYBOARD.whiteCount - 1) / 2; // 25.5
  let whiteIndex = 0;
  for (let m = KEYBOARD.lowMidi; m <= KEYBOARD.highMidi; m++) {
    if (isBlackMidi(m)) continue;
    KEY_CENTER_X[m] = (centre - whiteIndex) * WHITE_WIDTH;
    KEY_SLOT[m] = WHITE_MIDIS.length;
    WHITE_MIDIS.push(m);
    whiteIndex++;
  }
  for (let m = KEYBOARD.lowMidi; m <= KEYBOARD.highMidi; m++) {
    if (!isBlackMidi(m)) continue;
    // Both flanking notes (m-1, m+1) are white and in range for every A0..C8 black.
    KEY_CENTER_X[m] = (KEY_CENTER_X[m - 1] + KEY_CENTER_X[m + 1]) * 0.5;
    KEY_IS_BLACK[m] = 1;
    KEY_SLOT[m] = BLACK_MIDIS.length;
    BLACK_MIDIS.push(m);
  }
})();

const CLAMP_LO = KEYBOARD.lowMidi;
const CLAMP_HI = KEYBOARD.highMidi;

/** Local keyboard-space X of a MIDI note's key centre (clamped into range). */
export function keyCenterX(midi: number): number {
  const m = midi < CLAMP_LO ? CLAMP_LO : midi > CLAMP_HI ? CLAMP_HI : midi | 0;
  return KEY_CENTER_X[m];
}
