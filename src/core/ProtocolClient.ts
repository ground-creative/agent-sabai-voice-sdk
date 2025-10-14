import { EventEmitter } from './EventEmitter';
import { WebSocketTransport } from './WebSocketTransport';
import type { TransportOptions } from '../types/config';
import { DEFAULT_TRANSPORT_OPTIONS } from '../types/config';
import { EVENT } from './events';

export class ProtocolClient extends EventEmitter {
  private transport: WebSocketTransport;

  constructor(opts: TransportOptions & { url: string }) {
    super();
    // Merge defaults with user-provided options
    const mergedOpts: any = { ...DEFAULT_TRANSPORT_OPTIONS, ...opts };
    this.transport = new WebSocketTransport(mergedOpts);

    // wire transport -> protocol
    this.transport.on(EVENT.MIC_STREAM_OPEN, (d) => this.emit(EVENT.MIC_STREAM_OPEN, d));
    this.transport.on(EVENT.MIC_STREAM_CLOSE, (d) => this.emit(EVENT.MIC_STREAM_CLOSE, d));
    this.transport.on(EVENT.ERROR, (e) => this.emit(EVENT.ERROR, e));
    this.transport.on('mic_stream_message', (raw: string) => {
      try {
        const obj = JSON.parse(raw);
        const ev = obj.event ?? 'message';
        // The payload is everything other than 'event'
        const { event, ...payload } = obj;
        // Normalize protocol event names to app events
        if (ev === 'mark') this.emit(EVENT.MARK_RECEIVED, payload);
        else if (ev === 'media') this.emit(EVENT.MEDIA_RECEIVED, payload);
        else if (ev === 'clear') this.emit(EVENT.INTERRUPT, payload);
        else this.emit(ev, payload);
      } catch (err) {
        this.emit(EVENT.ERROR, {
          source: 'protocol',
          message: 'Failed to parse incoming frame as JSON',
          fatal: false,
          cause: err,
        });
      }
    });
  }

  connect() {
    return this.transport.connect();
  }

  disconnect() {
    this.transport.disconnect();
  }

  abort() {
    this.transport.abort();
  }

  send(event: string, data?: any) {
    const msg: any = { event };
    if (data !== undefined && data !== null && typeof data === 'object' && !Array.isArray(data)) {
      Object.assign(msg, data);
    } else if (data !== undefined) {
      msg.data = data;
    }
    this.transport.sendRaw(JSON.stringify(msg));
  }

  /** Dedicated mic audio streaming */
  sendMicStream(chunk: ArrayBuffer) {
    const base64 = btoa(String.fromCharCode(...new Uint8Array(chunk)));
    const msg = JSON.stringify({ event: 'audio_chunk', data: base64 });
    this.transport.sendRaw(msg);
    //this.emit('mic_chunk_sent', { size: chunk.byteLength });
  }
}
