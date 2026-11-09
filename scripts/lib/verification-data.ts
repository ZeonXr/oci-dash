import { existsSync } from "node:fs";
import type { RunProcessOptions } from "./process.ts";

/** Empty only a fresh verification bind directory after its app has stopped. */
export async function clearVerificationData(
  docker: (args: string[], options?: RunProcessOptions) => Promise<string>,
  image: string,
  directory: string,
): Promise<void> {
  if (!existsSync(directory)) return;
  // Docker-created data belongs to root on Linux; the test host may be a normal
  // user. Remove its contents through the same image, then let the host remove
  // the empty directory with the rest of the verification's temporary files.
  await docker(
    [
      "run",
      "--rm",
      "--network",
      "none",
      "--read-only",
      "--volume",
      `${directory}:/data`,
      "--entrypoint",
      "node",
      image,
      "-e",
      "const f=require('node:fs'),p=require('node:path');for(const name of f.readdirSync('/data'))f.rmSync(p.join('/data',name),{recursive:true,force:true});",
    ],
    { signal: undefined, timeoutMs: 30_000 },
  );
}
