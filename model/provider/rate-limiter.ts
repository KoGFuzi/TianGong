const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1_000;
const MAX_CONCURRENT = 5;

export class RateLimiter {
  private activeCount = 0;
  private queue: Array<() => void> = [];

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await this.retryWithBackoff(fn);
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    if (this.activeCount < MAX_CONCURRENT) {
      this.activeCount++;
      return;
    }
    return new Promise<void>(resolve => {
      this.queue.push(resolve);
    });
  }

  private release(): void {
    this.activeCount--;
    const next = this.queue.shift();
    if (next != null) {
      this.activeCount++;
      next();
    }
  }

  private async retryWithBackoff<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < MAX_RETRIES) {
          const delay = Math.min(BASE_DELAY_MS * Math.pow(2, attempt), 30_000);
          const jitter = delay * 0.1 * Math.random();
          await new Promise(resolve => setTimeout(resolve, delay + jitter));
        }
      }
    }
    throw lastError ?? new Error('Rate limiter: unknown error');
  }
}

export const rateLimiter = new RateLimiter();
