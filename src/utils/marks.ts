export function isInterruptMark(name: string): boolean {
  return typeof name === 'string' && name.startsWith('clear_mark_');
}

export type PendingMark = { name: string; queueEndAtMs: number };

export class MarkQueue {
  private queue: PendingMark[] = [];
  private version = 0;

  push(item: PendingMark) {
    this.queue.push(item);
  }

  clearAndBump() {
    this.queue = [];
    this.version++;
  }

  // Drains marks sequentially; awaits provided waitUntil for each
  async flush(waitUntil: (ms: number) => Promise<void> | void, sendMark: (name: string) => void) {
    if (!this.queue.length) return;
    const v = this.version;
    while (this.queue.length) {
      if (v !== this.version) break;
      const next = this.queue[0];
      try {
        await waitUntil(next.queueEndAtMs);
      } catch {}
      if (v !== this.version) break;
      sendMark(next.name);
      this.queue.shift();
    }
  }
}
