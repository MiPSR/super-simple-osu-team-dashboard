import { describe, test, expect } from "bun:test";
import { Scheduler } from "../src/index.ts";
import { OsuClient } from "../src/index.ts";

class FakeClock {
  t = 0;
  now(): number {
    return this.t;
  }
  async sleep(ms: number): Promise<void> {
    this.t += ms;
  }
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

interface Call {
  url: string;
  method: string;
  auth: string | null;
}

/** Fake osu! backend covering the api/v2 endpoints used by the collector. */
function makeOsuBackend(handler: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const call: Call = {
      url,
      method: init?.method ?? "GET",
      auth: (init?.headers as Record<string, string>)?.["Authorization"] ?? null,
    };
    calls.push(call);
    return handler(call);
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}

function makeClient(fetchFn: typeof fetch, token?: string, divider = 1): OsuClient {
  const clock = new FakeClock();
  const scheduler = new Scheduler(divider, clock);
  return new OsuClient({
    scheduler,
    clock,
    fetchFn,
    token,
  });
}

describe("osu! client authentication", () => {
  test("sends the configured token as Bearer on every API request", async () => {
    const backend = makeOsuBackend((call) => {
      if (call.auth !== "Bearer tok-42") {
        return jsonResponse({ error: "unauthorized" }, 401);
      }
      return jsonResponse({ users: [] });
    });
    const client = makeClient(backend.fetchFn, "tok-42");
    const users = await client.getUsers([1]);
    expect(users).toEqual([]);
    for (const call of backend.calls) {
      expect(call.auth).toBe("Bearer tok-42");
      expect(call.url.startsWith("https://osu.ppy.sh/api/v2/")).toBe(true);
    }
  });

  test("401 is a permanent failure — no retry, no renewal", async () => {
    const backend = makeOsuBackend(() => jsonResponse({ error: "unauthorized" }, 401));
    const client = makeClient(backend.fetchFn, "tok-42");
    await expect(client.getTeam(1)).rejects.toThrow(/401/);
    expect(backend.calls).toHaveLength(1);
  });

  test("5xx and 429 go through scheduler backoff and succeed", async () => {
    let calls = 0;
    const backend = makeOsuBackend(() => {
      calls += 1;
      if (calls < 3) return jsonResponse({ error: "boom" }, 503);
      return jsonResponse({ users: [{ id: 1, username: "peppy", avatar_url: null, country_code: "AU" }] });
    });
    const client = makeClient(backend.fetchFn, "tok-42");
    const users = await client.getUsers([1]);
    expect(users[0]?.username).toBe("peppy");
    expect(calls).toBe(3);
  });

  test("no credentials are ever sent to token endpoints — none are contacted", async () => {
    const backend = makeOsuBackend(() => jsonResponse({ users: [] }));
    const client = makeClient(backend.fetchFn, "tok-42");
    await client.getUsers([1]);
    expect(backend.calls.every((c) => !c.url.includes("/oauth/token"))).toBe(true);
    expect(backend.calls.every((c) => c.method === "GET")).toBe(true);
  });
});

describe("osu! endpoint shapes (osu! api wiki)", () => {
  test("GET /teams/{id} returns TeamExtended", async () => {
    const team = {
      id: 4242,
      name: "roxy fanclub",
      short_name: "ROXY",
      flag_url: "https://assets.ppy.sh/teams/flag.png",
      cover_url: null,
      default_ruleset_id: 3,
      leader: { id: 1, username: "leader", avatar_url: null, country_code: "AU" },
      members: [{ id: 2, username: "member", avatar_url: null, country_code: "DE" }],
    };
    const backend = makeOsuBackend((call) => {
      if (call.url.endsWith("/api/v2/teams/4242")) return jsonResponse(team);
      return jsonResponse({}, 404);
    });
    const client = makeClient(backend.fetchFn, "t");
    const result = await client.getTeam(4242);
    expect(result.short_name).toBe("ROXY");
    expect(result.default_ruleset_id).toBe(3);
    expect(result.members).toHaveLength(1);
  });

  test("GET /scores sends the persisted cursor_string; all rulesets when no ruleset filter (3.2, 3.3)", async () => {
    const backend = makeOsuBackend((call) => {
      if (call.url.includes("/api/v2/scores")) {
        expect(call.url).not.toContain("ruleset=");
        return jsonResponse({ scores: [], cursor_string: "c1" });
      }
      return jsonResponse({}, 404);
    });
    const client = makeClient(backend.fetchFn, "t");
    const page = await client.getScores("c1");
    expect(page.cursor_string).toBe("c1");
    expect(backend.calls.some((c) => c.url.includes("cursor_string=c1"))).toBe(true);
  });

  test("GET /users?ids[]=… requests up to 50 ids per call (3.7)", async () => {
    const backend = makeOsuBackend((call) => {
      if (call.url.startsWith("https://osu.ppy.sh/api/v2/users?")) {
        const ids = call.url.match(/ids%5B%5D=\d+/g) ?? [];
        return jsonResponse({ users: ids.map((m, i) => ({ id: i + 1, username: `u${i}`, avatar_url: null, country_code: null })) });
      }
      return jsonResponse({}, 404);
    });
    const client = makeClient(backend.fetchFn, "t");
    const users = await client.getUsers([1, 2, 3]);
    expect(users).toHaveLength(3);
    const url = backend.calls.find((c) => c.url.includes("/users?"))?.url ?? "";
    expect((url.match(/ids%5B%5D=/g) ?? []).length).toBe(3);
  });
});
