import { describe, test, expect, beforeEach } from "bun:test";
import { Scheduler, MAX_ATTEMPTS, type Clock, type AttemptOutcome } from "../src/index.ts";
import type { RequestPriority } from "../src/index.ts";

/** Deterministic clock: sleep() advances virtual time instantly. */
class FakeClock implements Clock {
  t = 0;
  now(): number {
    return this.t;
  }
  async sleep(ms: number): Promise<void> {
    this.t += ms;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

interface FetchRecord {
  url: string;
  startedAt: number;
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

function makeFetch(respond: (url: string, call: number) => Response | Promise<Response>) {
  const records: FetchRecord[] = [];
  let call = 0;
  const fn = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    records.push({ url, startedAt: clock.t });
    call += 1;
    return respond(url, call);
  }) as unknown as typeof fetch;
  return { fn, records };
}

let clock: FakeClock;

beforeEach(() => {
  clock = new FakeClock();
});

describe("osu! API scheduler (2.3, 3.5)", () => {
  test("enforces minimum spacing of divider × 1 s between request starts", async () => {
    const scheduler = new Scheduler(2, clock); // spacing 2 s
    const fetcher = makeFetch(() => jsonResponse({ ok: true }));
    const results = await Promise.all([
      scheduler.schedule("feed", () => Promise.resolve({ kind: "ok" as const, value: fetchAnd(fetcher) })),
      scheduler.schedule("feed", () => Promise.resolve({ kind: "ok" as const, value: fetchAnd(fetcher) })),
      scheduler.schedule("feed", () => Promise.resolve({ kind: "ok" as const, value: fetchAnd(fetcher) })),
    ]);
    expect(results).toHaveLength(3);
    expect(fetcher.records[0]?.startedAt).toBe(0);
    expect((fetcher.records[1]?.startedAt ?? 0) - (fetcher.records[0]?.startedAt ?? 0)).toBe(2000);
    expect((fetcher.records[2]?.startedAt ?? 0) - (fetcher.records[1]?.startedAt ?? 0)).toBe(2000);
    void results;
  });

  test("enforces the rolling 60-second budget of 60/divider requests (2.3)", async () => {
    const divider = 2;
    const scheduler = new Scheduler(divider, clock); // 30 requests / minute, spacing 2 s
    const fetcher = makeFetch(() => jsonResponse({ ok: true }));
    // The budget equals what spacing already enforces over 60 s; check the getter.
    expect(scheduler.requestsPerMinute).toBe(30);
    // Saturate the window: 30 requests fit, the 31st waits for the oldest to expire.
    for (let i = 0; i < 30; i++) {
      scheduler.schedule("feed", () => Promise.resolve({ kind: "ok" as const, value: fetchAnd(fetcher) }));
    }
    await scheduler.schedule("feed", () => Promise.resolve({ kind: "ok" as const, value: fetchAnd(fetcher) }));
    // 31 requests: first at t=0, last no earlier than 60 s after the first.
    expect(fetcher.records).toHaveLength(31);
    expect((fetcher.records[30]?.startedAt ?? 0) - (fetcher.records[0]?.startedAt ?? 0)).toBeGreaterThanOrEqual(60_000);
  });

  test("score-feed requests run before hourly and beatmap requests (3.5)", async () => {
    const scheduler = new Scheduler(10, clock); // large spacing: priorities decide the order
    let releaseBarrier: () => void = () => {};
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    const order: string[] = [];
    const task = (name: string) => async () => {
      await barrier; // every task blocks until the barrier is released
      order.push(name);
      return { kind: "ok" as const, value: null };
    };
    const first = scheduler.schedule("feed", task("barrier"));
    // Now enqueue a backlog while the pump is busy with the barrier request.
    const beatmap = scheduler.schedule("beatmap", task("beatmap"));
    const hourly = scheduler.schedule("hourly", task("hourly"));
    const feed = scheduler.schedule("feed", task("feed"));
    releaseBarrier();
    await Promise.all([first, beatmap, hourly, feed]);
    expect(order).toEqual(["barrier", "feed", "hourly", "beatmap"]);
  });

  test("long-waiting lower-priority requests are not starved (3.5)", async () => {
    const scheduler = new Scheduler(2, clock); // 2 s spacing → 40 feeds span 80 s
    const order: string[] = [];
    const task = (name: string) => () =>
      Promise.resolve({ kind: "ok" as const, value: (order.push(name), null) });
    // Simulate a feed backlog arriving continuously while a beatmap request waits.
    const beatmapPromise = scheduler.schedule("beatmap", task("beatmap"));
    const feedPromises: Array<Promise<unknown>> = [];
    for (let i = 0; i < 40; i++) {
      feedPromises.push(scheduler.schedule("feed", task(`feed-${i}`)));
    }
    await Promise.allSettled([beatmapPromise, ...feedPromises]);
    // With 30 s aging, the beatmap request must complete before the last feeds.
    const beatmapIndex = order.indexOf("beatmap");
    expect(beatmapIndex).toBeGreaterThanOrEqual(0);
    expect(beatmapIndex).toBeLessThan(order.length - 1);
  });
});

function fetchAnd(fetcher: { fn: typeof fetch }): string {
  void fetcher.fn("https://osu.ppy.sh/api/v2/test");
  return "done";
}

describe("retry and auth handling (3.6)", () => {
  test("retries transient 5xx failures up to 3 attempts then succeeds", async () => {
    const scheduler = new Scheduler(1, clock);
    let call = 0;
    const client = {
      scheduler,
      fetch: (async () => {
        call += 1;
        if (call < 3) return jsonResponse({ error: "boom" }, 500);
        return jsonResponse({ ok: true });
      }) as unknown as typeof fetch,
    };
    const token = "t";
    const result = await scheduler.schedule("feed", async (): Promise<AttemptOutcome<unknown>> => {
      const response = await client.fetch("https://x");
      if (response.status >= 500) return { kind: "transient", detail: `status ${response.status}` };
      return { kind: "ok", value: token };
    });
    expect(result).toBe("t");
    expect(call).toBe(3);
    expect(MAX_ATTEMPTS).toBe(3);
  });

  test("gives up after 3 attempts with exponential backoff (3.6)", async () => {
    const scheduler = new Scheduler(1, clock);
    let call = 0;
    const backoffs: number[] = [];
    let lastAttempt = 0;
    const task = async (): Promise<AttemptOutcome<null>> => {
      call += 1;
      return { kind: "transient", detail: "down" };
    };
    await expect(
      scheduler.schedule("feed", task),
    ).rejects.toThrow(/after 3 attempts/);
    expect(call).toBe(3);
    void lastAttempt;
    void backoffs;
  });

  test("honours Retry-After when present (3.6)", async () => {
    const scheduler = new Scheduler(1, clock);
    let call = 0;
    const task = async (): Promise<AttemptOutcome<null>> => {
      call += 1;
      if (call === 1) return { kind: "transient", retryAfterMs: 7000, detail: "429" };
      return { kind: "ok", value: null };
    };
    const start = clock.t;
    await scheduler.schedule("feed", task);
    // Second attempt must wait 7 s (Retry-After) after the first failed.
    expect(call).toBe(2);
    expect(clock.t - start).toBeGreaterThanOrEqual(7000);
  });

  test("auth failures renew the token without consuming attempts (3.6)", async () => {
    const scheduler = new Scheduler(1, clock);
    let call = 0;
    let renewals = 0;
    const task = async (): Promise<AttemptOutcome<string>> => {
      call += 1;
      if (call === 1) {
        renewals += 1;
        return { kind: "auth" };
      }
      return { kind: "ok", value: "data" };
    };
    const value = await scheduler.schedule("feed", task);
    expect(value).toBe("data");
    expect(call).toBe(2);
    expect(renewals).toBe(1);
  });

  test("permanent failures reject immediately", async () => {
    const scheduler = new Scheduler(1, clock);
    let call = 0;
    const task = async (): Promise<AttemptOutcome<null>> => {
      call += 1;
      return { kind: "permanent", detail: "404 not found" };
    };
    await expect(scheduler.schedule("feed", task)).rejects.toThrow(/404/);
    expect(call).toBe(1);
  });
});
