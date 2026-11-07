import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    environment: "node",
    pool: "threads",
    include: ["tests/**/*.test.ts"],
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 15000,
  },
});
