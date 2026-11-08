import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [role, mode, directory, requestedExit = "0", delay = "20"] = process.argv.slice(2);
if (!role || !mode || !directory)
  throw new Error("Runtime fixture requires role, mode and directory.");
let stopping = false;
function stop(signal: "SIGTERM" | "SIGINT"): void {
  writeFileSync(join(directory, `${role}.signal`), signal);
  if (mode === "ignore" || stopping) return;
  stopping = true;
  setTimeout(() => process.exit(Number(requestedExit)), Number(delay));
}
process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));
writeFileSync(
  join(directory, `${role}.ready`),
  JSON.stringify({
    pid: process.pid,
    cwd: process.cwd(),
    marker: process.env.RUNTIME_FIXTURE_MARKER,
  }),
);
setInterval(() => {
  if (mode === "exit" && existsSync(join(directory, `${role}.exit`)))
    process.exit(Number(requestedExit));
}, 10);
