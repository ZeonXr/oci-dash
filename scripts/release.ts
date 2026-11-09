import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { runProcess } from "./lib/process.ts";

export interface ReleaseAsset {
  id: number;
  name: string;
  state: string;
  size: number;
}
export interface PublishedRelease {
  id: number;
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  assets: ReleaseAsset[];
}
export type LatestVersion =
  { state: "absent" } | { state: "unknown" } | { state: "present"; version: string | undefined };
export interface ReleasePort {
  verifySourceTag(tag: string, revision: string): Promise<void>;
  imageDigest(reference: string): Promise<string | undefined>;
  tagImage(source: string, destination: string): Promise<void>;
  release(tag: string): Promise<PublishedRelease | undefined>;
  createRelease(tag: string, notes: string): Promise<PublishedRelease>;
  assetBytes(tag: string, name: string): Promise<Uint8Array>;
  uploadAsset(releaseId: number, name: string, bytes: Uint8Array): Promise<void>;
  removeAsset(assetId: number): Promise<void>;
  latestVersions(): Promise<LatestVersion[]>;
  makeLatest(releaseId: number): Promise<void>;
}
export interface ReleaseInput {
  image: string;
  tag: string;
  digest: string;
  revision: string;
  compose: Uint8Array;
}
function validate(input: ReleaseInput): void {
  assert.match(input.image, /^ghcr\.io\/[a-z0-9_.-]+\/[a-z0-9_.-]+$/);
  assert.match(input.tag, /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  assert.match(input.digest, /^sha256:[a-f0-9]{64}$/);
  assert.match(input.revision, /^[a-f0-9]{40}$/);
}
function requireRelease(release: PublishedRelease, tag: string): void {
  assert.equal(release.tag_name, tag, "Release tag does not match this publication");
  assert.equal(release.draft, false, "An existing draft must not be published implicitly");
  assert.equal(release.prerelease, false, "An existing prerelease must not be changed implicitly");
}
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Resume only artifacts with the exact content already validated by this run. */
export async function publishRelease(port: ReleasePort, input: ReleaseInput, notes: string) {
  validate(input);
  // The repository follows latest; each immutable release asset pins its own version.
  const compose = Buffer.from(
    Buffer.from(input.compose)
      .toString("utf8")
      .replaceAll(`image: ${input.image}:latest`, `image: ${input.image}:${input.tag}`),
  );
  await port.verifySourceTag(input.tag, input.revision);
  const destination = `${input.image}:${input.tag}`;
  const existing = await port.imageDigest(destination);
  if (existing !== undefined)
    assert.equal(existing, input.digest, "Published version digest differs; refusing replacement");
  else await port.tagImage(`${input.image}@${input.digest}`, destination);
  assert.equal(
    await port.imageDigest(destination),
    input.digest,
    "Version publication did not match",
  );

  const release = (await port.release(input.tag)) ?? (await port.createRelease(input.tag, notes));
  requireRelease(release, input.tag);
  const assets = release.assets.filter((asset) => asset.name === "compose.yaml");
  assert.ok(assets.length <= 1, "Release contains duplicate Compose assets");
  const asset = assets[0];
  if (asset?.state === "starter" && asset.size === 0) {
    // GitHub may leave a zero-byte starter after an interrupted upload.
    await port.removeAsset(asset.id);
  } else if (asset) {
    assert.equal(asset.state, "uploaded", "Compose upload is incomplete");
    assert.equal(
      hash(await port.assetBytes(input.tag, asset.name)),
      hash(compose),
      "Published Compose differs; refusing replacement",
    );
    return { reusedVersion: existing !== undefined, reusedAsset: true };
  }
  await port.uploadAsset(release.id, "compose.yaml", compose);
  return { reusedVersion: existing !== undefined, reusedAsset: false };
}

function version(value: string | undefined): bigint[] | undefined {
  const match = value && /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
  return match ? match.slice(1).map(BigInt) : undefined;
}

/** The workflow calls this only after anonymous deployment verification succeeds. */
export async function promoteRelease(port: ReleasePort, input: ReleaseInput, verified: boolean) {
  validate(input);
  assert.equal(verified, true, "Public deployment verification must succeed before promotion");
  await port.verifySourceTag(input.tag, input.revision);
  assert.equal(
    await port.imageDigest(`${input.image}:${input.tag}`),
    input.digest,
    "Version digest changed after verification",
  );
  const release = await port.release(input.tag);
  assert.ok(release, "Release does not exist");
  requireRelease(release, input.tag);
  for (const latest of await port.latestVersions()) {
    if (latest.state === "unknown") return { promoted: false, reason: "Latest version is unknown" };
    if (latest.state === "present") {
      const previous = version(latest.version);
      if (!previous) return { promoted: false, reason: "Latest version label is invalid" };
      const incoming = version(input.tag)!;
      const different = incoming.findIndex((value, index) => value !== previous[index]);
      if (different >= 0 && incoming[different]! < previous[different]!)
        return { promoted: false, reason: "A newer version is already latest" };
    }
  }
  await port.tagImage(`${input.image}@${input.digest}`, `${input.image}:latest`);
  await port.makeLatest(release.id);
  return { promoted: true, reason: "Verified version promoted to latest" };
}

const missingManifest = (error: unknown): boolean =>
  error instanceof Error && /manifest unknown|no such manifest|: not found/.test(error.message);

function cliPort(image: string, repository: string, token: string): ReleasePort {
  assert.match(repository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
  assert.ok(token, "GH_TOKEN is required");
  const docker = (args: string[]) => runProcess("docker", args, { timeoutMs: 180_000 });
  async function api(method: string, path: string, body?: unknown): Promise<unknown> {
    const response = await fetch(`https://api.github.com/repos/${repository}/${path}`, {
      method,
      redirect: "error",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 404 && method === "GET") return undefined;
    assert.ok(response.ok, `GitHub ${method} returned HTTP ${response.status}`);
    return response.status === 204 ? undefined : response.json();
  }
  async function imageDigest(reference: string): Promise<string | undefined> {
    try {
      const manifest = JSON.parse(
        await docker([
          "buildx",
          "imagetools",
          "inspect",
          reference,
          "--format",
          "{{json .Manifest}}",
        ]),
      ) as { digest?: unknown };
      assert.ok(typeof manifest.digest === "string", "Image descriptor is missing its digest");
      assert.match(manifest.digest, /^sha256:[a-f0-9]{64}$/);
      return manifest.digest;
    } catch (error) {
      if (missingManifest(error)) return undefined;
      throw error;
    }
  }
  return {
    async verifySourceTag(tag, revision) {
      let object = (await api("GET", `git/ref/tags/${encodeURIComponent(tag)}`)) as
        { object: { type: string; sha: string } } | undefined;
      assert.ok(object, "Source tag no longer exists");
      for (let depth = 0; depth < 8 && object.object.type === "tag"; depth++) {
        assert.match(object.object.sha, /^[a-f0-9]{40}$/);
        object = (await api("GET", `git/tags/${object.object.sha}`)) as typeof object;
        assert.ok(object, "Annotated source tag is missing");
      }
      assert.equal(object.object.type, "commit", "Source tag must resolve to a commit");
      assert.equal(object.object.sha, revision, "Source tag moved after image verification");
    },
    imageDigest,
    async tagImage(source, destination) {
      await docker(["buildx", "imagetools", "create", "--tag", destination, source]);
    },
    async release(tag) {
      return (await api("GET", `releases/tags/${encodeURIComponent(tag)}`)) as
        PublishedRelease | undefined;
    },
    async createRelease(tag, notes) {
      return (await api("POST", "releases", {
        tag_name: tag,
        name: `OCI Dash ${tag}`,
        body: notes,
        draft: false,
        prerelease: false,
        make_latest: "false",
      })) as PublishedRelease;
    },
    async assetBytes(tag, name) {
      const response = await fetch(
        `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`,
        { credentials: "omit", signal: AbortSignal.timeout(30_000) },
      );
      assert.ok(response.ok, `Public Compose download returned HTTP ${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      assert.ok(bytes.length <= 1024 * 1024, "Published Compose asset is unexpectedly large");
      return bytes;
    },
    async uploadAsset(releaseId, name, bytes) {
      assert.ok(Number.isSafeInteger(releaseId) && releaseId > 0);
      const response = await fetch(
        `https://uploads.github.com/repos/${repository}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`,
        {
          method: "POST",
          redirect: "error",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/yaml" },
          body: Buffer.from(bytes),
          signal: AbortSignal.timeout(30_000),
        },
      );
      assert.ok(response.ok, `Compose upload returned HTTP ${response.status}`);
      const asset = (await response.json()) as ReleaseAsset;
      assert.equal(asset.state, "uploaded");
      assert.equal(asset.size, bytes.length);
    },
    async removeAsset(assetId) {
      assert.ok(Number.isSafeInteger(assetId) && assetId > 0);
      await api("DELETE", `releases/assets/${assetId}`);
    },
    async latestVersions() {
      let registry: LatestVersion;
      try {
        if (!(await imageDigest(`${image}:latest`))) registry = { state: "absent" };
        else {
          await docker(["pull", "--platform", "linux/amd64", `${image}:latest`]);
          const labels = JSON.parse(
            await docker([
              "image",
              "inspect",
              `${image}:latest`,
              "--format",
              "{{json .Config.Labels}}",
            ]),
          ) as Record<string, string> | null;
          registry = { state: "present", version: labels?.["org.opencontainers.image.version"] };
        }
      } catch {
        registry = { state: "unknown" };
      }
      try {
        const release = (await api("GET", "releases/latest")) as PublishedRelease | undefined;
        return [
          registry,
          release ? { state: "present", version: release.tag_name } : { state: "absent" },
        ];
      } catch {
        return [registry, { state: "unknown" }];
      }
    },
    async makeLatest(releaseId) {
      await api("PATCH", `releases/${releaseId}`, { make_latest: "true" });
    },
  };
}

async function main() {
  const input: ReleaseInput = {
    image: process.env.IMAGE ?? "",
    tag: process.env.RELEASE_TAG ?? "",
    digest: process.env.INDEX_DIGEST ?? "",
    revision: process.env.GITHUB_SHA ?? "",
    compose: readFileSync("compose.yaml"),
  };
  const port = cliPort(input.image, process.env.GH_REPO ?? "", process.env.GH_TOKEN ?? "");
  if (process.argv[2] === "publish") {
    const notesPath = process.argv[3];
    assert.ok(notesPath, "A release notes file is required");
    console.log(await publishRelease(port, input, readFileSync(notesPath, "utf8")));
  } else if (process.argv[2] === "promote") {
    console.log(await promoteRelease(port, input, process.env.VERIFICATION_RESULT === "success"));
  } else throw new Error("Usage: node scripts/release.ts publish NOTES_FILE | promote");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Release operation failed");
    process.exitCode = 1;
  });
}
