// Convert Float32Array [-1..1] to Int16Array PCM16
export function floatTo16BitPCM(float32Array: Float32Array): Int16Array {
  const out = new Int16Array(float32Array.length);
  for (let i = 0; i < float32Array.length; i++) {
    const s = Math.max(-1, Math.min(1, float32Array[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

// Convert PCM16 (Int16Array) to µ-law (Uint8Array)
export function pcm16ToUlaw(pcm16: Int16Array): Uint8Array {
  const BIAS = 0x84;
  const CLIP = 32635;
  const ulaw = new Uint8Array(pcm16.length);

  for (let i = 0; i < pcm16.length; i++) {
    let sample = pcm16[i];
    let sign = (sample >> 8) & 0x80;
    if (sign !== 0) sample = -sample;
    if (sample > CLIP) sample = CLIP;
    sample += BIAS;

    let exponent = 7;
    for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; expMask >>= 1) {
      exponent--;
    }
    const mantissa = (sample >> (exponent + 3)) & 0x0f;
    ulaw[i] = ~(sign | (exponent << 4) | mantissa) & 0xff;
  }

  return ulaw;
}

// Ensure ArrayBuffer (copy from SharedArrayBuffer if needed)
export function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(u8.length);
  copy.set(u8);
  return copy.buffer;
}
