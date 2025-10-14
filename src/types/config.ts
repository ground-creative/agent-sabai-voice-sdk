// src/types/config.ts


export interface GetStreamUrlConfig {
  url: string;
  extra_headers?: Record<string, string>;
  payload?: any;
}

export interface GetTokenUrlConfig {
  url: string | 'https://api.heygen.com/streaming-avatar';
  extra_headers?: Record<string, string>;
  payload?: any;
}

export interface TransportOptions {
  get_stream_url_config: GetStreamUrlConfig;
  protocols?: string | string[];
  reconnect?: boolean;
  reconnectInterval?: number;
  maxReconnects?: number;
  debug?: boolean;
}

export const DEFAULT_TRANSPORT_OPTIONS: Omit<TransportOptions, 'url'> = {
  get_stream_url_config: {
    url: '',
    extra_headers: undefined,
    payload: undefined,
  },
  protocols: undefined,
  reconnect: true,
  reconnectInterval: 2000,
  maxReconnects: 5,
};

export interface AudioSenderOptions {
  sampleRate: 16000;
  frameMs: 20;
  debug?: boolean;
  constraints?: MediaTrackConstraints & {
    [key: string]: any;
    voiceIsolation?: boolean;
    latency?: number;
  };
}

export const DEFAULT_AUDIO_OPTIONS: AudioSenderOptions = {
  sampleRate: 16000,
  frameMs: 20,
  constraints: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    voiceIsolation: true,
  },
};

export type DebugMode = boolean | 'events' | 'components' | 'all';

export interface CompressorConfig {
  thresholdDb?: number;  // start compressing above this level (default: -18)
  ratio?: number;        // compression ratio (default: 3.0)
  attackMs?: number;     // attack time in ms (default: 5)
  releaseMs?: number;    // release time in ms (default: 150)
  makeupDb?: number;     // makeup gain in dB (default: 3)
}

export interface VoiceClientOptions {
  debug?: DebugMode; // false/off, true|'events' for event logs, 'components' for inline logs, 'all' for both
  mode?: 'audio' | 'video';
  useAudioVisualizer?: boolean;
  useCompressor?: boolean;
  compressorConfig?: CompressorConfig;
}

export interface HeygenAvatarOptions {
  videoElement: HTMLVideoElement;
  get_token_url_config?: GetTokenUrlConfig;
  debug?: boolean;
  avatarName: string;
  quality?: string; 
  language?: string;
  activityIdleTimeout?: number; 
  videoEncoding?: string;
  voiceClient?: any;
}

export const DEFAULT_HEYGEN_AVATAR_OPTIONS: HeygenAvatarOptions = {
  videoElement: undefined as unknown as HTMLVideoElement,
  get_token_url_config: undefined,
  avatarName: 'Wayne_20240711',
  language: 'en',
  activityIdleTimeout: 120,
  videoEncoding: 'VP8',
};

export interface AudioVisualizerOptions {
  elementId?: string; // ID of DOM element to use as container
  containerClass?: string; // Class for the visualizer container (default: 'audio-visualizer')
  barClass?: string; // Class for the equalizer bars (default: 'equalizer-bar')
  numBands?: number; // Number of frequency bands/bars to display
  autoCreate?: boolean; // Whether to auto-create the container if elementId not found
  smoothing?: number; // Animation smoothing factor (0-1)
  minLevel?: number; // Minimum level for bars when quiet (0-1)
  sensitivity?: number; // Multiplier for how much bars grow (e.g., 0.5 - less, 1 - normal, 2 - more)
  debug?: boolean; // Enable debug logging
}

export const DEFAULT_AUDIO_VISUALIZER_OPTIONS: AudioVisualizerOptions = {
  containerClass: 'audio-visualizer',
  barClass: 'equalizer-bar',
  numBands: 6, // Increased number of bands for better visualization
  autoCreate: false,
  smoothing: 0.4, // Slightly smoother default animation
  minLevel: 0.05, // Lower minimum level for better dynamic range
  sensitivity: 20, // Slightly more responsive by default
};
