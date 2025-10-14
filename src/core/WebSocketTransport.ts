import { EventEmitter } from './EventEmitter';
import { EVENT } from './events';
import type { TransportOptions } from '../types/config';

export class WebSocketTransport extends EventEmitter {
  private socket?: WebSocket;
  private options: TransportOptions & { url: string };
  private shouldReconnect = false;
  private reconnectAttempts = 0;
  private queue: string[] = [];
  private userEnded = false;

  constructor(opts: TransportOptions & { url: string }) {
    super();
    this.options = opts;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
  this.shouldReconnect = true;
  this.userEnded = false;

      // protect against calling connect while OPEN/CONNECTING
      if (
        this.socket &&
        (this.socket.readyState === WebSocket.OPEN ||
          this.socket.readyState === WebSocket.CONNECTING)
      ) {
        //this.emit("open");
        resolve();
        return;
      }

      const tryOpen = () => {
        this.socket = new WebSocket(this.options.url, this.options.protocols);

        this.socket.onopen = () => {
          this.reconnectAttempts = 0;
          this.emit(EVENT.MIC_STREAM_OPEN, {});
          // flush queue
          while (this.queue.length && this.socket && this.socket.readyState === WebSocket.OPEN) {
            const t = this.queue.shift()!;
            try {
              this.socket.send(t);
            } catch (error) {
              this.queue.unshift(t);
              this.emit(EVENT.ERROR, {
                source: 'transport',
                message: 'Failed to send queued message',
                fatal: false,
                error: error instanceof Error ? error.message : String(error)
              });
              break;
            }
          }
          resolve();
        };

        this.socket.onmessage = (ev) => {
          this.emit('mic_stream_message', ev.data);
        };

        this.socket.onclose = (ev) => {
          this.emit(EVENT.MIC_STREAM_CLOSE, { code: ev.code, reason: ev.reason });
          // Only reconnect if NOT user-ended and not code 4011
          const canReconnect =
            this.options.reconnect &&
            this.shouldReconnect &&
            !this.userEnded &&
            ev.code !== 4011;
          const maxReached =
            this.options.maxReconnects !== undefined &&
            this.reconnectAttempts >= this.options.maxReconnects;
          if (canReconnect && !maxReached) {
            this.reconnectAttempts++;
            this.emit(EVENT.RECONNECTING, { count: this.reconnectAttempts });
            setTimeout(tryOpen, this.options.reconnectInterval);
          } else if (canReconnect && maxReached) {
            this.emit(EVENT.STOP_RECONNECTING, { count: this.reconnectAttempts });
          }
        };

        this.socket.onerror = (err) => {
          const errorDetails = {
            source: 'transport',
            message: `WebSocket error connecting to ${this.options.url}`,
            fatal: !this.options.reconnect,
            cause: err,
            readyState: this.socket?.readyState,
            protocol: new URL(this.options.url).protocol
          };
          //console.error('[WebSocketTransport] Connection error:', errorDetails);
          this.emit(EVENT.ERROR, errorDetails);
          reject(err);
        };
      };

      tryOpen();
    });
  }

  disconnect() {
    this.shouldReconnect = false;
    this.userEnded = true;
    if (!this.socket) return;
    if (
      this.socket.readyState === WebSocket.OPEN ||
      this.socket.readyState === WebSocket.CONNECTING
    ) {
      try {
        this.socket.close();
      } catch (error) {
        this.emit(EVENT.ERROR, {
          source: 'transport',
          message: 'Failed to close WebSocket connection',
          fatal: false,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
    this.socket = undefined;
  }

  /**
   * Immediately abort the connection attempt or close existing connection
   * This is different from disconnect() as it:
   * 1. Won't try to send a clean close frame
   * 2. Emits an 'aborted' event instead of normal close
   */
  abort() {
    this.shouldReconnect = false;
    this.userEnded = true;
    if (!this.socket) return;

    // Clear the queue since we're aborting
    this.queue = [];

    if (
      this.socket.readyState === WebSocket.CONNECTING ||
      this.socket.readyState === WebSocket.OPEN
    ) {
      try {
        // Force immediate termination
        this.socket.onclose = () => {
          this.emit(EVENT.MIC_STREAM_CLOSE, { code: 1006, reason: 'Connection aborted' });
        };
        this.socket.close();
      } catch (error) {
        this.emit(EVENT.ERROR, {
          source: 'transport',
          message: 'Failed to abort WebSocket connection',
          fatal: true,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
    this.socket = undefined;
  }

  sendRaw(text: string) {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(text);
    } else {
      // queue until open
      this.queue.push(text);
    }
  }

  /*sendMark(mark: string) {
    const msg = JSON.stringify({ event: 'mark', data: mark });
    this.sendRaw(msg);

    // event for control/marks
    this.emit(EVENT.MARK_SENT, { mark });
  }*/
}
