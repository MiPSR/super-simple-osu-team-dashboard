/**
 * Sequential osu! API request scheduler (spec 2.3, 3.4, 3.5, 3.6).
 *
 * - One sequential queue; every osu! API request goes through it.
 * - Minimum spacing between request starts: `rate_divider` × 1 s.
 * - Rolling 60-second budget: 60 / rate_divider requests per minute
 *   (osu! wiki: ≤ 60 requests per minute, generally 1 request per second).
 * - Priorities: score-feed requests first when behind; hourly profile and
 *   beatmap-enrichment requests run between feed requests without starving
 *   (a request that has waited ≥ 30 s ages past higher-priority newcomers).
 * - Failures follow the osu! wiki good practices: exponential backoff for
 *   network/5xx/429, honouring `Retry-After`; other 4xx fail immediately.
 */

export type RequestPriority = "feed" | "hourly" | "beatmap";

const PRIORITY_ORDER: Record<RequestPriority, number> = {
  feed: 0,
  hourly: 1,
  beatmap: 2,
};

const AGING_STEP_MS = 30_000;

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** Outcome of a single HTTP attempt, classified by the caller (OsuClient). */
export type AttemptOutcome<T> =
  | { kind: "ok"; value: T }
  /** network / 5xx / 429 — retryable with optional Retry-After. */
  | { kind: "transient"; retryAfterMs?: number; detail?: string }
  /** other 4xx etc. — permanent. */
  | { kind: "permanent"; detail: string };

interface QueueItem<T> {
  priority: RequestPriority;
  enqueuedAt: number;
  notBefore: number;
  attempt: number;
  task: () => Promise<AttemptOutcome<T>>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

export class Scheduler {
  private queue: Array<QueueItem<unknown>> = [];
  private pumping = false;
  private recentStarts: number[] = [];
  private lastStart = Number.NEGATIVE_INFINITY;

  constructor(
    readonly divider: number,
    private readonly clock: Clock = systemClock,
    private readonly onEvent?: (event: SchedulerEvent) => void,
  ) {}

  get spacingMs(): number {
    return this.divider * 1000;
  }

  get requestsPerMinute(): number {
    return Math.floor(60 / this.divider);
  }

  get queueLength(): number {
    return this.queue.length;
  }

  schedule<T>(priority: RequestPriority, task: () => Promise<AttemptOutcome<T>>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const item: QueueItem<T> = {
        priority,
        enqueuedAt: this.clock.now(),
        notBefore: this.clock.now(),
        attempt: 0,
        task,
        resolve,
        reject,
      };
      this.queue.push(item as QueueItem<unknown>);
      void this.pump();
    });
  }

  /** Ready item with the smallest effective priority (aging breaks starvation). */
  private pickReady(now: number): QueueItem<unknown> | null {
    let best: QueueItem<unknown> | null = null;
    let bestKey = Number.POSITIVE_INFINITY;
    for (const item of this.queue) {
      if (item.notBefore > now) continue;
      const waitMs = now - item.enqueuedAt;
      const key = PRIORITY_ORDER[item.priority] - Math.floor(waitMs / AGING_STEP_MS);
      if (key < bestKey) {
        bestKey = key;
        best = item;
      }
    }
    return best;
  }

  private removeItem(item: QueueItem<unknown>): void {
    const index = this.queue.indexOf(item);
    if (index !== -1) this.queue.splice(index, 1);
  }

  /** Enforce minimum spacing and the rolling 60 s budget (2.3, 3.5). */
  private async gate(): Promise<void> {
    for (;;) {
      const now = this.clock.now();
      this.recentStarts = this.recentStarts.filter((t) => now - t < 60_000);
      if (this.recentStarts.length >= this.requestsPerMinute) {
        const oldest = this.recentStarts[0] as number;
        const wait = oldest + 60_000 - now;
        this.onEvent?.({ type: "budget-wait", waitMs: wait });
        await this.clock.sleep(Math.max(wait, 0));
        continue;
      }
      const sinceLast = now - this.lastStart;
      if (sinceLast < this.spacingMs) {
        await this.clock.sleep(this.spacingMs - sinceLast);
        continue;
      }
      return;
    }
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length > 0) {
        const now = this.clock.now();
        const item = this.pickReady(now);
        if (!item) {
          const nextAt = Math.min(...this.queue.map((i) => i.notBefore));
          await this.clock.sleep(Math.max(nextAt - now, 1));
          continue;
        }
        this.removeItem(item);
        await this.gate();
        const startedAt = this.clock.now();
        this.lastStart = startedAt;
        this.recentStarts.push(startedAt);
        this.onEvent?.({ type: "request", priority: item.priority, attempt: item.attempt });

        let outcome: AttemptOutcome<unknown>;
        try {
          outcome = await item.task();
        } catch (err) {
          outcome = { kind: "transient", detail: `network error: ${(err as Error).message}` };
        }

        if (outcome.kind === "ok") {
          item.resolve(outcome.value);
          continue;
        }

        if (outcome.kind === "transient") {
          item.attempt += 1;
          // osu! wiki good practice: exponential backoff, honour Retry-After.
          const backoff =
            outcome.retryAfterMs ??
            Math.min(1_000 * 2 ** item.attempt, 60_000); // 2 s, 4 s … capped at 1 min
          item.notBefore = this.clock.now() + backoff;
          this.queue.push(item);
          this.onEvent?.({ type: "retry", priority: item.priority, attempt: item.attempt, backoffMs: backoff });
          continue;
        }

        item.reject(new Error(outcome.detail));
        this.onEvent?.({ type: "permanent-failure", priority: item.priority, detail: outcome.detail });
      }
    } finally {
      this.pumping = false;
    }
  }
}

export type SchedulerEvent =
  | { type: "request"; priority: RequestPriority; attempt: number }
  | { type: "retry"; priority: RequestPriority; attempt: number; backoffMs: number }
  | { type: "budget-wait"; waitMs: number }
  | { type: "permanent-failure"; priority: RequestPriority; detail?: string };
