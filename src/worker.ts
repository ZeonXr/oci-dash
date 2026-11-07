import { runWorker } from "./server/jobs/worker";
import { safeErrorMessage } from "./server/jobs/store";

const shutdown = new AbortController();
let forcedExit: NodeJS.Timeout | undefined;
function stop() {
  if (shutdown.signal.aborted) return;
  shutdown.abort(new Error("Worker shutdown requested."));
  // A stuck SDK call must not prevent container shutdown forever. Its lease expires,
  // and the next worker reconciles persisted checkpoints before attempting any write.
  forcedExit = setTimeout(() => process.exit(1), 25_000);
  forcedExit.unref();
}
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
runWorker({ signal: shutdown.signal })
  .catch((error) => {
    console.error("Worker stopped:", safeErrorMessage(error));
    process.exitCode = 1;
  })
  .finally(() => {
    if (forcedExit) clearTimeout(forcedExit);
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  });
