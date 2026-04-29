import {
  LiveAvatarSession,
  SessionEvent,
  AgentEventsEnum,
} from '@heygen/liveavatar-web-sdk';
import type { HeygenAvatarOptions } from '../types/config';
import { DEFAULT_HEYGEN_AVATAR_OPTIONS } from '../types/config';
import { EVENT } from './events';
import { EventEmitter } from './EventEmitter';

// Re-export the event names VoiceClient listens for, keeping the same string
// values so all existing .on() calls in VoiceClient.ts continue to work unchanged.
export const StreamingEvents = {
  STREAM_READY: 'stream_ready',
  STREAM_DISCONNECTED: 'stream_disconnected',
  AVATAR_START_TALKING: 'avatar_start_talking',
  AVATAR_STOP_TALKING: 'avatar_stop_talking',
  AVATAR_TALKING_MESSAGE: 'avatar_talking_message',
  AVATAR_END_MESSAGE: 'avatar_end_message',
  USER_TALKING_MESSAGE: 'user_talking_message',
  USER_END_MESSAGE: 'user_end_message',
  USER_START: 'user_start',
  USER_STOP: 'user_stop',
  USER_SILENCE: 'user_silence',
  CONNECTION_QUALITY_CHANGED: 'connection_quality_changed',
} as const;

export class HeygenAvatarClient extends EventEmitter {
  private session: LiveAvatarSession | null = null;
  private videoElement: HTMLVideoElement;
  private getTokenUrlConfig: HeygenAvatarOptions['get_token_url_config'];
  private debug: boolean;
  private parentVoiceClient: any;
  private isInitializing = false;
  private isInitialized = false;
  private _aborted = false;

  constructor(options: HeygenAvatarOptions & { voiceClient?: any }) {
    super();

    this.parentVoiceClient = options.voiceClient;

    const finalOptions: HeygenAvatarOptions = {
      ...DEFAULT_HEYGEN_AVATAR_OPTIONS,
      ...options,
    };

    if (!finalOptions.videoElement) {
      throw new Error('HeygenAvatarClient: videoElement is required');
    }
    if (!finalOptions.get_token_url_config?.url) {
      throw new Error('HeygenAvatarClient: get_token_url_config.url is required');
    }

    this.videoElement = finalOptions.videoElement;
    this.getTokenUrlConfig = finalOptions.get_token_url_config;
    this.debug = finalOptions.debug ?? false;

    this.parentVoiceClient.on(EVENT.CALL_ABORTED, () => {
      this._aborted = true;
      if (this.debug) console.warn('[HeygenAvatarClient] Call aborted');
    });
  }

  public get isAborting(): boolean {
    return this._aborted;
  }

  public set isAborting(value: boolean) {
    this._aborted = value;
  }

  /** Compatibility stub */
  public getIsTalking(): boolean {
    return false;
  }

  public setMuted(muted: boolean): void {
    if (this.videoElement) {
      this.videoElement.muted = muted;
    }
  }

  private async fetchAccessToken(): Promise<string> {
    const cfg = this.getTokenUrlConfig!;
    const fetchOptions: RequestInit = {
      method: cfg.payload ? 'POST' : 'GET',
      headers: cfg.extra_headers ? { ...cfg.extra_headers } : undefined,
      body: cfg.payload ? JSON.stringify(cfg.payload) : undefined,
    };
    const response = await fetch(cfg.url, fetchOptions);
    if (!response.ok) {
      const txt = await response.text();
      throw new Error(`get-access-token failed: ${response.status} ${txt}`);
    }
    const body = await response.json();
    return typeof body === 'string' ? body : body.token ?? body.access_token ?? body.session_token ?? body;
  }

  public async initialize() {
    if (this.isInitialized && !this._aborted) {
      if (this.debug) console.log('[HeygenAvatarClient] Already initialized');
      return;
    }
    if (this.isInitializing) {
      if (this.debug) console.log('[HeygenAvatarClient] Initialization already in progress');
      return;
    }

    try {
      this.isInitializing = true;

      const token = await this.fetchAccessToken();
      if (this.debug) console.log('[HeygenAvatarClient] Got session token, starting LiveAvatarSession');

      this.session = new LiveAvatarSession(token, { voiceChat: false } as any);

      // Stream ready -> attach to video element
      this.session.on(SessionEvent.SESSION_STREAM_READY, () => {
        if (this._aborted) {
          this.stop().catch(() => {});
          return;
        }
        if (this.session) {
          this.session.attach(this.videoElement);
        }
        this.videoElement.autoplay = true;
        this.videoElement.muted = false;
        this.videoElement.playsInline = true;
        this.videoElement.onloadedmetadata = async () => {
          try {
            await this.videoElement.play();
            if (this.debug) console.log('[HeygenAvatarClient] Video stream playing');
            this.emit(StreamingEvents.STREAM_READY, null);
          } catch (err) {
            console.warn('[HeygenAvatarClient] Autoplay prevented, waiting for user gesture', err);
            const resume = () => {
              this.videoElement.play().catch(() => {});
              window.removeEventListener('click', resume);
            };
            window.addEventListener('click', resume);
          }
        };
      });

      // Disconnected
      this.session.on(SessionEvent.SESSION_DISCONNECTED, () => {
        this.videoElement.srcObject = null;
        if (this.debug) console.log('[HeygenAvatarClient] Session disconnected');
        this.emit(StreamingEvents.STREAM_DISCONNECTED);
      });

      // Talking events -- forwarded so VoiceClient mark logic is unchanged
      this.session.on(AgentEventsEnum.AVATAR_SPEAK_STARTED, (e: any) => {
        if (this.debug) console.log('[HeygenAvatarClient] Avatar speak started', e);
        this.emit(StreamingEvents.AVATAR_START_TALKING, e);
      });
      this.session.on(AgentEventsEnum.AVATAR_SPEAK_ENDED, (e: any) => {
        if (this.debug) console.log('[HeygenAvatarClient] Avatar speak ended — calling startListening + emitting AVATAR_STOP_TALKING', e);
        // Transition back to listening so next audio can be received
        try { this.session?.startListening(); } catch {}
        this.emit(StreamingEvents.AVATAR_STOP_TALKING, e);
      });

      await this.session.start();
      // Put avatar into listening state immediately after session starts
      try {
        this.session.startListening();
        if (this.debug) console.log('[HeygenAvatarClient] startListening sent after session start');
      } catch (e) {
        if (this.debug) console.warn('[HeygenAvatarClient] startListening failed', e);
      }
      this.isInitialized = true;
      if (this.debug) console.log('[HeygenAvatarClient] LiveAvatarSession started');
    } finally {
      this.isInitializing = false;
    }
  }

  /**
   * Send a batch of TTS audio to the avatar (LITE mode).
   * Audio must be PCM-16 24 kHz encoded as base64.
   * Called by VoiceClient when a mark flushes the accumulated audio buffer.
   */
  public speakAudio(base64Pcm24k: string): void {
    if (!this.session) {
      if (this.debug) console.warn('[HeygenAvatarClient] speakAudio called but session not ready');
      return;
    }
    try {
      // Transition avatar from listening → speaking
      this.session.stopListening();
      if (this.debug) console.log('[HeygenAvatarClient] stopListening sent, sending audio chunk len:', base64Pcm24k.length);
      this.session.repeatAudio(base64Pcm24k);
      if (this.debug) console.log('[HeygenAvatarClient] repeatAudio sent');
    } catch (err) {
      if (this.debug) console.error('[HeygenAvatarClient] speakAudio error', err);
    }
  }

  public interrupt(): void {
    if (this.session) {
      try {
        this.session.interrupt();
        if (this.debug) console.log('[HeygenAvatarClient] Interrupt sent');
      } catch (err) {
        if (this.debug) console.error('[HeygenAvatarClient] Interrupt error', err);
      }
    }
  }

  public async stop() {
    if (!this.session) return;
    try {
      await this.session.stop();
      this.videoElement.srcObject = null;
      if (this.debug) console.log('[HeygenAvatarClient] Session stopped');
    } catch {
      // ignore stop errors
    } finally {
      this.session = null;
      this.isInitialized = false;
    }
  }
}
