import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const [directory, mode] = process.argv.slice(2);
const entry = process.argv[1];
if (!directory || !mode || !entry)
  throw new Error("Deployment fixture requires directory and mode.");
if (mode === "tree") {
  spawn(process.execPath, [entry, directory, "descendant"], { stdio: "inherit" });
}
process.on("SIGTERM", () => {
  if (mode === "ignore") return;
  setTimeout(() => process.exit(0), 150);
});
writeFileSync(join(directory, `${mode}.pid`), String(process.pid));
setInterval(() => {}, 1000);
