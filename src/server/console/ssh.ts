import { spawn } from "node:child_process";
import { createHash, generateKeyPair, type KeyObject } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { CloudError } from "../oci/types";
import { cancelled, consoleDelay } from "./oci";

export interface ConsoleEndpoint {
  serviceHost: string;
  connectionId: string;
  instanceId: string;
  innerSshPort: number;
  vncHost: string;
  vncPort: number;
}
export interface ConsoleSshTunnel {
  connect(): Promise<Duplex>;
  close(): Promise<void>;
  closed: Promise<void>;
}
export interface ConsoleSshSession {
  publicKey: string;
  open(input: {
    endpoint: ConsoleEndpoint;
    serviceHostKeyFingerprint: string;
    signal: AbortSignal;
  }): Promise<ConsoleSshTunnel>;
  close(): Promise<void>;
}
export type ConsoleSshFactory = (input: {
  sessionId: string;
  signal: AbortSignal;
}) => Promise<ConsoleSshSession>;

/** A replaceable process boundary; production always uses spawn with shell:false. */
export interface ConsoleSshProcess {
  exited: Promise<{ code: number | null; stdout: string }>;
  stop(): Promise<void>;
}
export type ConsoleSshRunner = (
  command: "ssh" | "ssh-keyscan",
  args: string[],
  signal: AbortSignal,
) => ConsoleSshProcess;

const invalidString = () =>
  new CloudError("OCI 返回了不支持的 VNC 连接格式", "UNSUPPORTED_CONSOLE_COMMAND");

/** A small tokenizer for OCI's documented format, not a shell interpreter. */
function words(input: string): string[] {
  if (!input || input.length > 8192 || /[\x00-\x1f\x7f\\\x60$;|&<>]/.test(input))
    throw invalidString();
  const result: string[] = [];
  let quote = "",
    word = "",
    started = false;
  for (const character of input) {
    if (quote) {
      if (character === quote) quote = "";
      else word += character;
    } else if (character === "'" || character === '"') {
      quote = character;
      started = true;
    } else if (/\s/.test(character)) {
      if (started) result.push(word);
      word = "";
      started = false;
    } else {
      word += character;
      started = true;
    }
  }
  if (quote) throw invalidString();
  if (started) result.push(word);
  return result;
}

/**
 * Only extract data from the official two-hop command. Neither the returned command
 * nor ProxyCommand is ever passed to a shell or OpenSSH. Unknown flags fail closed.
 */
export function parseVncConnectionString(
  input: string,
  expected: { instanceId: string; connectionId: string; region: string },
): ConsoleEndpoint {
  const args = words(input);
  if (args.shift() !== "ssh") throw invalidString();
  let proxy: string | undefined,
    forward: string | undefined,
    noCommand = false;
  while (args.length > 1) {
    const option = args.shift();
    if (option === "-o" && proxy === undefined) {
      const value = args.shift();
      if (!value?.startsWith("ProxyCommand=")) throw invalidString();
      proxy = value.slice("ProxyCommand=".length);
    } else if (option === "-L" && forward === undefined) {
      forward = args.shift();
    } else if (option === "-N" && !noCommand) {
      noCommand = true;
    } else throw invalidString();
  }
  const destination = args[0];
  if (
    !proxy ||
    !forward ||
    !noCommand ||
    ![expected.instanceId, expected.connectionId + "@" + expected.instanceId].includes(destination)
  )
    throw invalidString();
  const hop = words(proxy);
  if (
    hop.length !== 6 ||
    hop[0] !== "ssh" ||
    hop[1] !== "-W" ||
    hop[2] !== "%h:%p" ||
    hop[3] !== "-p" ||
    hop[4] !== "443"
  )
    throw invalidString();
  const [user, serviceHost, extra] = hop[5].split("@");
  const allowedHosts = [
    "instance-console." + expected.region + ".oraclecloud.com",
    "instance-console." + expected.region + ".oci.oraclecloud.com",
    "instance-console." + expected.region + ".oracleiaas.com",
    "instance-console." + expected.region + ".oci.oracleiaas.com",
  ];
  if (extra !== undefined || user !== expected.connectionId || !allowedHosts.includes(serviceHost))
    throw invalidString();
  const [bind, localPort, target, targetPort, extraForward] = forward.split(":");
  if (
    !["localhost", "127.0.0.1"].includes(bind) ||
    localPort !== "5900" ||
    target !== expected.instanceId ||
    targetPort !== "5900" ||
    extraForward !== undefined
  )
    throw invalidString();
  return {
    serviceHost,
    connectionId: expected.connectionId,
    instanceId: expected.instanceId,
    innerSshPort: 22,
    vncHost: expected.instanceId,
    vncPort: 5900,
  };
}

function keyRecords(scan: string): { type: string; key: string; fingerprint: string }[] {
  const allowed = [
    "ssh-rsa",
    "ssh-ed25519",
    "ecdsa-sha2-nistp256",
    "ecdsa-sha2-nistp384",
    "ecdsa-sha2-nistp521",
  ];
  return scan.split(/\r?\n/).flatMap((line) => {
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 3 || fields[0].startsWith("#") || !allowed.includes(fields[1])) return [];
    const key = fields[2];
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(key) || key.length > 16384) return [];
    const blob = Buffer.from(key, "base64");
    if (blob.length < 8 || blob.toString("base64").replace(/=+$/, "") !== key.replace(/=+$/, ""))
      return [];
    const typeLength = blob.readUInt32BE(0);
    if (typeLength > 64 || blob.subarray(4, 4 + typeLength).toString("ascii") !== fields[1])
      return [];
    return [
      {
        type: fields[1],
        key: blob.toString("base64"),
        fingerprint:
          "SHA256:" + createHash("sha256").update(blob).digest("base64").replace(/=+$/, ""),
      },
    ];
  });
}

/** The service key algorithm varies by OCI region; trust only its exact API SHA256. */
export function verifiedServiceHostKey(scan: string, fingerprint: string): string {
  if (!/^SHA256:[A-Za-z0-9+/]{43}=?$/.test(fingerprint))
    throw new CloudError("OCI 未提供可验证的 SSH 服务指纹", "CONSOLE_FINGERPRINT_INVALID");
  const expected = fingerprint.replace(/=+$/, "");
  const matching = keyRecords(scan).filter((key) => key.fingerprint === expected);
  if (!matching.length)
    throw new CloudError("OCI 控制台 SSH 主机指纹不匹配", "CONSOLE_HOST_KEY_MISMATCH");
  return "oci-console-service " + matching[0].type + " " + matching[0].key + "\n";
}

type SshStage = "OUTER_KEYSCAN" | "OUTER_AUTH" | "INNER_AUTH";
function sshStageError(stage: SshStage, timedOut = false): CloudError {
  const labels: Record<SshStage, string> = {
    OUTER_KEYSCAN: "外层主机密钥扫描",
    OUTER_AUTH: "外层 SSH 认证",
    INNER_AUTH: "内层 SSH 认证",
  };
  return new CloudError(
    "OCI 控制台" + labels[stage] + (timedOut ? "超时" : "失败"),
    "CONSOLE_" + stage + (timedOut ? "_TIMEOUT" : "_FAILED"),
  );
}

const defaultRunner: ConsoleSshRunner = (command, args, signal) => {
  cancelled(signal);
  const child = spawn(command, args, {
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "",
    overflow = false,
    complete = false;
  let stopPromise: Promise<void> | undefined;
  const exited = new Promise<{ code: number | null; stdout: string }>((resolve) => {
    const finish = (code: number | null) => {
      if (complete) return;
      complete = true;
      signal.removeEventListener("abort", abort);
      resolve({ code: overflow ? -1 : code, stdout: output });
    };
    child.stdout.on("data", (data: Buffer) => {
      if (output.length + data.length > 65536) {
        overflow = true;
        child.kill();
      } else output += data.toString("utf8");
    });
    // Never surface raw diagnostics: SSH errors can contain internal hosts and key paths.
    child.stderr.resume();
    child.once("error", () => finish(-1));
    child.once("close", (code) => finish(code));
  });
  const stop = () =>
    (stopPromise ??= (async () => {
      if (complete) return;
      child.kill("SIGTERM");
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        exited,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 1000);
        }),
      ]);
      if (timer) clearTimeout(timer);
      if (!complete) {
        child.kill("SIGKILL");
        await exited;
      }
    })());
  const abort = () => {
    void stop();
  };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  return { exited, stop };
};

async function freePort(): Promise<number> {
  const server = createServer();
  return new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new CloudError("无法分配本机控制台端口", "CONSOLE_PORT_FAILED"));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}
function sshString(value: Buffer): Buffer {
  const size = Buffer.alloc(4);
  size.writeUInt32BE(value.length);
  return Buffer.concat([size, value]);
}
function integer(value: string): Buffer {
  const decoded = Buffer.from(value, "base64url");
  return sshString(decoded[0] & 0x80 ? Buffer.concat([Buffer.from([0]), decoded]) : decoded);
}
async function rsaPair(): Promise<{ privateKey: string; publicKey: string }> {
  const pair = await new Promise<{ publicKey: KeyObject; privateKey: KeyObject }>(
    (resolve, reject) => {
      generateKeyPair("rsa", { modulusLength: 2048 }, (error, publicKey, privateKey) =>
        error ? reject(error) : resolve({ publicKey, privateKey }),
      );
    },
  );
  const jwk = pair.publicKey.export({ format: "jwk" });
  if (!jwk.e || !jwk.n) throw new CloudError("临时 SSH 密钥生成失败", "CONSOLE_KEY_FAILED");
  const blob = Buffer.concat([sshString(Buffer.from("ssh-rsa")), integer(jwk.e), integer(jwk.n)]);
  return {
    privateKey: pair.privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
    publicKey: "ssh-rsa " + blob.toString("base64") + " oci-dash-console",
  };
}

export interface OpenSshOptions {
  runner?: ConsoleSshRunner;
  tempRoot?: string;
  startupTimeoutMs?: number;
  pollIntervalMs?: number;
}
export function createOpenSshFactory(options: OpenSshOptions = {}): ConsoleSshFactory {
  const runner = options.runner ?? defaultRunner;
  const startupTimeoutMs = options.startupTimeoutMs ?? 20_000;
  const pollIntervalMs = options.pollIntervalMs ?? 150;
  return async ({ signal }) => {
    cancelled(signal);
    if (process.platform === "win32" && options.runner === undefined)
      throw new CloudError(
        "Windows 原生 Node.js 不支持 VNC 控制台，请使用 Linux 容器运行此功能。",
        "CONSOLE_PLATFORM_UNSUPPORTED",
      );
    const directory = await mkdtemp(join(options.tempRoot ?? tmpdir(), "oci-dash-console-"));
    const lifetime = new AbortController();
    const commands = new Set<ConsoleSshProcess>();
    const streams = new Set<Socket>();
    let closing: Promise<void> | undefined,
      opened = false,
      connected = false;
    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    const close = () =>
      (closing ??= (async () => {
        lifetime.abort();
        signal.removeEventListener("abort", abort);
        streams.forEach((stream) => stream.destroy());
        try {
          await Promise.allSettled([...commands].map((command) => command.stop()));
          await rm(directory, { recursive: true, force: true });
        } finally {
          resolveClosed();
        }
      })());
    const abort = () => {
      void close().catch(() => {});
    };
    signal.addEventListener("abort", abort, { once: true });
    const keyPath = join(directory, "identity");
    const knownPath = join(directory, "known_hosts");
    const outerSocket = join(directory, "outer.sock");
    const innerSocket = join(directory, "inner.sock");
    const run = (command: "ssh" | "ssh-keyscan", args: string[], operationSignal: AbortSignal) => {
      const process = runner(command, args, operationSignal);
      commands.add(process);
      void process.exited.then(() => commands.delete(process));
      return process;
    };
    let stage: SshStage = "OUTER_KEYSCAN";
    const checkedRun = async (
      command: "ssh" | "ssh-keyscan",
      args: string[],
      operationSignal: AbortSignal,
    ) => {
      const process = run(command, args, operationSignal);
      const result = await process.exited;
      cancelled(operationSignal);
      if (result.code !== 0) throw sshStageError(stage);
      return result.stdout;
    };
    const baseArgs = (
      hostAlias: string,
      endpoint: ConsoleEndpoint,
      port: number,
      hostKeyPolicy: "yes" | "accept-new" = "yes",
    ) => [
      "-F",
      process.platform === "win32" ? "NUL" : "/dev/null",
      "-i",
      keyPath,
      "-l",
      endpoint.connectionId,
      "-p",
      String(port),
      "-o",
      "BatchMode=yes",
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      "IdentityAgent=none",
      "-o",
      "PreferredAuthentications=publickey",
      "-o",
      "PasswordAuthentication=no",
      "-o",
      "KbdInteractiveAuthentication=no",
      "-o",
      "StrictHostKeyChecking=" + hostKeyPolicy,
      "-o",
      "UserKnownHostsFile=" + knownPath,
      "-o",
      "GlobalKnownHostsFile=" + (process.platform === "win32" ? "NUL" : "/dev/null"),
      "-o",
      "HostKeyAlias=" + hostAlias,
      "-o",
      "UpdateHostKeys=no",
      "-o",
      "HostKeyAlgorithms=+ssh-rsa",
      "-o",
      "PubkeyAcceptedAlgorithms=+ssh-rsa",
      "-o",
      "ExitOnForwardFailure=yes",
      "-o",
      "ConnectTimeout=10",
      "-o",
      "ConnectionAttempts=1",
      "-o",
      "ServerAliveInterval=15",
      "-o",
      "ServerAliveCountMax=2",
      "-o",
      "ForwardAgent=no",
      "-o",
      "PermitLocalCommand=no",
      "-o",
      "LogLevel=ERROR",
    ];
    const startMaster = async (
      args: string[],
      controlPath: string,
      host: string,
      forward: string,
      readySignal: AbortSignal,
    ) => {
      const child = run(
        "ssh",
        [...args, "-M", "-S", controlPath, "-o", "ControlPersist=no", "-N", "-L", forward, host],
        lifetime.signal,
      );
      let exited = false;
      void child.exited.then(() => {
        exited = true;
        abort();
      });
      while (true) {
        cancelled(readySignal);
        if (exited) throw sshStageError(stage);
        const check = run("ssh", [...args, "-S", controlPath, "-O", "check", host], readySignal);
        const result = await check.exited;
        cancelled(readySignal);
        if (result.code === 0 && !exited) return;
        await consoleDelay(pollIntervalMs, readySignal);
      }
    };
    try {
      await chmod(directory, 0o700);
      const keys = await rsaPair();
      cancelled(signal);
      cancelled(lifetime.signal);
      await writeFile(keyPath, keys.privateKey, { mode: 0o600, flag: "wx" });
      await chmod(keyPath, 0o600);
      await writeFile(knownPath, "", { mode: 0o600, flag: "wx" });
      await chmod(knownPath, 0o600);
      cancelled(signal);
      cancelled(lifetime.signal);
      return {
        publicKey: keys.publicKey,
        close,
        async open({ endpoint, serviceHostKeyFingerprint, signal: openSignal }) {
          if (opened || closing)
            throw new CloudError("控制台 SSH 会话不能重复打开", "CONSOLE_ALREADY_OPEN");
          opened = true;
          const readySignal = AbortSignal.any([
            signal,
            openSignal,
            lifetime.signal,
            AbortSignal.timeout(startupTimeoutMs),
          ]);
          try {
            const outerScan = await checkedRun(
              "ssh-keyscan",
              ["-T", "10", "-p", "443", "-t", "rsa,ecdsa,ed25519", endpoint.serviceHost],
              readySignal,
            );
            const serviceKey = verifiedServiceHostKey(outerScan, serviceHostKeyFingerprint);
            await writeFile(knownPath, serviceKey, { mode: 0o600 });
            const sshPort = await freePort();
            const outerArgs = baseArgs("oci-console-service", endpoint, 443);
            stage = "OUTER_AUTH";
            await startMaster(
              outerArgs,
              outerSocket,
              endpoint.serviceHost,
              "127.0.0.1:" + sshPort + ":" + endpoint.instanceId + ":" + endpoint.innerSshPort,
              readySignal,
            );
            // OCI permits only one active inner SSH connection; a separate keyscan
            // can occupy that channel even after its local process has exited.
            // Discover and persist the inner key during this single SSH handshake.
            // accept-new is used only for hardcoded loopback reached through the
            // authenticated, API-pinned outer master. Its private known_hosts still
            // rejects a changed recorded key; no public host uses this policy.
            const vncPort = await freePort();
            const innerArgs = baseArgs("oci-console-instance", endpoint, sshPort, "accept-new");
            stage = "INNER_AUTH";
            await startMaster(
              innerArgs,
              innerSocket,
              "127.0.0.1",
              "127.0.0.1:" + vncPort + ":" + endpoint.vncHost + ":" + endpoint.vncPort,
              readySignal,
            );
            cancelled(readySignal);
            return {
              close,
              closed,
              async connect(): Promise<Duplex> {
                if (connected || closing || lifetime.signal.aborted)
                  throw new CloudError(
                    "控制台通道不可用或已经被占用",
                    "CONSOLE_CHANNEL_UNAVAILABLE",
                  );
                connected = true;
                const stream = createConnection({ host: "127.0.0.1", port: vncPort });
                streams.add(stream);
                stream.once("close", () => streams.delete(stream));
                try {
                  await new Promise<void>((resolve, reject) => {
                    let data = Buffer.alloc(0);
                    const done = (error?: Error) => {
                      clearTimeout(timer);
                      stream.removeListener("readable", readable);
                      stream.removeListener("error", failed);
                      stream.removeListener("close", ended);
                      if (error) {
                        stream.destroy();
                        reject(error);
                      } else resolve();
                    };
                    const failed = () =>
                      done(new CloudError("VNC 通道连接失败", "CONSOLE_VNC_FAILED"));
                    const ended = () =>
                      done(new CloudError("VNC 通道已关闭", "CONSOLE_VNC_FAILED"));
                    const readable = () => {
                      const chunk = stream.read(12 - data.length) as Buffer | null;
                      if (!chunk) return;
                      data = Buffer.concat([data, chunk]);
                      if (data.length < 12) return;
                      if (!/^RFB 003\.00[378]\n$/.test(data.toString("ascii"))) {
                        done(new CloudError("远程控制台未返回有效 VNC 握手", "CONSOLE_VNC_FAILED"));
                        return;
                      }
                      // noVNC must receive the original protocol banner.
                      stream.unshift(data);
                      done();
                    };
                    const timer = setTimeout(failed, 10_000);
                    stream.on("readable", readable);
                    stream.once("error", failed);
                    stream.once("close", ended);
                  });
                  return stream;
                } catch (error) {
                  await close();
                  throw error;
                }
              },
            };
          } catch (error) {
            const callerCancelled = signal.aborted || openSignal.aborted;
            const timedOut = readySignal.aborted && !lifetime.signal.aborted && !callerCancelled;
            await close();
            if (error instanceof CloudError && (error.code !== "CANCELLED" || callerCancelled))
              throw error;
            throw sshStageError(stage, timedOut);
          }
        },
      };
    } catch (error) {
      await close();
      if (error instanceof CloudError) throw error;
      throw new CloudError("无法创建临时控制台 SSH 会话", "CONSOLE_KEY_FAILED");
    }
  };
}
