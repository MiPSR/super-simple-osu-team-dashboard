/**
 * `bun run dev` — starts collector and web backend together (8.1), forwarding
 * output, and tears both down on Ctrl-C.
 */
export {};

const procs: Bun.Subprocess[] = [];

function spawn(name: string, args: string[]): Bun.Subprocess {
  const proc = Bun.spawn({
    // process.execPath works when `bun` itself is not on PATH.
    cmd: [process.execPath, ...args],
    stdio: ["inherit", "inherit", "inherit"],
  });
  procs.push(proc);
  console.log(`[dev] started ${name} (pid ${proc.pid})`);
  return proc;
}

const web = spawn("web", ["run", "apps/web/src/main.ts"]);
const collector = spawn("collector", ["run", "apps/collector/src/main.ts"]);

const shutdown = () => {
  for (const proc of procs) proc.kill();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

const [webExit] = await Promise.all([web.exited, collector.exited]);
console.log(`[dev] a process exited (web code ${webExit}) — shutting down`);
shutdown();
