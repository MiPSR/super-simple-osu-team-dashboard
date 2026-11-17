import type { Clock } from "./scheduler.ts";
import { systemClock } from "./scheduler.ts";
import type { FetchLike, Logger } from "./osu.ts";

/**
 * osu! token handling (spec 2.2): the operator stores a refresh token in
 * `data/config.toml`; this manager exchanges it (`grant_type=refresh_token`)
 * for an access token kept in memory and persists the rotated refresh token
 * osu! returns on every refresh. There is no acquisition flow here.
 *
 * - Refresh rejected (400/401/403): the stored token is dead — the process
 *   exits via `onDead`. Replace the value in the configuration file.
 * - Transient failures (network/5xx/429): retried with exponential backoff
 *   per the osu! wiki good practices (2 s, 4 s … capped at 60 s).
 */

export const DEFAULT_TOKEN_URL = "https://osu.ppy.sh/oauth/token";

export class TokenDeadError extends Error {}

export interface RefreshTokenManagerOptions {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  /** Test-only override for mock backends. */
  tokenUrl?: string;
  fetchFn?: FetchLike;
  clock?: Clock;
  /** Persist the rotated refresh token (write-back to the configuration file). */
  onRotate: (refreshToken: string) => void | Promise<void>;
  /** The stored token was rejected — the process must exit. */
  onDead: (reason: string) => void;
  logger?: Logger;
}

interface TokenResponseJson {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
}

export class RefreshTokenManager {
  private accessToken: string | null = null;
  private expiresAtMs = 0;
  private refreshToken: string;
  private refreshing: Promise<string> | null = null;
  private dead = false;

  private readonly fetchFn: FetchLike;
  private readonly clock: Clock;

  constructor(private readonly options: RefreshTokenManagerOptions) {
    this.refreshToken = options.refreshToken;
    this.fetchFn = options.fetchFn ?? fetch;
    this.clock = options.clock ?? systemClock;
  }

  get isDead(): boolean {
    return this.dead;
  }

  /** Access token, refreshed proactively before expiry; `force` after a 401. */
  async getAccessToken(force = false): Promise<string> {
    if (!force && this.accessToken && this.clock.now() < this.expiresAtMs) {
      return this.accessToken;
    }
    if (!this.refreshing) {
      this.refreshing = this.refresh().finally(() => {
        this.refreshing = null;
      });
    }
    return this.refreshing;
  }

  private async refresh(): Promise<string> {
    const tokenUrl = this.options.tokenUrl ?? DEFAULT_TOKEN_URL;
    for (let attempt = 0; ; attempt++) {
      let response: Response | null = null;
      let networkError: string | null = null;
      try {
        const body = new URLSearchParams({
          client_id: this.options.clientId,
          client_secret: this.options.clientSecret,
          grant_type: "refresh_token",
          refresh_token: this.refreshToken,
        });
        response = await this.fetchFn(tokenUrl, {
          method: "POST",
          headers: { "Accept": "application/json", "Content-Type": "application/x-www-form-urlencoded" },
          body: body.toString(),
        });
      } catch (err) {
        networkError = (err as Error).message;
      }

      if (response && response.ok) {
        const json = (await response.json()) as TokenResponseJson;
        this.accessToken = json.access_token;
        this.expiresAtMs = this.clock.now() + json.expires_in * 1000 - 60_000; // renew 1 min early
        if (json.refresh_token && json.refresh_token !== this.refreshToken) {
          this.refreshToken = json.refresh_token;
          await this.options.onRotate(this.refreshToken);
          this.options.logger?.info("refresh token rotated; configuration file updated");
        }
        return this.accessToken;
      }

      if (response && (response.status === 400 || response.status === 401 || response.status === 403)) {
        this.dead = true;
        const reason = `stored refresh token rejected (HTTP ${response.status}) — replace refresh_token in data/config.toml`;
        this.options.onDead(reason);
        throw new TokenDeadError(reason);
      }

      const detail = networkError ?? `${tokenUrl} returned ${response?.status}`;
      const backoff = Math.min(1_000 * 2 ** (attempt + 1), 60_000); // 2 s, 4 s … 60 s
      this.options.logger?.warn(`token refresh failed (${detail}); retrying in ${backoff / 1000} s`);
      await this.clock.sleep(backoff);
    }
  }
}
