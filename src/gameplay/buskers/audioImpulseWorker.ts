type ImpulseRequest = { sampleRate: number; seconds: number; decay: number };

self.onmessage = (event: MessageEvent<ImpulseRequest>) => {
  const { sampleRate, seconds, decay } = event.data;
  const length = Math.max(1, Math.floor(sampleRate * seconds));
  const left = new Float32Array(length);
  const right = new Float32Array(length);
  for (const channel of [left, right]) {
    let lowpass = 0;
    for (let i = 0; i < length; i++) {
      const envelope = Math.pow(1 - i / length, decay);
      const white = Math.random() * 2 - 1;
      lowpass += 0.42 * (white - lowpass);
      channel[i] = lowpass * envelope;
    }
  }
  (self as unknown as Worker).postMessage({ left, right }, [left.buffer, right.buffer]);
};
