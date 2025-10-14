import { floatTo16BitPCM, pcm16ToUlaw, toArrayBuffer } from '../utils/audioUtils';
import type { AudioSenderOptions } from '../types/config';
import { DEFAULT_AUDIO_OPTIONS } from '../types/config';

export class AudioSender {
  private mediaStream?: MediaStream;
  private audioCtx?: AudioContext;
  private processor?: AudioWorkletNode;
  private source?: MediaStreamAudioSourceNode;
  private onChunkCb?: (chunk: ArrayBuffer, meta?: any) => void;
  private constraints?: AudioSenderOptions['constraints'];
  // Visualizer support
  private analyser?: AnalyserNode;
  private visualizerRaf?: number | null;
  private visualizerCb?: (levels: number[]) => void;
  private visualizerBands: number = 6;
  private hpFilter?: BiquadFilterNode; // optional high-pass filter to reduce DC/rumble

  public sampleRate: number;
  public frameMs: number;
  public frameSamples: number;

  constructor(opts?: AudioSenderOptions) {
    const merged = {
      ...DEFAULT_AUDIO_OPTIONS,
      ...opts,
      constraints: {
        ...(DEFAULT_AUDIO_OPTIONS as Required<typeof DEFAULT_AUDIO_OPTIONS>).constraints,
        ...(opts?.constraints ?? {}),
      },
    } as AudioSenderOptions;

    const { sampleRate, frameMs } = merged;

    if (![16000].includes(sampleRate)) {
      throw new Error('Invalid sampleRate: allowed 16000');
    }
    if (frameMs !== 20) {
      throw new Error('Invalid frameMs: only 20ms supported');
    }

    this.sampleRate = sampleRate;
    this.frameMs = frameMs;
    this.frameSamples = (this.sampleRate * this.frameMs) / 1000;
    this.constraints = merged.constraints;
  }

  async start(onChunk: (chunk: ArrayBuffer, meta?: any) => void) {
    this.onChunkCb = onChunk;
    this.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: (this.constraints ?? true) as MediaTrackConstraints,
      video: false,
    });
    this.audioCtx = new AudioContext({ sampleRate: this.sampleRate });

    this.source = this.audioCtx.createMediaStreamSource(this.mediaStream);

    // Load worklet - inline the code to avoid path resolution issues
    const workletCode = `
class ChunkProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.buffer = [];
    this.frameSamples = options.processorOptions.frameSamples;
  }

  process(inputs, outputs) {
    const input = inputs[0][0];
    if (input) {
      this.buffer.push(...input);

      while (this.buffer.length >= this.frameSamples) {
        const frame = this.buffer.slice(0, this.frameSamples);
        this.buffer = this.buffer.slice(this.frameSamples);
        this.port.postMessage(frame);
      }
    }
    return true;
  }
}

registerProcessor("chunk-processor", ChunkProcessor);
    `;
    
    const workletBlob = new Blob([workletCode], { type: 'application/javascript' });
    const workletUrl = URL.createObjectURL(workletBlob);
    
    try {
      await this.audioCtx.audioWorklet.addModule(workletUrl);
    } finally {
      // Clean up the blob URL after loading
      URL.revokeObjectURL(workletUrl);
    }
    this.processor = new AudioWorkletNode(this.audioCtx, 'chunk-processor', {
      processorOptions: { frameSamples: this.frameSamples },
    });

    let sentInitialMeta = false;

    this.processor.port.onmessage = (ev) => {
      const frame = new Float32Array(ev.data);
      const pcm16 = floatTo16BitPCM(frame);
      const ulaw = pcm16ToUlaw(pcm16);
      const chunkBuffer = toArrayBuffer(ulaw);

      if (!sentInitialMeta) {
        this.onChunkCb?.(chunkBuffer, {
          sample_rate: this.sampleRate,
          frame_ms: this.frameMs,
        });
        sentInitialMeta = true;
      } else {
        this.onChunkCb?.(chunkBuffer);
      }
    };

    this.source.connect(this.processor);
    this.processor.connect(this.audioCtx.destination);
  }

  stop() {
    // Stop visualizer if running
    this.clearVisualizer();
    try {
      this.processor?.disconnect();
    } catch {}
    try {
      this.source?.disconnect();
    } catch {}
    this.mediaStream?.getTracks().forEach((t) => t.stop());
    try {
      this.audioCtx?.close();
    } catch {}
    // Reset
    this.processor = undefined;
    this.source = undefined;
    this.mediaStream = undefined;
    this.audioCtx = undefined;
  }

  /**
   * Enable analyser-based visualizer and feed levels to callback.
   * Safe to call multiple times; previous visualizer will be replaced.
   */
  public setVisualizer(
    cb: (levels: number[]) => void,
    opts?: {
      numBands?: number;
      minDecibels?: number;
      maxDecibels?: number;
      smoothingTimeConstant?: number;
      highpassHz?: number; // reduce low-frequency rumble so first bar doesn't stick
      firstBandAttenuation?: number; // multiply first band by this factor (0-1)
      silenceGate?: number; // if overall avg below gate, drop first band
    },
  ) {
    this.clearVisualizer();
    if (!this.audioCtx || !this.source) return; // Will be available after start()

    this.visualizerCb = cb;
    this.visualizerBands = opts?.numBands ?? this.visualizerBands ?? 6;

    // Optional high-pass to remove DC offset and HVAC/rumble (<100-150Hz)
    const hp = this.audioCtx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = opts?.highpassHz ?? 120;
    this.source.connect(hp);
    this.hpFilter = hp;

    // Create analyser fed from the high-pass filter
    const analyser = this.audioCtx.createAnalyser();
    analyser.fftSize = 1024; // 512 bins
    analyser.minDecibels = opts?.minDecibels ?? -85;
    analyser.maxDecibels = opts?.maxDecibels ?? -20;
    analyser.smoothingTimeConstant = opts?.smoothingTimeConstant ?? 0.6;
    hp.connect(analyser);
    this.analyser = analyser;

    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    const loop = () => {
      if (!this.analyser || !this.visualizerCb) return;
      this.analyser.getByteFrequencyData(dataArray);

      const bands = this.visualizerBands || 6;
      const levels = new Array(bands).fill(0);
      const chunkSize = Math.max(1, Math.floor(bufferLength / bands));
      for (let i = 0; i < bands; i++) {
        const start = i * chunkSize;
        const end = i === bands - 1 ? bufferLength : Math.min(bufferLength, start + chunkSize);
        let sum = 0;
        let count = 0;
        for (let j = start; j < end; j++) {
          if (j === 0) continue; // skip DC bin to avoid sticky first band
          sum += dataArray[j];
          count++;
        }
        const avg = count ? sum / count : 0;
        levels[i] = Math.min(Math.max(avg / 255, 0), 1);
      }

      // Global average to detect silence
      const avgLevel = levels.reduce((a, b) => a + b, 0) / (levels.length || 1);
      const silenceGate = opts?.silenceGate ?? 0.02;
      if (avgLevel < silenceGate) {
        levels[0] = 0; // drop first band completely in silence
      }
      // Attenuate first band a bit to counter residual low freq bias
      const atten = Math.min(Math.max(opts?.firstBandAttenuation ?? 0.7, 0), 1);
      levels[0] = Math.min(Math.max(levels[0] * atten, 0), 1);

      try {
        this.visualizerCb(levels);
      } finally {
        this.visualizerRaf = requestAnimationFrame(loop);
      }
    };
    this.visualizerRaf = requestAnimationFrame(loop);
  }

  /**
   * Disable visualizer and cleanup analyser node.
   */
  public clearVisualizer() {
    if (this.visualizerRaf) {
      cancelAnimationFrame(this.visualizerRaf);
      this.visualizerRaf = null;
    }
    if (this.analyser) {
      try {
        if (this.hpFilter) {
          this.source?.disconnect(this.hpFilter);
          this.hpFilter.disconnect();
        } else {
          this.source?.disconnect(this.analyser);
        }
      } catch {}
      try {
        this.analyser.disconnect();
      } catch {}
    }
    this.hpFilter = undefined;
    this.analyser = undefined;
    this.visualizerCb = undefined;
  }
}
