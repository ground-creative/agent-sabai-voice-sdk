// Convert Float32Array [-1..1] to Int16Array PCM16
export function floatTo16BitPCM(float32Array: Float32Array): Int16Array {
  const out = new Int16Array(float32Array.length);
  for (let i = 0; i < float32Array.length; i++) {
    const s = Math.max(-1, Math.min(1, float32Array[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

// Resample PCM16 from one sample rate to another using OfflineAudioContext.
// Used to upsample 16kHz -> 24kHz before feeding TTS audio to LiveAvatar LITE.
export async function resamplePcm16(input: Int16Array, fromRate: number, toRate: number): Promise<Int16Array> {
  const floatIn = new Float32Array(input.length);
  for (let i = 0; i < input.length; i++) {
    floatIn[i] = input[i] / (input[i] < 0 ? 0x8000 : 0x7fff);
  }
  const outputLength = Math.ceil(input.length * toRate / fromRate);
  const offlineCtx = new OfflineAudioContext(1, outputLength, toRate);
  const buffer = offlineCtx.createBuffer(1, input.length, fromRate);
  buffer.copyToChannel(floatIn, 0);
  const source = offlineCtx.createBufferSource();
  source.buffer = buffer;
  source.connect(offlineCtx.destination);
  source.start();
  const rendered = await offlineCtx.startRendering();
  const floatOut = rendered.getChannelData(0);
  const out = new Int16Array(floatOut.length);
  for (let i = 0; i < floatOut.length; i++) {
    const s = Math.max(-1, Math.min(1, floatOut[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

// Encode Int16Array PCM16 to base64 string.
export function pcm16ToBase64(pcm16: Int16Array): string {
  const bytes = new Uint8Array(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

// Decode a base64 string to Uint8Array.
export function base64ToUint8(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
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
