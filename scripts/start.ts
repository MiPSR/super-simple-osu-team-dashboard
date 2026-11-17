/**
 * `bun run start` — production entry: the collector and the web backend run as
 * separate processes (8.1), sharing one SQLite file. Paths are resolved
 * relative to this file so the app can run from any working directory (e.g.
 * the nix-packaged `dashboard` wrapper).
 */
export {};

const root = `${import.meta.dir}/..`;

const procs: Bun.Subprocess[] = [];

function spawn(args: string[]): Bun.Subprocess {
  const proc = Bun.spawn({
    // process.execPath is the bun binary running this script — it exists even
    // when `bun` is not on PATH (e.g. the nix-packaged dashboard wrapper).
    cmd: [process.execPath, "run", ...args],
    // Inherit the caller's working directory: ./team.toml and ./data are
    // resolved there, while module imports resolve from the script's own path.
    stdio: ["inherit", "inherit", "inherit"],
  });
  procs.push(proc);
  return proc;
}

const web = spawn([`${root}/apps/web/src/main.ts`, ...process.argv.slice(2)]);
const collector = spawn([`${root}/apps/collector/src/main.ts`, ...process.argv.slice(2)]);

const shutdown = () => {
  for (const proc of procs) proc.kill();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await Promise.all([web.exited, collector.exited]);
shutdown();
