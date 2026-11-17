import { createApp } from "./server.ts";
import { loadConfig, databasePathFor } from "@osu-team/config";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** Web backend port, fixed by the spec (1.6). */
const PORT = 3000;

export async function main(): Promise<void> {
  const config = await loadConfig();
  const databasePath = databasePathFor(config);
  const publicDir = new URL("../public", import.meta.url).pathname;

  mkdirSync(dirname(databasePath), { recursive: true });

  const { app, events } = createApp({ databasePath, publicDir });

  const server = Bun.serve({
    port: PORT,
    fetch: app.fetch,
  });

  const shutdown = () => {
    events.stop();
    server.stop(true);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  console.log(`[web] serving on http://localhost:${PORT} (db: ${databasePath})`);
}

if (import.meta.main) {
  await main();
}
