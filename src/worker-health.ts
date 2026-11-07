import { getWorkerStatus } from "./server/jobs";
import { closeDatabase } from "./server/db";
try { const status = getWorkerStatus(); closeDatabase(); process.exit(status.online ? 0 : 1); }
catch { closeDatabase(); process.exit(1); }
