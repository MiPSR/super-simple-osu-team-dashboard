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
  body: string | null;
}

/** Fake osu! backend covering the token endpoint and the api/v2 endpoints used by the collector. */
function makeOsuBackend(handler: (call: Call, state: { token: string }) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const state = { token: "token-1" };
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const call: Call = {
      url,
      method: init?.method ?? "GET",
      auth: (init?.headers as Record<string, string>)?.["Authorization"] ?? null,
      body: (init?.body as string) ?? null,
    };
    calls.push(call);
    return handler(call, state);
  }) as unknown as typeof fetch;
  return { calls, state, fetchFn };
}

function makeClient(fetchFn: typeof fetch, divider = 1): OsuClient {
  const clock = new FakeClock();
  const scheduler = new Scheduler(divider, clock);
  return new OsuClient({
    clientId: "123",
    clientSecret: "secret",
    scheduler,
    clock,
    fetchFn,
  });
}

describe("osu! client OAuth2 (2.2)", () => {
  test("uses the client-credentials grant with public scope", async () => {
    const backend = makeOsuBackend((call) => {
      if (call.url.endsWith("/oauth/token")) {
        expect(call.body).toContain("grant_type=client_credentials");
        expect(call.body).toContain("scope=public");
        expect(call.body).toContain("client_id=123");
        return jsonResponse({ access_token: "abc", token_type: "Bearer", expires_in: 86400 });
      }
      return jsonResponse({ users: [] });
    });
    const client = makeClient(backend.fetchFn);
    const users = await client.getUsers([1]);
    expect(users).toEqual([]);
    expect(backend.calls[0]?.url).toBe("https://osu.ppy.sh/oauth/token");
    expect(backend.calls[1]?.auth).toBe("Bearer abc");
  });

  test("renews the token on 401 and retries (3.6)", async () => {
    let tokenCalls = 0;
    const backend = makeOsuBackend((call, state) => {
      if (call.url.endsWith("/oauth/token")) {
        tokenCalls += 1;
        state.token = `token-${tokenCalls}`;
        return jsonResponse({ access_token: state.token, token_type: "Bearer", expires_in: 86400 });
      }
      // The very first access token is rejected; only a renewed token is accepted.
      if (call.auth === "Bearer token-1") {
        return jsonResponse({ error: "invalid" }, 401);
      }
      return jsonResponse({ users: [{ id: 1, username: "peppy", avatar_url: null, country_code: "AU" }] });
    });
    const client = makeClient(backend.fetchFn);
    const users = await client.getUsers([1]);
    expect(users[0]?.username).toBe("peppy");
    expect(tokenCalls).toBe(2);
    const apiCalls = backend.calls.filter((c) => c.url.includes("/users"));
    expect(apiCalls).toHaveLength(2); // 401 + successful retry
  });

  test("never exposes the client secret in request URLs or errors", async () => {
    const backend = makeOsuBackend((call) => {
      if (call.url.endsWith("/oauth/token")) return jsonResponse({ access_token: "t", expires_in: 10 });
      return jsonResponse({ error: "forbidden" }, 403);
    });
    const client = makeClient(backend.fetchFn);
    await expect(client.getTeam(1)).rejects.toThrow(/403/);
    for (const call of backend.calls) {
      expect(call.url).not.toContain("secret");
    }
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
    const backend = makeOsuBackend((call, state) => {
      if (call.url.endsWith("/oauth/token")) return jsonResponse({ access_token: (state.token = "t"), expires_in: 86400 });
      if (call.url.endsWith("/api/v2/teams/4242")) return jsonResponse(team);
      return jsonResponse({}, 404);
    });
    const client = makeClient(backend.fetchFn);
    const result = await client.getTeam(4242);
    expect(result.short_name).toBe("ROXY");
    expect(result.default_ruleset_id).toBe(3);
    expect(result.members).toHaveLength(1);
  });

  test("GET /scores sends the persisted cursor_string; all rulesets when no ruleset filter (3.2, 3.3)", async () => {
    const backend = makeOsuBackend((call, state) => {
      if (call.url.endsWith("/oauth/token")) return jsonResponse({ access_token: (state.token = "t"), expires_in: 86400 });
      if (call.url.includes("/api/v2/scores")) {
        expect(call.url).not.toContain("ruleset=");
        if (call.url.includes("cursor_string=c1")) {
          return jsonResponse({ scores: [], cursor_string: "c1" }); // unchanged cursor = caught up
        }
        return jsonResponse({ scores: [], cursor_string: "c1" });
      }
      return jsonResponse({}, 404);
    });
    const client = makeClient(backend.fetchFn);
    const page = await client.getScores("c1");
    expect(page.cursor_string).toBe("c1");
    expect(backend.calls.some((c) => c.url.includes("cursor_string=c1"))).toBe(true);
  });

  test("GET /users?ids[]=… requests up to 50 ids per call (3.7)", async () => {
    const backend = makeOsuBackend((call, state) => {
      if (call.url.endsWith("/oauth/token")) return jsonResponse({ access_token: (state.token = "t"), expires_in: 86400 });
      if (call.url.startsWith("https://osu.ppy.sh/api/v2/users?")) {
        const ids = call.url.match(/ids%5B%5D=\d+/g) ?? [];
        return jsonResponse({ users: ids.map((m, i) => ({ id: i + 1, username: `u${i}`, avatar_url: null, country_code: null })) });
      }
      return jsonResponse({}, 404);
    });
    const client = makeClient(backend.fetchFn);
    const users = await client.getUsers([1, 2, 3]);
    expect(users).toHaveLength(3);
    const url = backend.calls.find((c) => c.url.includes("/users?"))?.url ?? "";
    expect((url.match(/ids%5B%5D=/g) ?? []).length).toBe(3);
  });
});
