export type ScheduleResult =
  | { scheduled: true; count: number; delayMs: number }
  | { scheduled: false; reason: string };

const BACKOFF_DELAYS = [1000, 2000, 5000];

export class ExponentialBackoff {
  private timestamps: number[] = [];
  private timer: NodeJS.Timeout | null = null;
  private readonly windowMs: number;
  private readonly maxAttempts: number;

  constructor(windowMs: number, maxAttempts: number) {
    this.windowMs = windowMs;
    this.maxAttempts = maxAttempts;
  }

  schedule(callback: () => void): ScheduleResult {
    const now = Date.now();
    this.timestamps = this.timestamps.filter((t) => now - t < this.windowMs);

    if (this.timestamps.length >= this.maxAttempts) {
      return {
        scheduled: false,
        reason: `max attempts (${this.maxAttempts}) in ${this.windowMs / 1000}s reached`,
      };
    }

    this.timestamps.push(now);
    const count = this.timestamps.length;
    const delayMs = BACKOFF_DELAYS[Math.min(count - 1, BACKOFF_DELAYS.length - 1)];

    this.timer = setTimeout(() => {
      this.timer = null;
      callback();
    }, delayMs);

    return { scheduled: true, count, delayMs };
  }

  reset(): void {
    this.timestamps = [];
  }

  cancel(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
