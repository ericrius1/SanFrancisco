type NatureBufferRequest = {
  sampleRate: number;
};

export type NatureBufferResult = {
  voiceNoise: ArrayBuffer;
  impulseLeft: ArrayBuffer;
  impulseRight: ArrayBuffer;
  windLeft: ArrayBuffer;
  windRight: ArrayBuffer;
};

const VOICE_SECONDS = 2;
const IMPULSE_SECONDS = 2.2;
const IMPULSE_DECAY = 2.6;
const WIND_SECONDS = 4;
const LOOP_TAPER_SECONDS = 0.008;

/** Match the ends of a looping noise bed at zero so BufferSource looping
 * cannot turn a random endpoint discontinuity into a periodic click/crackle. */
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

function whiteNoise(length: number): Float32Array {
  const data = new Float32Array(length);
  for (let index = 0; index < length; index++) data[index] = Math.random() * 2 - 1;
  return data;
}

function impulse(length: number): Float32Array {
  const data = new Float32Array(length);
  for (let index = 0; index < length; index++) {
    data[index] = (Math.random() * 2 - 1) * Math.pow(1 - index / length, IMPULSE_DECAY);
  }
  return data;
}

function pinkNoise(length: number): Float32Array {
  const data = new Float32Array(length);
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  for (let index = 0; index < length; index++) {
    const white = Math.random() * 2 - 1;
    b0 = 0.99765 * b0 + white * 0.099046;
    b1 = 0.963 * b1 + white * 0.2965164;
    b2 = 0.57 * b2 + white * 1.0526913;
    data[index] = (b0 + b1 + b2 + white * 0.1848) * 0.25;
  }
  return data;
}

self.onmessage = (event: MessageEvent<NatureBufferRequest>) => {
  const sampleRate = Math.max(8_000, Math.min(192_000, Math.round(event.data.sampleRate)));
  const voiceNoise = taperLoopEdges(whiteNoise(Math.floor(sampleRate * VOICE_SECONDS)), sampleRate);
  const impulseLeft = impulse(Math.floor(sampleRate * IMPULSE_SECONDS));
  const impulseRight = impulse(Math.floor(sampleRate * IMPULSE_SECONDS));
  const windLeft = taperLoopEdges(pinkNoise(Math.floor(sampleRate * WIND_SECONDS)), sampleRate);
  const windRight = taperLoopEdges(pinkNoise(Math.floor(sampleRate * WIND_SECONDS)), sampleRate);
  const result: NatureBufferResult = {
    voiceNoise: voiceNoise.buffer as ArrayBuffer,
    impulseLeft: impulseLeft.buffer as ArrayBuffer,
    impulseRight: impulseRight.buffer as ArrayBuffer,
    windLeft: windLeft.buffer as ArrayBuffer,
    windRight: windRight.buffer as ArrayBuffer
  };
  self.postMessage(result, {
    transfer: [
      result.voiceNoise,
      result.impulseLeft,
      result.impulseRight,
      result.windLeft,
      result.windRight
    ]
  });
};
