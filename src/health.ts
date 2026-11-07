import { checkRuntimeHealth } from "./server/runtime/health";

process.exitCode = (await checkRuntimeHealth()) ? 0 : 1;
