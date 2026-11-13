import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  promoteRelease,
  publishRelease,
  type LatestVersion,
  type PublishedRelease,
  type ReleaseInput,
  type ReleasePort,
} from "../scripts/release.ts";
import { checkDocumentation, documentationOnly } from "../scripts/check-docs.ts";

const input: ReleaseInput = {
  image: "ghcr.io/example/oci-dash",
  tag: "v0.3.0",
  digest: `sha256:${"a".repeat(64)}`,
  revision: "b".repeat(40),
  compose: Buffer.from("services:\n  app:\n    image: example:v0.3.0\n"),
};
function fixture() {
  const state: {
    digest?: string;
    release?: PublishedRelease;
    bytes?: Uint8Array;
    latest: LatestVersion[];
  } = { latest: [{ state: "absent" }, { state: "absent" }] };
  const port = {
    verifySourceTag: vi.fn(async () => {}),
    imageDigest: vi.fn(async () => state.digest),
    tagImage: vi.fn(async (_source: string, destination: string) => {
      if (destination.endsWith(":" + input.tag)) state.digest = input.digest;
    }),
    release: vi.fn(async () => state.release),
    createRelease: vi.fn(async (tag: string) => {
      state.release = { id: 10, tag_name: tag, draft: false, prerelease: false, assets: [] };
      return state.release;
    }),
    assetBytes: vi.fn(async () => state.bytes!),
    uploadAsset: vi.fn(async (_release: number, name: string, bytes: Uint8Array) => {
      state.bytes = Uint8Array.from(bytes);
      state.release!.assets.push({ id: 20, name, state: "uploaded", size: bytes.length });
    }),
    removeAsset: vi.fn(async (id: number) => {
      state.release!.assets = state.release!.assets.filter((asset) => asset.id !== id);
    }),
    latestVersions: vi.fn(async () => state.latest),
    makeLatest: vi.fn(async () => {}),
  } satisfies ReleasePort;
  return { state, port };
}

describe("immutable release publication", () => {
  it("publishes a version and Compose without promoting either latest", async () => {
    const { state, port } = fixture();
    await expect(publishRelease(port, input, "notes")).resolves.toEqual({
      reusedVersion: false,
      reusedAsset: false,
    });
    expect(state.bytes).toEqual(Uint8Array.from(input.compose));
    expect(port.verifySourceTag).toHaveBeenCalledWith(input.tag, input.revision);
    expect(port.tagImage).toHaveBeenCalledExactlyOnceWith(
      `${input.image}@${input.digest}`,
      `${input.image}:${input.tag}`,
    );
    expect(port.makeLatest).not.toHaveBeenCalled();
    expect(port.latestVersions).not.toHaveBeenCalled();
  });

  it("resumes after the image was published but release creation failed", async () => {
    const { port } = fixture();
    port.createRelease.mockRejectedValueOnce(new Error("temporary GitHub failure"));
    await expect(publishRelease(port, input, "notes")).rejects.toThrow("temporary GitHub failure");
    await expect(publishRelease(port, input, "notes")).resolves.toMatchObject({
      reusedVersion: true,
    });
    expect(port.tagImage).toHaveBeenCalledTimes(1);
    expect(port.uploadAsset).toHaveBeenCalledTimes(1);
  });

  it("pins a latest template in the release asset and reuses that pinned asset on retry", async () => {
    const { state, port } = fixture();
    const source = `services:\n  app:\n    image: ${input.image}:latest\n    volumes: ["./data:/data"]\n`;
    const publication = { ...input, compose: Buffer.from(source) };
    await publishRelease(port, publication, "notes");
    expect(Buffer.from(state.bytes!).toString("utf8")).toBe(
      `services:\n  app:\n    image: ${input.image}:${input.tag}\n    volumes: ["./data:/data"]\n`,
    );
    expect(publication.compose.toString("utf8")).toBe(source);
    await expect(publishRelease(port, publication, "notes")).resolves.toEqual({
      reusedVersion: true,
      reusedAsset: true,
    });
    expect(port.uploadAsset).toHaveBeenCalledTimes(1);
  });

  it("resumes after an upload committed but its response was lost", async () => {
    const { port } = fixture();
    const upload = port.uploadAsset.getMockImplementation()!;
    port.uploadAsset.mockImplementationOnce(async (...args) => {
      await upload(...args);
      throw new Error("response lost");
    });
    await expect(publishRelease(port, input, "notes")).rejects.toThrow("response lost");
    await expect(publishRelease(port, input, "notes")).resolves.toEqual({
      reusedVersion: true,
      reusedAsset: true,
    });
    expect(port.createRelease).toHaveBeenCalledTimes(1);
    expect(port.uploadAsset).toHaveBeenCalledTimes(1);
  });

  it("reuses an identical complete release without overwriting artifacts", async () => {
    const { port } = fixture();
    await publishRelease(port, input, "notes");
    await publishRelease(port, input, "notes");
    expect(port.tagImage).toHaveBeenCalledTimes(1);
    expect(port.createRelease).toHaveBeenCalledTimes(1);
    expect(port.uploadAsset).toHaveBeenCalledTimes(1);
    expect(port.removeAsset).not.toHaveBeenCalled();
  });

  it("removes only an unfinished zero-byte starter left by GitHub", async () => {
    const { state, port } = fixture();
    await publishRelease(port, input, "notes");
    state.release!.assets[0] = { id: 20, name: "compose.yaml", state: "starter", size: 0 };
    await publishRelease(port, input, "notes");
    expect(port.removeAsset).toHaveBeenCalledExactlyOnceWith(20);
    expect(port.uploadAsset).toHaveBeenCalledTimes(2);
  });

  it("refuses a conflicting immutable image before modifying the release", async () => {
    const { state, port } = fixture();
    state.digest = `sha256:${"c".repeat(64)}`;
    await expect(publishRelease(port, input, "notes")).rejects.toThrow("refusing replacement");
    expect(port.tagImage).not.toHaveBeenCalled();
    expect(port.release).not.toHaveBeenCalled();
  });

  it("refuses a different uploaded Compose without deleting it", async () => {
    const { state, port } = fixture();
    await publishRelease(port, input, "notes");
    state.bytes = Buffer.from("different content");
    await expect(publishRelease(port, input, "notes")).rejects.toThrow("refusing replacement");
    expect(port.removeAsset).not.toHaveBeenCalled();
    expect(port.uploadAsset).toHaveBeenCalledTimes(1);
  });

  it("does not modify a moved source tag or existing draft", async () => {
    const { state, port } = fixture();
    port.verifySourceTag.mockRejectedValueOnce(new Error("source tag moved"));
    await expect(publishRelease(port, input, "notes")).rejects.toThrow("source tag moved");
    expect(port.tagImage).not.toHaveBeenCalled();
    await publishRelease(port, input, "notes");
    state.release!.draft = true;
    await expect(publishRelease(port, input, "notes")).rejects.toThrow("draft");
    expect(port.uploadAsset).toHaveBeenCalledTimes(1);
  });
});

describe("latest promotion", () => {
  it("requires successful public verification before any external read or write", async () => {
    const { port } = fixture();
    await expect(promoteRelease(port, input, false)).rejects.toThrow("verification must succeed");
    expect(port.imageDigest).not.toHaveBeenCalled();
    expect(port.tagImage).not.toHaveBeenCalled();
    expect(port.makeLatest).not.toHaveBeenCalled();
  });

  it("promotes the exact verified image and release", async () => {
    const { state, port } = fixture();
    await publishRelease(port, input, "notes");
    state.latest = [{ state: "present", version: "v0.2.9" }, { state: "absent" }];
    await expect(promoteRelease(port, input, true)).resolves.toMatchObject({ promoted: true });
    expect(port.tagImage).toHaveBeenLastCalledWith(
      `${input.image}@${input.digest}`,
      `${input.image}:latest`,
    );
    expect(port.makeLatest).toHaveBeenCalledExactlyOnceWith(10);
  });

  it.each([0, 1])("never downgrades latest in either channel (%s)", async (channel) => {
    const { state, port } = fixture();
    await publishRelease(port, input, "notes");
    state.latest[channel] = { state: "present", version: "v0.4.0" };
    await expect(promoteRelease(port, input, true)).resolves.toMatchObject({ promoted: false });
    expect(port.tagImage).toHaveBeenCalledTimes(1);
    expect(port.makeLatest).not.toHaveBeenCalled();
  });

  it.each(
    [0, 1].flatMap((channel) =>
      [
        { state: "unknown" },
        { state: "present", version: "invalid" },
        { state: "present", version: undefined },
      ].map((latest) => ({ channel, latest: latest as LatestVersion })),
    ),
  )(
    "fails without writes when channel $channel has an unverifiable latest: $latest",
    async ({ channel, latest }) => {
      const { state, port } = fixture();
      await publishRelease(port, input, "notes");
      port.tagImage.mockClear();
      state.latest[channel] = latest;
      await expect(promoteRelease(port, input, true)).rejects.toThrow("Latest version");
      expect(port.tagImage).not.toHaveBeenCalled();
      expect(port.makeLatest).not.toHaveBeenCalled();
    },
  );

  it.each([0, 1])("can retry after channel %s becomes readable again", async (channel) => {
    const { state, port } = fixture();
    await publishRelease(port, input, "notes");
    port.tagImage.mockClear();
    state.latest[channel] = { state: "unknown" };
    await expect(promoteRelease(port, input, true)).rejects.toThrow("Latest version is unknown");
    expect(port.tagImage).not.toHaveBeenCalled();
    expect(port.makeLatest).not.toHaveBeenCalled();

    state.latest[channel] = { state: "present", version: "v0.2.9" };
    await expect(promoteRelease(port, input, true)).resolves.toMatchObject({ promoted: true });
    expect(port.tagImage).toHaveBeenCalledExactlyOnceWith(
      `${input.image}@${input.digest}`,
      `${input.image}:latest`,
    );
    expect(port.makeLatest).toHaveBeenCalledExactlyOnceWith(10);
  });

  it("marks the real CLI entry as failed when latest cannot be read", async () => {
    const argv = process.argv;
    const exitCode = process.exitCode;
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    const run = vi.fn(async (_file: string, args: string[]) => {
      if (args[0] !== "buildx" || args[2] !== "inspect")
        throw new Error("Unexpected external command");
      if (args[3] === `${input.image}:latest`) throw new Error("Synthetic registry read failure");
      return JSON.stringify({ digest: input.digest });
    });
    const fetch = vi.fn(async (address: string, options: RequestInit) => {
      if (options.method !== "GET") throw new Error("Unexpected external write");
      if (address.endsWith(`/git/ref/tags/${input.tag}`))
        return Response.json({ object: { type: "commit", sha: input.revision } });
      if (address.endsWith(`/releases/tags/${input.tag}`))
        return Response.json({
          id: 10,
          tag_name: input.tag,
          draft: false,
          prerelease: false,
          assets: [],
        });
      if (address.endsWith("/releases/latest")) return Response.json({ tag_name: "v0.2.9" });
      throw new Error("Unexpected external request");
    });
    vi.doMock("../scripts/lib/process.ts", () => ({ runProcess: run }));
    vi.stubGlobal("fetch", fetch);
    for (const [name, value] of Object.entries({
      IMAGE: input.image,
      RELEASE_TAG: input.tag,
      INDEX_DIGEST: input.digest,
      GITHUB_SHA: input.revision,
      GH_REPO: "example/oci-dash",
      GH_TOKEN: "synthetic-release-token",
      VERIFICATION_RESULT: "success",
    }))
      vi.stubEnv(name, value);
    process.argv = [process.execPath, resolve("scripts/release.ts"), "promote"];
    try {
      process.exitCode = undefined;
      vi.resetModules();
      await import("../scripts/release.ts");
      await vi.waitFor(() => expect(process.exitCode).toBe(1));
      expect(error).toHaveBeenCalledExactlyOnceWith(
        "Latest version is unknown; retry promotion when both channels are readable",
      );
      expect(output).not.toHaveBeenCalled();
      expect(run).toHaveBeenCalledTimes(2);
      expect(fetch).toHaveBeenCalledTimes(3);
    } finally {
      process.argv = argv;
      process.exitCode = exitCode;
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
      vi.doUnmock("../scripts/lib/process.ts");
      vi.resetModules();
      error.mockRestore();
      output.mockRestore();
    }
  });

  it("can resume after image latest advanced but GitHub latest failed", async () => {
    const { state, port } = fixture();
    await publishRelease(port, input, "notes");
    port.makeLatest.mockRejectedValueOnce(new Error("temporary API failure"));
    await expect(promoteRelease(port, input, true)).rejects.toThrow("temporary API failure");
    state.latest[0] = { state: "present", version: input.tag };
    await expect(promoteRelease(port, input, true)).resolves.toMatchObject({ promoted: true });
    expect(port.makeLatest).toHaveBeenCalledTimes(2);
  });

  it("refuses a version changed after public verification", async () => {
    const { state, port } = fixture();
    await publishRelease(port, input, "notes");
    state.digest = `sha256:${"f".repeat(64)}`;
    await expect(promoteRelease(port, input, true)).rejects.toThrow("changed after verification");
    expect(port.makeLatest).not.toHaveBeenCalled();
  });
});

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function documentation(files: Record<string, string>) {
  const base = resolve(".test-tmp");
  mkdirSync(base, { recursive: true });
  const directory = mkdtempSync(join(base, "documentation-"));
  directories.push(directory);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), content);
  }
  return checkDocumentation(directory, Object.keys(files));
}
describe("documentation verification", () => {
  it("classifies pure documentation without skipping runtime/configuration changes", () => {
    expect(documentationOnly(["README.md", "AGENTS.md", "LICENSE", "docs/example.png"])).toBe(true);
    for (const file of [
      "scripts/check-docs.ts",
      ".github/workflows/ci.yml",
      "package-lock.json",
      "tsconfig.json",
      "Dockerfile",
      "compose.yaml",
      "src/server/db.ts",
      "docs/tools/check.ts",
      "docs/config.yaml",
      "docs/palette.css",
      "docs/demo.html",
      "docs/unknown.xyz",
    ])
      expect(documentationOnly(["README.md", file])).toBe(false);
    expect(documentationOnly([])).toBe(false);
  });

  it("checks local and reference links, balanced paths and duplicate Unicode headings", () => {
    expect(
      documentation({
        "README.md":
          "# Demo\n[guide](docs/guide.md#配置-data)\n[source](src/(demo)/a.ts)\n[ref][guide]\n[guide]: docs/guide.md#配置-data-1\n```md\n[ignored](missing.md)\n```\n",
        "docs/guide.md": "## 配置 `./data`\n## 配置 `./data`\n[home](../README.md#demo)\n",
        "src/(demo)/a.ts": "export {};",
      }),
    ).toEqual([]);
  });

  it("reports missing files/headings and repository escapes, ignoring remote links", () => {
    expect(
      documentation({
        "README.md":
          "# Demo\n[x](missing.md)\n[y](#ghost)\n[z](../outside.md)\n[remote](https://example.invalid/unchecked)\n```md\n# ghost\n```\n",
      }),
    ).toEqual([
      "README.md: missing local target missing.md",
      "README.md: missing heading #ghost",
      "README.md: link leaves repository: ../outside.md",
    ]);
  });
});
