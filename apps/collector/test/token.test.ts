import { describe, test, expect } from "bun:test";
import { RefreshTokenManager, TokenDeadError } from "../src/index.ts";
import type { Clock } from "../src/index.ts";

class FakeClock implements Clock {
  t = 0;
  now(): number {
    return this.t;
  }
  async sleep(ms: number): Promise<void> {
    this.t += ms;
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

interface TokenCall {
  body: URLSearchParams;
}

function makeBackend(respond: (call: TokenCall, count: number) => Response | Promise<Response>) {
  const calls: TokenCall[] = [];
  const fetchFn = (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = new URLSearchParams((init?.body as string) ?? "");
    calls.push({ body });
    return respond({ body }, calls.length);
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}

function makeManager(
  fetchFn: typeof fetch,
  hooks: { onRotate?: (t: string) => void; onDead?: (r: string) => void } = {},
): RefreshTokenManager {
  return new RefreshTokenManager({
    clientId: "1",
    clientSecret: "secret",
    refreshToken: "rt-1",
    tokenUrl: "https://token.test/oauth/token",
    fetchFn,
    clock: new FakeClock(),
    onRotate: hooks.onRotate ?? (() => {}),
    onDead: hooks.onDead ?? (() => {}),
  });
}

describe("refresh token manager (2.2)", () => {
  test("exchanges the stored refresh token for an access token", async () => {
    const backend = makeBackend(() => jsonResponse({ access_token: "at-1", expires_in: 86400, refresh_token: "rt-2" }));
    const manager = makeManager(backend.fetchFn);
    expect(await manager.getAccessToken()).toBe("at-1");
    const body = (backend.calls[0] as TokenCall).body;
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("rt-1");
    expect(body.get("client_id")).toBe("1");
  });

  test("caches the access token until it nears expiry", async () => {
    const backend = makeBackend(() => jsonResponse({ access_token: "at-1", expires_in: 86400, refresh_token: "rt-2" }));
    const manager = makeManager(backend.fetchFn);
    await manager.getAccessToken();
    await manager.getAccessToken();
    await manager.getAccessToken(false);
    expect(backend.calls).toHaveLength(1);
  });

  test("persists the rotated refresh token returned by osu!", async () => {
    const rotated: string[] = [];
    const backend = makeBackend(() => jsonResponse({ access_token: "at-1", expires_in: 86400, refresh_token: "rt-2" }));
    const manager = makeManager(backend.fetchFn, { onRotate: (t) => rotated.push(t) });
    await manager.getAccessToken();
    expect(rotated).toEqual(["rt-2"]);
  });

  test("a rejected token is dead: onDead fires and the error propagates", async () => {
    const dead: string[] = [];
    const backend = makeBackend(() => jsonResponse({ error: "invalid_grant" }, 400));
    const manager = makeManager(backend.fetchFn, { onDead: (r) => dead.push(r) });
    await expect(manager.getAccessToken()).rejects.toThrow(TokenDeadError);
    expect(dead).toHaveLength(1);
    expect(dead[0]).toContain("data/config.toml");
    expect(manager.isDead).toBe(true);
  });

  test("transient failures back off exponentially and succeed", async () => {
    const clock = new FakeClock();
    let calls = 0;
    const backend = makeBackend(() => {
      calls += 1;
      if (calls < 3) return jsonResponse({ error: "boom" }, 503);
      return jsonResponse({ access_token: "at-1", expires_in: 86400, refresh_token: "rt-1" });
    });
    const manager = new RefreshTokenManager({
      clientId: "1",
      clientSecret: "s",
      refreshToken: "rt-1",
      tokenUrl: "https://token.test/oauth/token",
      fetchFn: backend.fetchFn,
      clock,
      onRotate: () => {},
      onDead: () => {},
    });
    expect(await manager.getAccessToken()).toBe("at-1");
    expect(calls).toBe(3);
    // Two backoff sleeps: 2 s + 4 s.
    expect(clock.t).toBe(6_000);
  });

  test("no acquisition flow: nothing is sent before a refresh is needed", async () => {
    const backend = makeBackend(() => jsonResponse({ access_token: "at-1", expires_in: 86400 }));
    const manager = makeManager(backend.fetchFn);
    expect(backend.calls).toHaveLength(0);
    await manager.getAccessToken();
    const grant = backend.calls[0]?.body.get("grant_type");
    expect(grant).toBe("refresh_token");
  });
});
