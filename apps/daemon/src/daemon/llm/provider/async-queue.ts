export class AsyncQueue<T> {
  private queue: T[] = [];
  private waiting: ((value: IteratorResult<T, void>) => void) | null = null;
  private done = false;

  push(item: T): void {
    if (this.done) {
      return;
    }
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value: item, done: false });
      return;
    }
    this.queue.push(item);
  }

  finish(): void {
    this.done = true;
    if (!this.waiting) {
      return;
    }
    const resolve = this.waiting;
    this.waiting = null;
    resolve({ value: undefined, done: true });
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    while (true) {
      const next = this.queue.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.done) {
        return;
      }
      const result = await new Promise<IteratorResult<T, void>>((resolve) => {
        this.waiting = resolve;
      });
      if (result.done) {
        return;
      }
      yield result.value;
    }
  }
}
