import { EVENT } from '../core/events';
import type { EventEmitter } from '../core/EventEmitter';
import type { DebugMode } from '../types/config';

// Attach console logging for key VoiceClient events when debug is enabled
export function attachDebugLogs(emitter: EventEmitter, debug: DebugMode, already?: boolean) {
  if (!debug || already) return { attached: false };
  const mode = debug === true ? 'events' : debug;
  if (mode !== 'events' && mode !== 'all') return { attached: false };
  const events = [
    EVENT.MIC_STREAM_OPEN,
    EVENT.MIC_STREAM_STARTED,
    EVENT.MIC_STREAM_STOPPED,
    EVENT.MIC_STREAM_CLOSE,
    EVENT.MIC_MUTED,
    EVENT.MEDIA_RECEIVED,
    EVENT.MARK_RECEIVED,
    EVENT.INTERRUPT,
    EVENT.COMPLETION_MESSAGE,
    EVENT.VIDEO_AVATAR_READY,
    EVENT.VIDEO_AVATAR_DISCONNECTED,
    EVENT.CALL_STARTED,
    EVENT.CALL_ENDED,
    EVENT.MARK_SENT,
    EVENT.CALL_ABORTED,
    EVENT.ERROR,
    EVENT.AUDIO_MUTED,
    EVENT.RECONNECTING,
    EVENT.STOP_RECONNECTING,
    EVENT.MIC_PERMISSION_ERROR
  ] as const;
  events.forEach((ev) =>
    emitter.on(ev as any, (data: any) => {
      if (ev === EVENT.ERROR) {
        console.error(`[VoiceClient Event] ${ev}:`, data);
      } else {
        console.log(`[VoiceClient Event] ${ev}:`, data);
      }
    }),
  );
  return { attached: true };
}
