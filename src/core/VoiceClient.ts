import { ProtocolClient } from './ProtocolClient';
import { EventEmitter } from './EventEmitter';
import { AudioSender } from './AudioSender';
import type {
  TransportOptions,
  AudioSenderOptions,
  VoiceClientOptions,
  HeygenAvatarOptions,
  AudioVisualizerOptions,
  DebugMode,
} from '../types/config';
import { StreamingEvents } from './HeygenAvatarClient';
import {
  DEFAULT_AUDIO_OPTIONS,
  DEFAULT_TRANSPORT_OPTIONS,
  DEFAULT_HEYGEN_AVATAR_OPTIONS,
} from '../types/config';
import { HeygenAvatarClient } from './HeygenAvatarClient';
import { AudioVisualizer } from './AudioVisualizer';
import { EVENT } from './events';
import { AudioPlayer } from './AudioPlayer';
import { attachDebugLogs } from '../utils/debug';
import { MarkQueue, isInterruptMark } from '../utils/marks';
import { resamplePcm16, pcm16ToBase64, base64ToUint8 } from '../utils/audioUtils';
import { mulaw } from 'alawmulaw';

export interface VoiceClientConfig extends VoiceClientOptions {
  server_config: TransportOptions;
  audio_config?: Partial<AudioSenderOptions>;
  video_config?: Partial<HeygenAvatarOptions>;
  visualizer_config?: Partial<AudioVisualizerOptions>;
  debug?: boolean | DebugMode;
  mode?: 'audio' | 'video';
  useAudioVisualizer?: boolean;
  useCompressor?: boolean;
  agentName: string; // Required agent name
}

export class VoiceClient extends EventEmitter {
  private proto: ProtocolClient;
  private audio: AudioSender;
  private videoAvatar?: HeygenAvatarClient;
  private _endedByUser = false;
  private streamSid = '';
  private micStarted = false;
  private debugMode: DebugMode;
  private debugComponents = false; // inline component logs
  private debugEvents = false; // event logs via debug util
  private useAudioVisualizer: boolean;
  private audioVisualizer: AudioVisualizer | null = null;
  private audioPlayer: AudioPlayer | null = null; // Playback for server audio
  private _outputElement: HTMLAudioElement | null = null;
  private _isRunning = false;
  private _isStarting = false; // Track if call is in process of starting
  private _abortController: AbortController | null = null;
  private _isAborting = false; // Track if abort is in progress
  private _isTalking = false; // Avatar talking state (video mode)
  private _lastMark: string | null = null; // Buffer latest mark from server
  private _videoAudioBuffer: Int16Array[] = []; // Accumulates TTS audio chunks between marks (video mode)
  private _pendingVideoAudioBuffer: Int16Array[] = []; // Audio received before avatar ready
  private _pendingMark: string | null = null; // Mark received before avatar ready
  private _videoReady = false; // whether avatar stream is ready
  private _pendingCompletionText: string | null = null; // store completion text until avatar ready
  private _markQueue = new MarkQueue();
  private _micMuted = false; // Mic mute state
  private _audioMuted = false; // AudioPlayer mute state
  private _debugHandlersSetup = false; // Track internal debug logging wiring

  /** Whether the client is currently running (connected and streaming) */
  public get isRunning(): boolean {
    return this._isRunning;
  }

  /** Whether the client is in the process of starting */
  public get isStarting(): boolean {
    return this._isStarting;
  }

  public get isBusy(): boolean {
    return this._isStarting || this._isRunning;
  }

  /** Whether mic is currently muted */
  public get isMicMuted(): boolean {
    return this._micMuted;
  }

    public get isAudioMuted(): boolean {
    return this._audioMuted;
  }

  /** Mute/unmute the AudioPlayer (client-side). When muted, playback is silenced. */
  public setAudioMuted(muted: boolean) {
    this._audioMuted = !!muted;
    if (this.audioPlayer) {
      this.audioPlayer.setVolume(this._audioMuted ? 0 : 1.0);
    }
    else if (this.videoAvatar) {
      this.videoAvatar.setMuted(this._audioMuted);
    }
    this.emit(EVENT.AUDIO_MUTED, { streamSid: this.streamSid, muted: this._audioMuted });
  }

  /** Mute/unmute the mic (client-side). When muted, audio frames are not sent. */
  public setMicMuted(muted: boolean) {
    this._micMuted = !!muted;
    // Control the visualizer visibility and updates based on mute state
    if (this.useAudioVisualizer) {
      const container = document.getElementById('audioVisualizer');
      if (this._micMuted) {
        try {
          // Stop analyser loop so bars stop moving
          (this.audio as any).clearVisualizer?.();
        } catch {}
        if (container) container.style.visibility = 'hidden';
      } else {
        // Restore analyser updates and show container if call is running
        if (this._isRunning) {
          // Ensure the visualizer exists (it may not if we started while muted)
          if (!this.audioVisualizer) {
            this.setupAudioVisualizer();
          }
          try {
            const numBands = this.visualizer_config?.numBands ?? 6;
            this.audio.setVisualizer(
              (levels) => {
                if (this.audioVisualizer) this.audioVisualizer.updateLevels(levels);
              },
              { numBands },
            );
          } catch {}
          const el = container ?? document.getElementById('audioVisualizer');
          if (el) el.style.visibility = 'visible';
        }
      }
    }
    // Notify listeners of mute state change
    this.emit(EVENT.MIC_MUTED, { streamSid: this.streamSid, muted: this._micMuted });
  }

  /** Whether the client is in the process of aborting */
  public get isAborting(): boolean {
    return this._isAborting;
  }

  /** Whether the avatar is currently talking (video mode). */
  public get isTalking(): boolean {
    return this._isTalking;
  }

  private initServer(config: VoiceClientConfig): TransportOptions & { debug: boolean } {
    return {
      ...DEFAULT_TRANSPORT_OPTIONS,
      ...config.server_config,
      debug: this.debugComponents,
    };
  }

  private initAudio(config: VoiceClientConfig): AudioSenderOptions & { debug: boolean } {
    return {
      ...DEFAULT_AUDIO_OPTIONS,
      ...config.audio_config,
      debug: this.debugComponents,
    };
  }

  private initVideo(config: VoiceClientConfig) {
    if (config.mode !== 'video') return;
    if (!config.video_config?.videoElement) {
      throw new Error('videoElement is required for video mode');
    }
    if (!config.video_config?.avatarName || typeof config.video_config.avatarName !== 'string') {
      throw new Error('avatarName is required and must be a string for video mode');
    }

    const finalVideoAvatarOpts: HeygenAvatarOptions & { debug: boolean } = {
      ...DEFAULT_HEYGEN_AVATAR_OPTIONS,
      ...config.video_config,
      debug: this.debugComponents,
      voiceClient: this, // Pass reference to this VoiceClient instance
    };

    return new HeygenAvatarClient(finalVideoAvatarOpts);
  }

  private safeSendMark(name: string) {
    if (!this.isRunning) return;
    try {
      this.proto?.send('mark', { streamSid: this.streamSid, mark: { name } });
      // Emit locally so UI/debug can log mark transmissions
      this.emit(EVENT.MARK_SENT, { streamSid: this.streamSid, mark: { name } });
      this.debugComponents && console.log('[DEBUG VoiceClient] Sent mark after drain:', name);
    } catch (err) {
      this.debugComponents && console.error('[DEBUG VoiceClient] Failed sending mark:', err);
    }
  }

  private serverOpts: TransportOptions & { debug: boolean };
  private streamOpts: AudioSenderOptions & { debug: boolean };
  private visualizer_config?: AudioVisualizerOptions;
  private config: VoiceClientConfig;

  constructor(config: VoiceClientConfig) {
    super();
    /*if (!config.agentName || typeof config.agentName !== 'string' || !config.agentName.trim()) {
      throw new Error('agentName is required and must be a non-empty string');
    }*/
    this.config = config;
    this.debugMode = config.debug ?? false;
    // Normalize debug modes
    const mode = this.debugMode === true ? 'events' : this.debugMode;
    this.debugComponents = mode === 'components' || mode === 'all';
    this.debugEvents = mode === 'events' || mode === 'all';
    config.mode = config.mode ?? 'audio';
    this.useAudioVisualizer = config.useAudioVisualizer ?? false;

    this.serverOpts = this.initServer(config);
    this.streamOpts = this.initAudio(config);
    this.visualizer_config = config.visualizer_config;

    // ProtocolClient will be constructed in startCall with the correct URL
    this.proto = null as any;
    this.audio = new AudioSender(this.streamOpts);
    this.videoAvatar = this.initVideo(config);

    // We're using direct reference via voiceClient property instead of global references

    if (this.debugComponents) {
      config.server_config = this.serverOpts;
      config.audio_config = this.streamOpts;
      console.log('[DEBUG VoiceClient] Config:', config);
    }

    // Wire internal debug event handlers when debug is enabled
    const res = attachDebugLogs(
      this as unknown as any,
      this.debugEvents ? 'events' : false,
      this._debugHandlersSetup,
    );
    this._debugHandlersSetup = !!res.attached;
  }

  /** Allow host UI to provide an audio element for remote playback (optional) */
  public setOutputElement(el: HTMLAudioElement | null) {
    this._outputElement = el;
    try {
      // If we already have a remote stream object available, attach it
      const maybeStream = (this as any).remoteStream;
      if (this._outputElement && maybeStream && typeof (this._outputElement as any).srcObject !== 'undefined') {
        try {
          (this._outputElement as any).srcObject = maybeStream;
          this._outputElement.play().catch(() => {});
        } catch (e) {
          if (this.debugComponents) console.warn('[VoiceClient] attach output element failed', e);
        }
      }
    } catch (e) {
      if (this.debugComponents) console.warn('[VoiceClient] setOutputElement error', e);
    }
  }

  // Debug handled via attachDebugLogs util

  private async connect(websocketUrl: string) {
    this.proto = new ProtocolClient({
      ...this.serverOpts,
      url: websocketUrl,
      debug: this.debugComponents,
    });

    // Forward proto events, but handle error separately
    [
      EVENT.MIC_STREAM_OPEN,
      EVENT.MIC_STREAM_CLOSE,
      EVENT.MEDIA_RECEIVED,
      EVENT.MARK_RECEIVED,
    ].forEach((ev) => this.proto.on(ev, (data) => this.emit(ev, data)));
    // Ensure local state resets on connection close (network loss or normal stop)
    this.proto.on(EVENT.MIC_STREAM_CLOSE, async () => {
      try {
        // Stop mic and visualizer if still running
        await this.stopMic();
      } catch {}
      try {
        this.audioPlayer?.stop();
      } catch {}
      this.audioPlayer = null;
      // Reset control flags so UI can start again
      this._isStarting = false;
      // Only emit CALL_ENDED if call was actually started
      if (this._isRunning) {
        this.emit(EVENT.CALL_ENDED, { streamSid: this.streamSid, endedByUser: this._endedByUser });

        if (this.videoAvatar) {
          const videoStopped = new Promise<void>((resolve) => {
            this.videoAvatar?.once(StreamingEvents.STREAM_DISCONNECTED, () => {
              this.emit(EVENT.VIDEO_AVATAR_DISCONNECTED, { streamSid: this.streamSid });
              resolve();
            });
          });
          await this.videoAvatar.stop();
          await videoStopped;
        }
      }
      this._isRunning = false;
      this._isAborting = false;
      this._abortController = null;
      this._endedByUser = false;
    });

    // Playback: stream play media and clear between utterances
    this.proto.on(EVENT.MEDIA_RECEIVED, (payload: any) => {
      try {
        const b64: string | undefined = payload?.media?.payload ?? payload?.data ?? payload?.media;
        const meta: any = payload?.meta ?? payload?.media?.meta;
        if (this.videoAvatar) {
          // Video mode: accumulate decoded PCM into buffer until mark arrives
          if (b64) {
            const bytes = base64ToUint8(b64);
            const pcm16 = mulaw.decode(bytes);
            this._videoAudioBuffer.push(pcm16);
          }
        } else {
          if (b64) this.audioPlayer?.appendChunk(b64, meta);
        }
      } catch (e) {
        this.debugComponents && console.warn('[VoiceClient] media received handler failed:', e);
      }
    });

    if (!this.videoAvatar) {
      this.proto.on(EVENT.INTERRUPT, () => this.audioPlayer?.clear());

      // Capture marks as end-of-utterance signals OR server interrupt markers
      this.proto.on(EVENT.MARK_RECEIVED, async (payload: any) => {
        const markName: string | undefined = payload?.mark?.name ?? payload?.name;
        if (!markName) return;
        if (isInterruptMark(markName)) {
          try {
            this.audioPlayer?.interrupt?.();
          } catch {}
          this._markQueue.clearAndBump();
          this.emit(EVENT.INTERRUPT, { streamSid: this.streamSid, mark: markName });
          this.safeSendMark(markName);
          return;
        }
        // Snapshot current queue end time so we only wait for audio up to this mark
        const queueEndAtMs = this.audioPlayer?.getQueueEndTimeMs?.() ?? performance.now();
        this._markQueue.push({ name: markName, queueEndAtMs });
        // Process queue serially
        await this._markQueue.flush(
          async (ms: number) => await this.audioPlayer?.waitForDrainUntil?.(ms),
          (name: string) => this.safeSendMark(name),
        );
      });
    }

    // Handle error events with abort check
    this.proto.on(EVENT.ERROR, (data) => {
      if (!this._isAborting) {
        this.emit(EVENT.ERROR, data);
      } else if (this.debugComponents) {
        console.warn('[DEBUG VoiceClient] Suppressed error event during abort:', data);
      }
    });

    await this.proto.connect();
    this.streamSid = 'RT' + Math.random().toString(16).slice(2, 12).toUpperCase();
    this.proto.send('start', { streamSid: this.streamSid });
    this.emit(EVENT.MIC_STREAM_STARTED, { streamSid: this.streamSid });

    if (this.videoAvatar) {
      this.videoAvatar.on(StreamingEvents.AVATAR_START_TALKING, () => {
        this._isTalking = true;
      });
      this.videoAvatar.on(StreamingEvents.STREAM_READY, () => {
        this._videoReady = true;
        // Flush any audio that arrived before session was ready
        if (this._pendingVideoAudioBuffer.length > 0) {
          const buffer = this._pendingVideoAudioBuffer;
          this._pendingVideoAudioBuffer = [];
          const markName = this._pendingMark;
          this._pendingMark = null;
          const totalLen = buffer.reduce((s, c) => s + c.length, 0);
          const combined = new Int16Array(totalLen);
          let offset = 0;
          for (const chunk of buffer) { combined.set(chunk, offset); offset += chunk.length; }
          resamplePcm16(combined, 16000, 24000).then((pcm24k) => {
            const b64 = pcm16ToBase64(pcm24k);
            this.debugComponents && console.log('[VoiceClient] Flushing pending audio on STREAM_READY, mark:', markName);
            this.videoAvatar?.speakAudio(b64);
            if (markName) this._lastMark = markName;
          }).catch((err: any) => {
            this.debugComponents && console.error('[VoiceClient] pending resample error', err);
          });
        }
      });
      this.videoAvatar.on(StreamingEvents.AVATAR_STOP_TALKING, () => {
        this._isTalking = false;
        if (this._lastMark) this.safeSendMark(this._lastMark);
        this._lastMark = null;
      });

      // Video mode mark handling:
      // Non-interrupt mark -> flush accumulated audio buffer -> resample to 24kHz -> send to avatar
      // Interrupt mark -> clear buffer, interrupt avatar, echo mark immediately
      this.proto.on(EVENT.MARK_RECEIVED, async (payload: any) => {
        const markName: string | undefined = payload?.mark?.name ?? payload?.name;
        if (!markName) return;
        if (isInterruptMark(markName)) {
          this._videoAudioBuffer = [];
          try { this.videoAvatar?.interrupt(); } catch {}
          this.emit(EVENT.INTERRUPT, { streamSid: this.streamSid, mark: markName });
          this._lastMark = null;
          this.safeSendMark(markName);
          return;
        }
        // If avatar not ready yet, accumulate into pending buffer
        if (!this._videoReady) {
          // Keep accumulating; last mark wins (will be sent after STREAM_READY flush)
          this._pendingVideoAudioBuffer.push(...this._videoAudioBuffer);
          this._videoAudioBuffer = [];
          this._pendingMark = markName;
          this.debugComponents && console.log('[VoiceClient] Avatar not ready, queuing audio for mark:', markName);
          return;
        }
        // Flush buffer: concatenate all accumulated PCM16 chunks
        if (this._videoAudioBuffer.length > 0) {
          const buffer = this._videoAudioBuffer;
          this._videoAudioBuffer = [];
          try {
            const totalLen = buffer.reduce((s, c) => s + c.length, 0);
            const combined = new Int16Array(totalLen);
            let offset = 0;
            for (const chunk of buffer) { combined.set(chunk, offset); offset += chunk.length; }
            // Resample 16kHz -> 24kHz then send to avatar
            resamplePcm16(combined, 16000, 24000).then((pcm24k) => {
              const b64 = pcm16ToBase64(pcm24k);
              this.videoAvatar?.speakAudio(b64);
            }).catch((err: any) => {
              this.debugComponents && console.error('[VoiceClient] resample error', err);
            });
          } catch (err) {
            this.debugComponents && console.error('[VoiceClient] audio flush error', err);
          }
        }
        // Buffer mark — echoed after AVATAR_STOP_TALKING (AVATAR_SPEAK_ENDED)
        this._lastMark = markName;
      });
    }
  }

  private startMic() {
    // Set up audio visualizer only if enabled and not muted
    if (this.useAudioVisualizer && !this._micMuted) {
      this.setupAudioVisualizer();
    } else if (this.useAudioVisualizer && this._micMuted) {
      const container = document.getElementById('audioVisualizer');
      if (container) container.style.visibility = 'hidden';
    }

    this.audio
      .start((chunk: ArrayBuffer, meta?: any) => {
        // Drop frames when muted
        if (this._micMuted) return;

        // Convert to base64 for sending (existing logic)
        const b64chunk = btoa(String.fromCharCode(...new Uint8Array(chunk)));
        if (meta) this.proto.send('media', { media: { payload: b64chunk }, meta });
        else this.proto.send('media', { media: { payload: b64chunk } });
      })
      .then(() => {
        // After audio pipeline is ready, hook analyser-based levels to visualizer (if not muted)
        if (this.useAudioVisualizer && this.audioVisualizer && !this._micMuted) {
          const numBands = this.visualizer_config?.numBands ?? 6;
          this.audio.setVisualizer(
            (levels) => {
              if (this.audioVisualizer) this.audioVisualizer.updateLevels(levels);
            },
            { numBands },
          );
        }
      });

    this.micStarted = true;
  }

  private async stopMic() {
    if (!this.micStarted) return;

    // Clean up audio visualizer if it was enabled and created
    if (this.useAudioVisualizer && this.audioVisualizer) {
      this.audioVisualizer.dispose();
      this.audioVisualizer = null;
      if (this.debugComponents) console.log('[DEBUG VoiceClient] Audio visualizer disposed');

      // Hide the visualizer container
      const container = document.getElementById('audioVisualizer');
      if (container) {
        container.style.visibility = 'hidden';
        if (this.debugComponents)
          console.log('[DEBUG VoiceClient] Audio visualizer container hidden');
      }
    }

    // Also clear analyser-based visualizer callback
    if (this.useAudioVisualizer) {
      try {
        (this.audio as any).clearVisualizer?.();
      } catch {}
    }

    this.audio.stop();
    this.micStarted = false;
    this.emit(EVENT.MIC_STREAM_STOPPED, { streamSid: this.streamSid });
  }
  private setupAudioVisualizer() {
    // If audio visualizer is disabled, don't set it up
    if (!this.useAudioVisualizer) {
      if (this.debugComponents)
        console.log('[DEBUG VoiceClient] Audio visualizer disabled by configuration');
      return;
    }

    // Clean up any existing visualizer
    if (this.audioVisualizer) {
      this.audioVisualizer.dispose();
      this.audioVisualizer = null;
    }

    // Get visualizer options from config
    const visualizerOptions: AudioVisualizerOptions = {
      elementId: 'audioVisualizer',
      numBands: 5,
      debug: this.debugComponents,
      ...this.visualizer_config,
    };

    try {
      if (visualizerOptions.elementId) {
        const container = document.getElementById(visualizerOptions.elementId);
        if (container) {
          // Show the container by making it visible
          container.style.visibility = 'visible';

          // Create the visualizer with our options
          this.audioVisualizer = new AudioVisualizer(visualizerOptions);
          if (this.debugComponents)
            console.log('[DEBUG VoiceClient] Audio visualizer created and displayed');
        } else if (this.debugComponents) {
          console.log(
            `[DEBUG VoiceClient] Audio visualizer container with ID "${visualizerOptions.elementId}" not found`,
          );
        }
      } else if (this.debugComponents) {
        console.log('[DEBUG VoiceClient] No elementId specified for audio visualizer');
      }
    } catch (err) {
      console.error('[VoiceClient] Error setting up audio visualizer:', err);
    }
  }

  private disconnect() {
    try {
      this.proto.send('stop', {});
    } catch (err) {
      console.error('[VoiceClient] Error sending stop:', err);
    }
    try {
      this.proto.disconnect();
    } catch (err) {
      console.error('[VoiceClient] Error disconnecting proto:', err);
    }
    //this.emit('disconnected', { streamSid: this.streamSid });
  }

  /**
   * Start a new call session. This will:
   * 1. Stop any existing call if running
   * 2. Connect to the server
   * 3. Start the microphone
   * 4. Initialize video if in video mode
   */
  /**
   * Abort an in-progress call start attempt.
   * This will immediately terminate any connection attempts and cleanup resources.
   */
  async abortCall() {
    if (!this._isStarting) return;

    this._isAborting = true;
    if (this.debugComponents) console.log('[DEBUG VoiceClient] Aborting call start...');

    // Abort any pending operations
    if (this._abortController) {
      this._abortController.abort();
    }

    // Force close the connection if proto exists
    if (this.proto && typeof this.proto.abort === 'function') {
      this.proto.abort();
    }

    // Make sure to stop the mic (and clean up audio visualizer)
    await this.stopMic();

    // Stop audio playback if active
    try {
      this.audioPlayer?.stop();
    } catch {}
    this.audioPlayer = null;

    // Reset state
    this._isStarting = false;
    this._isRunning = false;
    this._abortController = null;

    this.emit(EVENT.CALL_ABORTED, {});
    if (this.debugComponents) console.log('[DEBUG VoiceClient] Call start aborted');
    
    // Clear aborting flag after a tick to allow error events to be suppressed
    /*setTimeout(() => {
      this._isAborting = false;
    }, 100);*/
  }

  async startCall() {
    if (this._isRunning || this._isStarting) {
      if (this.debugComponents) console.log('[DEBUG VoiceClient] Call already in progress...');
      return;
    }
    try {
      // Check microphone permission first
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach((t) => t.stop());
      } catch (err) {
        this.emit(EVENT.MIC_PERMISSION_ERROR, {
          message: 'Microphone permission denied',
          error: err instanceof Error ? err.message : String(err),
        });
        console.warn('Microphone permission denied');
        return;   
      }

      // Reset abort state when starting a new call
      this._isAborting = false;
      this._isStarting = true;
      this._abortController = new AbortController();

      // Start video avatar initialization in parallel (if available)
      let videoReadyPromise: Promise<void> | null = null;
      if (this.videoAvatar) {
        videoReadyPromise = new Promise<void>((resolve) => {
          this.videoAvatar?.once(StreamingEvents.STREAM_READY, () => {
            this.emit(EVENT.VIDEO_AVATAR_READY, {});
            resolve();
          });
        });
        // Start initializing the video avatar right away
        this.videoAvatar.initialize().catch((err) => {
          if (!this._isAborting && !this.videoAvatar?.isAborting) console.error('[DEBUG VoiceClient] Video avatar init error:', err);
          
          if (this._isStarting)
          {
            this.abortCall();
          }
          else if (this._isRunning){
            this.endCall();
          }
         
        
        });
      }

      const getStreamUrlConfig = this.config.server_config.get_stream_url_config;
      const fetchOptions: RequestInit = {
        signal: this._abortController.signal,
        method: getStreamUrlConfig.payload ? 'POST' : 'GET',
        headers: getStreamUrlConfig.extra_headers ? { ...getStreamUrlConfig.extra_headers } : undefined,
        body: getStreamUrlConfig.payload ? JSON.stringify(getStreamUrlConfig.payload) : undefined,
      };
      let websocketUrl: string;

      try {
        const res = await fetch(getStreamUrlConfig.url, fetchOptions);

        if (!res.ok) {
          const txt = await res.text();
          this.emit(EVENT.ERROR, { 
            message: "Get stream URL request failed",
            status: res.status,
            statusText: res.statusText,
            body: txt
          });
          throw new Error(`get-stream-url failed: ${res.status} ${txt}`);
        }

        const body = await res.json();
        websocketUrl = body.data.websocket_url;

      } catch (err: any) {
        // Network error, timeout, CORS, etc.
        this.emit(EVENT.ERROR, {
          message: "Network error while fetching stream URL",
          error: err?.message || err
        });
        throw err; // rethrow if you want upper layers to handle it too
      }
      try {
         new URL(websocketUrl);

          if (this.debugComponents)
            console.log('[DEBUG VoiceClient] Using proxied WS URL:', websocketUrl);
        
      } catch (error) {
        this.emit(EVENT.ERROR, { 
          message: 'Invalid websocket URL',
          error: error instanceof Error ? error.message : String(error)
        });
      } 

      // Start server audio playback only in audio mode (no video avatar)
      if (!this.videoAvatar) {
        if (!this.audioPlayer)
          this.audioPlayer = new AudioPlayer({
            sampleRate: this.streamOpts.sampleRate,
            latencyPadSec: 0.15,
            debug: this.debugComponents,
            useCompressor: this.config.useCompressor,
            compressorConfig: this.config.compressorConfig,
          });
        try {
          await this.audioPlayer.start();
          //await new Promise(resolve => setTimeout(resolve, 300));
        } catch {}
      }

      await this.connect(websocketUrl);

      // Wait for video ready if we started it earlier
      if (videoReadyPromise) {
        await videoReadyPromise;
      }

      this.startMic();

      this._isRunning = true;
      this._isStarting = false;
      this.emit(EVENT.CALL_STARTED, { streamSid: this.streamSid });
      if (this.debugComponents) {
        console.log('[DEBUG VoiceClient] Call started successfully');
      }
    } catch (error) {
      this._isRunning = false;
      this._isStarting = false;
      this._abortController = null;

      // Handle aborts: DOMException (AbortError) or WebSocket Event error during abort
      if (
        (error instanceof DOMException && error.name === 'AbortError') ||
        (typeof Event !== 'undefined' &&
          error instanceof Event &&
          error.type === 'error' &&
          !this._isRunning)
      ) {
        return;
      }

      if (this.debugComponents) {
        console.error('[DEBUG VoiceClient] Failed to start call:', error);
      }


      if (this.videoAvatar){
        this.videoAvatar.isAborting = true;
      }


      throw error;
    }
  }

  /**
   * Stop the current call session. This will:
   * 1. Stop the microphone
   * 2. Stop the video avatar if active
   * 3. Disconnect from the server
   */
  async endCall() {
    this._endedByUser = true;
    if (this._isStarting) {
      if (this.debugComponents)
        console.log('[DEBUG VoiceClient] Call is starting, aborting instead of ending normally');
      await this.abortCall();
      return;
    }
    try {
      await this.stopMic();

      if (this.videoAvatar) {
        const videoStopped = new Promise<void>((resolve) => {
          this.videoAvatar?.once(StreamingEvents.STREAM_DISCONNECTED, () => {
            this.emit(EVENT.VIDEO_AVATAR_DISCONNECTED, { streamSid: this.streamSid });
            resolve();
          });
        });
        await this.videoAvatar.stop();
        await videoStopped;
      }

      this.disconnect();
      try {
        this.audioPlayer?.stop();
      } catch {}
      this.audioPlayer = null;
      //this._isRunning = false;
      //this.emit(EVENT.CALL_ENDED, { streamSid: this.streamSid, endedByUser: true });
      if (this.debugComponents) {
        console.log('[DEBUG VoiceClient] Call stopped successfully');
      }
    } catch (error) {
      this._isRunning = false; // ensure it's false even on error
      if (this.debugComponents) {
        console.error('[DEBUG VoiceClient] Error stopping call:', error);
      }
      throw error;
    }
  }
}
