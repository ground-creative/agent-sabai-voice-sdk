// Centralized application event names to avoid string literals everywhere
export const EVENT = {
  // mic / transport
  MIC_STREAM_OPEN: 'mic_stream_open',
  MIC_STREAM_STARTED: 'mic_stream_started',
  MIC_STREAM_STOPPED: 'mic_stream_stopped',
  MIC_STREAM_CLOSE: 'mic_stream_close',
  MIC_PERMISSION_ERROR: 'mic_permission_error',

  MIC_MUTED: 'mic_muted',

  // audio playback
  AUDIO_MUTED: 'audio_muted',

  // protocol / data
  MEDIA_RECEIVED: 'media_received',
  COMPLETION_MESSAGE: 'completion_message',
  INTERRUPT: 'interrupt',

  // control / marks
  MARK_RECEIVED: 'mark_received',
  MARK_SENT: 'mark_sent',

  // video / avatar
  VIDEO_AVATAR_READY: 'video_avatar_ready',
  VIDEO_AVATAR_DISCONNECTED: 'video_avatar_disconnected',

  // call lifecycle
  CALL_STARTED: 'call_started',
  CALL_ENDED: 'call_ended',
  CALL_ABORTED: 'call_aborted',

  // diagnostics
  ERROR: 'error',

  // reconnect
  RECONNECTING: 'reconnecting',
  STOP_RECONNECTING: 'stop_reconnecting',
} as const;

export type EventName = (typeof EVENT)[keyof typeof EVENT];

// Standardized payload for error events across layers
export interface AppErrorPayload {
  source: 'transport' | 'protocol' | 'app';
  message: string;
  fatal: boolean;
  code?: number | string;
  cause?: unknown;
}
