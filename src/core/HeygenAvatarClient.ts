import StreamingAvatar, {
  AvatarQuality,
  StreamingEvents,
  TaskType,
} from '@heygen/streaming-avatar';
import type { HeygenAvatarOptions } from '../types/config';
import { DEFAULT_HEYGEN_AVATAR_OPTIONS } from '../types/config';
import { EVENT } from './events'
import { EventEmitter } from './EventEmitter';

export class HeygenAvatarClient extends EventEmitter {
  private avatar: StreamingAvatar | null = null;
  private videoElement: HTMLVideoElement;
  private apiUrl: string;
  private avatarName: string;
  private language?: string;
  private activityIdleTimeout?: number;
  private debug: boolean;
  private getTokenUrlConfig: HeygenAvatarOptions['get_token_url_config'];
  private voice?: any; // optional voice config forwarded to Heygen API
  private parentVoiceClient: any; // Store reference to parent VoiceClient
  private isInitializing = false; // Flag to track if initialization is in progress
  private isInitialized = false; // Flag to track if already initialized
  private _aborted = false;

  constructor(options: HeygenAvatarOptions & { voiceClient?: any }) {
    super();

    // ✅ Capture reference BEFORE cloning/spreading
    this.parentVoiceClient = options.voiceClient;

    // Merge with defaults AFTER keeping the live ref
    const finalOptions: HeygenAvatarOptions = {
      ...DEFAULT_HEYGEN_AVATAR_OPTIONS,
      ...options,
    };

    // Validate required fields
    if (!finalOptions.videoElement) {
      throw new Error('HeygenAvatarClient: videoElement is required');
    }
    if (!finalOptions.avatarName || typeof finalOptions.avatarName !== 'string') {
      throw new Error('HeygenAvatarClient: avatarName must be a string');
    }
    if (!finalOptions.get_token_url_config || !finalOptions.get_token_url_config.url) {
      throw new Error('HeygenAvatarClient: get_token_url_config.url is required');
    }

    this.videoElement = finalOptions.videoElement;
    this.apiUrl = finalOptions.get_token_url_config.url;
    this.avatarName = finalOptions.avatarName;
    this.debug = finalOptions.debug ?? false;
    this.getTokenUrlConfig = finalOptions.get_token_url_config;
  // Capture optional voice config (if present in video_config.voice)
  this.voice = (finalOptions as any).voice;
    this.language = finalOptions.language;
    this.activityIdleTimeout = finalOptions.activityIdleTimeout;

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

  /** Public accessor retained for compatibility; always returns false */
  public getIsTalking(): boolean {
    return false;
  }

  public setMuted(muted: boolean): void {
    if (this.avatar) {
      if (muted && !this.videoElement.muted) {
        this.videoElement.muted = true;
        if (this.debug) console.log('[DEBUG HeygenAvatarClient] Video muted');
      } else if (!muted && this.videoElement.muted) {
        this.videoElement.muted = false;
        if (this.debug) console.log('[DEBUG HeygenAvatarClient] Video unmuted');
      }
    }
  }
  // No mark buffering here; VoiceClient coordinates marks.

  private async fetchAccessToken(): Promise<string> {
    const fetchOptions: RequestInit = {
      method: this.getTokenUrlConfig!.payload ? 'POST' : 'GET',
      headers: this.getTokenUrlConfig!.extra_headers
        ? { ...this.getTokenUrlConfig!.extra_headers }
        : undefined,
      body: this.getTokenUrlConfig!.payload
        ? JSON.stringify(this.getTokenUrlConfig!.payload)
        : undefined,
    };

    const response = await fetch(this.apiUrl, fetchOptions);
    if (!response.ok) {
      const txt = await response.text();
      throw new Error(`get-access-token failed: ${response.status} ${txt}`);
    }
    const { token } = await response.json();
    return token;
  }

  public async initialize() {
    // Check if we're already initialized or initializing
    if (this.isInitialized) {
      // If parent VoiceClient is aborting, we'll allow reinitializing
      const isAborting = this.isAborting === true;

      if (!isAborting) {
        if (this.debug) {
          console.log(
            '[DEBUG HeygenAvatarClient] Already initialized, ignoring initialize request',
          );
        }
        return; // Skip initialization
      } else if (this.debug) {
        console.log(
          '[DEBUG HeygenAvatarClient] Already initialized but aborting, allowing reinitialization',
        );
      }
    }

    if (this.isInitializing) {
      if (this.debug) {
        console.log(
          '[DEBUG HeygenAvatarClient] Initialization already in progress, ignoring duplicate request',
        );
      }
      return;
    }

    try {
      this.isInitializing = true;

      const token = await this.fetchAccessToken();
      this.avatar = new StreamingAvatar({ token });

      /*if (this.debug) {
        // Debug event logging
        Object.values(StreamingEvents).forEach((event) => {
          this.avatar?.on(event, (data) =>
            console.log(`[DEBUG VoiceClient] Avatar Event ${event}:`, data),
          );
        });
      }*/

      // Bind event handlers
      this.avatar.on(StreamingEvents.STREAM_READY, this.handleStreamReady.bind(this));
      this.avatar.on(StreamingEvents.STREAM_DISCONNECTED, this.handleStreamDisconnected.bind(this));

      // Additional logging for interaction/talking events
      this.avatar.on(StreamingEvents.AVATAR_START_TALKING, (event: any) => {
        if (this.debug) console.log('Avatar has started talking:', event);
        this.emit(StreamingEvents.AVATAR_START_TALKING, event);
      });
      this.avatar.on(StreamingEvents.AVATAR_STOP_TALKING, (event: any) => {
        if (this.debug) console.log('Avatar has stopped talking:', event);
        this.emit(StreamingEvents.AVATAR_STOP_TALKING, event);
      });
      this.avatar.on(StreamingEvents.AVATAR_TALKING_MESSAGE, (message: any) => {
        if (this.debug) console.log('Avatar talking message:', message);
      });
      this.avatar.on(StreamingEvents.AVATAR_END_MESSAGE, (message: any) => {
        if (this.debug) console.log('Avatar end message:', message);
      });
      this.avatar.on(StreamingEvents.USER_TALKING_MESSAGE, (message: any) => {
        if (this.debug) console.log('User talking message:', message);
      });
      this.avatar.on(StreamingEvents.USER_END_MESSAGE, (message: any) => {
        if (this.debug) console.log('User end message:', message);
      });
      this.avatar.on(StreamingEvents.USER_START, (event: any) => {
        if (this.debug) console.log('User has started interaction:', event);
      });
      this.avatar.on(StreamingEvents.USER_STOP, (event: any) => {
        if (this.debug) console.log('User has stopped interaction:', event);
      });
      this.avatar.on(StreamingEvents.USER_SILENCE, () => {
        if (this.debug) console.log('User is silent');
      });

      // Build avatarConfig with user or default values
      let quality: AvatarQuality;
      const userQuality = this.parentVoiceClient?.video_config?.quality;
      if (typeof userQuality === 'string') {
        switch (userQuality.toLowerCase()) {
          case 'low':
            quality = AvatarQuality.Low;
            break;
          case 'medium':
            quality = AvatarQuality.Medium;
            break;
          case 'high':
            quality = AvatarQuality.High;
            break;
          default:
            quality = AvatarQuality.High;
        }
      } else if (userQuality && Object.values(AvatarQuality).includes(userQuality)) {
        quality = userQuality;
      } else {
        quality = AvatarQuality.High;
      }
      const avatarConfig = {
        quality,
        avatarName: this.avatarName || DEFAULT_HEYGEN_AVATAR_OPTIONS.avatarName,
        videoEncoding: this.parentVoiceClient?.video_config?.videoEncoding || DEFAULT_HEYGEN_AVATAR_OPTIONS.videoEncoding,
        language: this.language || DEFAULT_HEYGEN_AVATAR_OPTIONS.language,
        activityIdleTimeout: this.activityIdleTimeout || DEFAULT_HEYGEN_AVATAR_OPTIONS.activityIdleTimeout,
        ...(this.voice ? { voice: this.voice } : {}),
      };

      console.log('[DEBUG HeygenAvatarClient] Starting avatar with config:', avatarConfig);

      await this.avatar.createStartAvatar(avatarConfig);

      // Mark as initialized after successful initialization
      this.isInitialized = true;

      if (this.debug) {
        console.log('[DEBUG HeygenAvatarClient] Initialization completed successfully');
      }
    } finally {
      this.isInitializing = false;
    }
  }

  private handleStreamReady(event: any) {
  if (!event.detail || !this.videoElement) {
    throw new Error('Stream or video element not available');
  }

  const isAborting = this.isAborting === true;
  if (isAborting) {
    this.stop().catch((err) => {
      if (this.debug)
        console.warn('[DEBUG HeygenAvatarClient] Error stopping during abort:', err);
    });
    return;
  }

  const stream = event.detail as MediaStream;
  this.videoElement.srcObject = stream;

  // Ensure video element attributes allow autoplay
  this.videoElement.autoplay = true;
  this.videoElement.muted = false;
  this.videoElement.playsInline = true; // critical for iOS Safari

  // Try to play when metadata is ready
  this.videoElement.onloadedmetadata = async () => {
    try {
      await this.videoElement.play();
      if (this.debug) console.log('[DEBUG HeygenAvatarClient] Video stream playing');
      this.emit(StreamingEvents.STREAM_READY, stream);
    } catch (error) {
      console.warn('[DEBUG HeygenAvatarClient] Autoplay prevented, waiting for user gesture', error);
      // fallback: wait for a user gesture to start playback
      const resumePlayback = () => {
        this.videoElement.play().catch(() => {});
        window.removeEventListener('click', resumePlayback);
      };
      window.addEventListener('click', resumePlayback);
    }
  };
}


  private handleStreamDisconnected() {
    if (this.videoElement) {
      this.videoElement.srcObject = null;
      if (this.debug) console.log('[DEBUG VoiceClient] Video Avatar Disconnected');
      this.emit(StreamingEvents.STREAM_DISCONNECTED);
    }
  }

  public async speak(text: string, task = 'talk') {
    if (this.avatar && text) {
      const config = {
        taskType: task == 'talk' ? TaskType.TALK : TaskType.REPEAT,
        text: text,
      };
      try {
        await this.avatar.speak(config);
      } catch (error) {
        throw error;
      }
    } else {
      const error = 'Avatar not initialized or empty text provided';
      throw new Error(error);
    }
  }

  public async interrupt() {
    if (this.avatar) {
      try {
        await this.avatar.interrupt();
        if (this.debug) console.log('[DEBUG VoiceClient] Avatar Interrupt Sent');
      }
      catch (error) {
        throw error;
      }
    }
  }

  public async stop() {
    if (!this.avatar) {
      return;
    }

    try {
      await this.avatar.stopAvatar();
      this.videoElement.srcObject = null;
      this.avatar = null;
      this.isInitialized = false; // Reset the initialization flag
      if (this.debug) console.log('[DEBUG VoiceClient] Video Avatar Stopped Successfully');
    } catch (error) {
      throw error;
    }
  }
}
