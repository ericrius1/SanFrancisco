// Off-thread buffer synthesis for the lo-fi music layer: a seamless vinyl
// crackle loop and a stereo reverb impulse. Mirrors natureBuffersWorker so
// procedural buffer loops never touch the main/input thread.

type MusicBufferRequest = {
  sampleRate: number;
};

export type MusicBufferResult = {
  vinyl: ArrayBuffer;
  impulseLeft: ArrayBuffer;
  impulseRight: ArrayBuffer;
};

const VINYL_SECONDS = 7;
const IMPULSE_SECONDS = 3.4;
const LOOP_TAPER_SECONDS = 0.01;

function taperLoopEdges(data: Float32Array, sampleRate: number): Float32Array {
  const samples = Math.min(
    Math.max(2, Math.round(sampleRate * LOOP_TAPER_SECONDS)),
    Math.floor(data.length / 4)
  );
  for (let index = 0; index < samples; index++) {
    const t = index / (samples - 1);
    const gain = t * t * (3 - 2 * t);
    data[index] *= gain;
    data[data.length - 1 - index] *= gain;
  }
  return data;
}

/**
 * Vinyl surface: sparse dust pops (Poisson arrivals, each a tiny lowpassed
 * click with its own decay), a faint hiss bed, and a slow 33⅓ rpm wow rumble.
 */
function vinylLoop(sampleRate: number): Float32Array {
  const length = Math.floor(sampleRate * VINYL_SECONDS);
  const data = new Float32Array(length);

  // hiss bed — white noise through a one-pole lowpass, very quiet
  let lp = 0;
  const hissCoeff = Math.exp((-2 * Math.PI * 2400) / sampleRate);
  for (let i = 0; i < length; i++) {
    const white = Math.random() * 2 - 1;
    lp = lp * hissCoeff + white * (1 - hissCoeff);
    data[i] = lp * 0.055;
  }

  // dust pops — ~2.4 per second, size-varied, each a damped click
  const popRate = 2.4 / sampleRate;
  let i = 0;
  while (i < length) {
    if (Math.random() < popRate) {
      const size = 0.12 + Math.random() * 0.88;
      const popLen = Math.floor(sampleRate * (0.002 + size * 0.006));
      const amp = 0.25 * size * size;
      const polarity = Math.random() < 0.5 ? -1 : 1;
      for (let j = 0; j < popLen && i + j < length; j++) {
        const env = Math.pow(1 - j / popLen, 2.4);
        data[i + j] += polarity * amp * env * (0.6 + Math.random() * 0.4);
      }
      i += popLen;
    }
    i++;
  }

  // turntable rumble — two slow, slightly detuned partials way underneath
  for (let s = 0; s < length; s++) {
    const t = s / sampleRate;
    data[s] += 0.02 * Math.sin(2 * Math.PI * 17.8 * t) + 0.014 * Math.sin(2 * Math.PI * 26.1 * t);
  }

  return taperLoopEdges(data, sampleRate);
}

/** Warm plate-ish impulse: exponentially decaying noise that darkens as it
 *  fades (running one-pole whose cutoff falls with time). */
function impulse(sampleRate: number): Float32Array {
  const length = Math.floor(sampleRate * IMPULSE_SECONDS);
  const data = new Float32Array(length);
  let lp = 0;
  for (let i = 0; i < length; i++) {
    const t = i / length;
    const cutoff = 6200 * Math.pow(1 - t, 1.6) + 240;
    const coeff = Math.exp((-2 * Math.PI * cutoff) / sampleRate);
    const white = Math.random() * 2 - 1;
    lp = lp * coeff + white * (1 - coeff);
    data[i] = lp * Math.pow(1 - t, 2.1);
  }
  return data;
}

self.onmessage = (event: MessageEvent<MusicBufferRequest>) => {
  const sampleRate = Math.max(8_000, Math.min(192_000, Math.round(event.data.sampleRate)));
  const result: MusicBufferResult = {
    vinyl: vinylLoop(sampleRate).buffer as ArrayBuffer,
    impulseLeft: impulse(sampleRate).buffer as ArrayBuffer,
    impulseRight: impulse(sampleRate).buffer as ArrayBuffer
  };
  self.postMessage(result, {
    transfer: [result.vinyl, result.impulseLeft, result.impulseRight]
  });
};
