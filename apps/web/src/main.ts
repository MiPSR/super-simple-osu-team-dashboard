import { createApp } from "./server.ts";
import { resolveConfigPath, loadConfig } from "@osu-team/config";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export async function main(argv: string[], env: Record<string, string | undefined>): Promise<void> {
  const configPath = resolveConfigPath(argv, env);
  const config = await loadConfig(configPath);
  const publicDir = new URL("../public", import.meta.url).pathname;

  mkdirSync(dirname(config.databasePath), { recursive: true });

  const { app, events } = createApp({
    databasePath: config.databasePath,
    port: config.port,
    publicDir,
  });

  const server = Bun.serve({
    port: config.port,
    fetch: app.fetch,
  });

  const shutdown = () => {
    events.stop();
    server.stop(true);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  console.log(`[web] serving on http://localhost:${config.port} (db: ${config.databasePath})`);
}

if (import.meta.main) {
  await main(Bun.argv.slice(2), process.env as Record<string, string | undefined>);
}
