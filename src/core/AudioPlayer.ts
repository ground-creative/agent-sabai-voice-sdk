
import { mulaw } from 'alawmulaw';
import PCMPlayer from 'pcm-player';


/**
 * Streaming AudioPlayer for base64 µ-law (G.711) audio chunks.
 * Backed by alawmulaw for decode and pcm-player for smooth playback/buffering.
 */
export class AudioPlayer {
  /** Set playback volume (0.0 - 1.0) */
  public setVolume(vol: number) {
    this.volume = vol;
    if (this.player) {
      try {
        if (typeof this.player.volume === 'function') this.player.volume(vol);
        else if ('volume' in this.player) (this.player as any).volume = vol;
      } catch {}
    }
  }
  private player: any | null = null;
  private started = false;
  private readonly defaultSampleRate: number;
  private readonly latencyPadSec: number;
  private debug: boolean;
  // Playback queue time tracking (ms)
  private queueEndAtMs: number = 0;
  private drainTimer: number | null = null;
  private volume: number = 1.0; // unity by default

    // Compressor related fields
  private useCompressor: boolean = false;
  private compEnabled = false;
  private compThresholdDb = -18; // start compressing above -18 dBFS
  private compRatio = 3.0; // 3:1 ratio
  private compAttackMs = 5; // attack time in ms
  private compReleaseMs = 150; // release time in ms
  private compMakeupDb = 3; // makeup gain in dB
  private _compEnvGain = 1.0; // smoothed gain
  private _compAlphaAttack: number = 0;
  private _compAlphaRelease: number = 0;
  private _compMakeupLin: number = 0;

  constructor(opts?: {
    sampleRate?: number;
    latencyPadSec?: number;
    debug?: boolean;
    volume?: number;
    useCompressor?: boolean;
    compressorConfig?: {
      thresholdDb?: number;
      ratio?: number;
      attackMs?: number;
      releaseMs?: number;
      makeupDb?: number;
    };
  }) {
    this.defaultSampleRate = opts?.sampleRate ?? 16000;
    this.latencyPadSec = opts?.latencyPadSec ?? 0.15; // initial pad to avoid underruns
    this.debug = !!opts?.debug;
    if (typeof opts?.volume === 'number') this.volume = opts.volume;
    
    // Initialize compressor if enabled
    this.useCompressor = opts?.useCompressor ?? false;
    if (this.useCompressor) {
      this.compEnabled = true;
      if (opts?.compressorConfig) {
        this.setCompressor(opts.compressorConfig);
      } else {
        this._initCompressor();
      }
    }
  }

  private _initCompressor() {
    this._compAlphaAttack = this._calcAlpha(this.compAttackMs);
    this._compAlphaRelease = this._calcAlpha(this.compReleaseMs);
    this._compMakeupLin = this._dbToLin(this.compMakeupDb);
  }

  // Compressor helper methods
  private _dbToLin(db: number): number {
    return Math.pow(10, db / 20);
  }

  private _calcAlpha(timeMs: number): number {
    const t = Math.max(0.0001, timeMs / 1000);
    return Math.exp(-1 / (this.defaultSampleRate * t));
  }

  public setCompressor(params: {
    enabled?: boolean;
    thresholdDb?: number;
    ratio?: number;
    attackMs?: number;
    releaseMs?: number;
    makeupDb?: number;
  } = {}) {
    if (typeof params.enabled === 'boolean') this.compEnabled = params.enabled;
    if (typeof params.thresholdDb === 'number') this.compThresholdDb = params.thresholdDb;
    if (typeof params.ratio === 'number') this.compRatio = Math.max(1.0, params.ratio);
    if (typeof params.attackMs === 'number') this.compAttackMs = Math.max(0.1, params.attackMs);
    if (typeof params.releaseMs === 'number') this.compReleaseMs = Math.max(1, params.releaseMs);
    if (typeof params.makeupDb === 'number') this.compMakeupDb = params.makeupDb;
    this._compAlphaAttack = this._calcAlpha(this.compAttackMs);
    this._compAlphaRelease = this._calcAlpha(this.compReleaseMs);
    this._compMakeupLin = this._dbToLin(this.compMakeupDb);
  }

  private initPlayer() {
    this.player = new PCMPlayer({
      channels: 1,
      sampleRate: this.defaultSampleRate,
      flushingTime: Math.max(30, Math.floor(this.latencyPadSec * 1000)), // ms moderate buffer
      // pcm-player expects Int16Array by default
    } as any);
    try {
      if (typeof this.player.volume === 'function') this.player.volume(this.volume);
      else if ('volume' in this.player) (this.player as any).volume = this.volume;
    } catch {}
  }

  /** Must be called from a user gesture (e.g., click) in most browsers */
  public async start() {
    if (!this.player) {
      this.initPlayer();
      if (this.debug) console.log('[AudioPlayer] pcm-player initialized');
    }
    this.started = true;
  }

  public stop() {
    try {
      this.player?.destroy?.();
    } catch {}
    this.player = null;
    this.started = false;
    this.queueEndAtMs = 0;
    if (this.drainTimer) {
      clearInterval(this.drainTimer);
      this.drainTimer = null;
    }
    if (this.debug) console.log('[AudioPlayer] pcm-player destroyed');
  }

  /** Immediately stop playback and reset buffer accounting. */
  public interrupt() {
    // Hard stop current player and reinitialize so playback can resume on next chunk
    try {
      this.player?.destroy?.();
    } catch {}
    this.player = null;
    this.queueEndAtMs = 0;
    if (this.drainTimer) {
      clearInterval(this.drainTimer);
      this.drainTimer = null;
    }
    this.initPlayer();
    this.started = true;
    if (this.debug) console.log('[AudioPlayer] pcm-player reinitialized after interrupt');
  }

  public clear() {
    try {
      this.player?.clear?.();
    } catch {}
  }

  /**
   * Append a base64-encoded µ-law (G.711) chunk to the playback queue.
   */
  // Apply dynamic compression to Int16 PCM data
  private _compressPcmInt16(int16: Int16Array): Int16Array {
    if (!this.useCompressor || !this.compEnabled) return int16;

    const out = new Int16Array(int16.length);
    const thr = this.compThresholdDb;
    const ratio = this.compRatio;
    const makeup = this._compMakeupLin;
    const eps = 1e-8;
    let env = this._compEnvGain;
    const aAtk = this._compAlphaAttack;
    const aRel = this._compAlphaRelease;

    for (let i = 0; i < int16.length; i++) {
      const s = int16[i];
      const x = s / 32768; // float [-1, 1)
      const ax = Math.abs(x);
      // instantaneous level in dBFS
      const levelDb = 20 * Math.log10(Math.max(ax, eps));

      let targetGain = 1.0;
      if (levelDb > thr) {
        const over = levelDb - thr;
        const compressedDb = thr + over / ratio;
        const gainDb = compressedDb - levelDb; // negative value
        targetGain = this._dbToLin(gainDb);
      }
      // smooth gain towards target
      const alpha = targetGain < env ? aAtk : aRel;
      env = alpha * env + (1 - alpha) * targetGain;
      const g = env * makeup;

      let y = x * g;
      // clamp
      if (y > 1) y = 1;
      else if (y < -1) y = -1;
      out[i] = y < 0 ? Math.round(y * 32768) : Math.round(y * 32767);
    }
    this._compEnvGain = env; // persist envelope across chunks
    return out;
  }

  public appendChunk(base64: string, _meta?: { sample_rate?: number }) {
    if (!base64 || !this.player || !this.started) return;
    // decode base64 -> ulaw bytes -> pcm16 -> feed to pcm-player
    const bytes = base64ToUint8(base64);
    let pcm16 = mulaw.decode(bytes); // Int16Array

    // Apply compression if enabled
    if (this.useCompressor && this.compEnabled) {
      pcm16 = this._compressPcmInt16(pcm16);
    }

    try {
      this.player.feed(pcm16);
      // Update queue end estimate (ms): 1 byte ulaw = 1 sample @ sampleRate
      const samples = pcm16.length; // Int16 per sample
      const nowMs = performance.now();
      const durMs = (samples / this.defaultSampleRate) * 1000;
      this.queueEndAtMs = Math.max(this.queueEndAtMs, nowMs) + durMs;
      // Lazy start drain ticker
      if (!this.drainTimer) {
        this.drainTimer = setInterval(() => {
          const t = performance.now();
          if (t + 10 >= this.queueEndAtMs) {
            // close enough; stop ticking until more audio arrives
            if (this.drainTimer) {
              clearInterval(this.drainTimer);
              this.drainTimer = null;
            }
          }
        }, 50) as unknown as number;
      }
    } catch (e) {
      if (this.debug) console.warn('[AudioPlayer] feed failed:', e);
    }
  }

  /** Estimated queue end time in ms since performance.timing origin */
  public getQueueEndTimeMs(): number {
    return this.queueEndAtMs;
  }

  /** Resolve when audio queued so far is fully drained (with a small 20ms safety). */
  public waitForDrain(): Promise<void> {
    const safetyMs = 20;
    return new Promise((resolve) => {
      const check = () => {
        const now = performance.now();
        if (now + safetyMs >= this.queueEndAtMs) {
          if (timer) clearInterval(timer);
          resolve();
        }
      };
      const timer = setInterval(check, 25) as unknown as number;
      check();
    });
  }

  /** Resolve when playback time reaches the specified target time (ms). */
  public waitForDrainUntil(targetMs: number): Promise<void> {
    const safetyMs = 20;
    return new Promise((resolve) => {
      const check = () => {
        const now = performance.now();
        if (now + safetyMs >= targetMs) {
          if (timer) clearInterval(timer);
          resolve();
        }
      };
      const timer = setInterval(check, 25) as unknown as number;
      check();
    });
  }
}

// ===== Helpers (local to player) =====

function base64ToUint8(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// (intentionally empty: removed sample scaling and per-chunk fades to avoid new artifacts)
