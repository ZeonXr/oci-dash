import { checkRestoredData } from "./server/runtime/check-data";

try {
  console.log(JSON.stringify({ ok: true, ...checkRestoredData() }));
  console.log(
    "Offline verification passed. Before starting the application, review pending tasks and console sessions against OCI; startup can resume tasks and clean up sessions.",
  );
} catch {
  console.error(
    "Offline verification failed. Check database integrity, the original .master-key, its database binding, and encrypted credentials. No initialization or cloud operation was performed.",
  );
  process.exitCode = 1;
}
