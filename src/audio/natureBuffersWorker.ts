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
  const voiceNoise = whiteNoise(Math.floor(sampleRate * VOICE_SECONDS));
  const impulseLeft = impulse(Math.floor(sampleRate * IMPULSE_SECONDS));
  const impulseRight = impulse(Math.floor(sampleRate * IMPULSE_SECONDS));
  const windLeft = pinkNoise(Math.floor(sampleRate * WIND_SECONDS));
  const windRight = pinkNoise(Math.floor(sampleRate * WIND_SECONDS));
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
