// simple typed EventEmitter
export type Handler<T = any> = (payload: T) => void;

export class EventEmitter {
  private handlers: Map<string, Set<Handler>> = new Map();

  on<T = any>(event: string, h: Handler<T>) {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(h as Handler);
  }
  off<T = any>(event: string, h?: Handler<T>) {
    if (!this.handlers.has(event)) return;
    if (!h) { this.handlers.delete(event); return; }
    this.handlers.get(event)!.delete(h as Handler);
  }
  once<T = any>(event: string, h: Handler<T>) {
    const wrap = (p: T) => {
      this.off(event, wrap);
      h(p);
    };
    this.on(event, wrap);
  }
  emit<T = any>(event: string, payload?: T) {
    const list = this.handlers.get(event);
    if (!list) return;
    // copy to avoid mutation issues
    Array.from(list).forEach((h) => {
      try { h(payload as T); } catch (e) { console.error("Event handler error", e); }
    });
  }
}
