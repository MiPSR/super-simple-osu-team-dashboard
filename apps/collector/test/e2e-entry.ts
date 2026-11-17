import { main } from "../src/main.ts";

// Test-only entry for the end-to-end run: routes the collector to the mock
// osu! backend started by e2e.test.ts. Production main() has no such options.
await main({
  apiBase: "http://127.0.0.1:42091/api/v2",
  token: "e2e-token",
});
