import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createOpenSshFactory } from "@/server/console/ssh";

it.skipIf(process.platform !== "win32")(
  "native Windows rejects the default VNC runner before creating session files",
  async () => {
    const base = join(process.cwd(), ".test-tmp");
    await mkdir(base, { recursive: true });
    const root = await mkdtemp(join(base, "console-platform-"));
    try {
      const factory = createOpenSshFactory({ tempRoot: root });
      await expect(
        factory({
          sessionId: "22222222-2222-4222-8222-222222222222",
          signal: new AbortController().signal,
        }),
      ).rejects.toMatchObject({
        name: "CloudError",
        code: "CONSOLE_PLATFORM_UNSUPPORTED",
        message: "Windows 原生 Node.js 不支持 VNC 控制台，请使用 Linux 容器运行此功能。",
      });
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
