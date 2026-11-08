import { afterEach, describe, expect, it, vi } from "vitest";
import { api, readResource } from "@/components/api";

interface PendingRead {
  signal: AbortSignal;
  respond(value: unknown): void;
}
const subscriptions: ReturnType<typeof readResource>[] = [];
const subscribe = <T>(url = "/api/read-fixture") => {
  const read = readResource<T>(url);
  subscriptions.push(read);
  return read;
};
function fixture(options: { ignoreAbort?: boolean; authStatus?: number } = {}) {
  const calls: PendingRead[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((_url: string, request: RequestInit) => {
      if (request.method === "POST")
        return Promise.resolve(Response.json({ ok: true }, { status: options.authStatus ?? 200 }));
      return new Promise<Response>((resolve, reject) => {
        const signal = request.signal!;
        const abort = () => reject(signal.reason);
        if (!options.ignoreAbort) signal.addEventListener("abort", abort, { once: true });
        calls.push({
          signal,
          respond(value) {
            signal.removeEventListener("abort", abort);
            resolve(Response.json(value));
          },
        });
      });
    }),
  );
  return calls;
}
afterEach(async () => {
  for (const read of subscriptions) read.release();
  await Promise.allSettled(subscriptions.map((read) => read.promise));
  subscriptions.length = 0;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("shared resource reads", () => {
  it("keeps a shared fetch alive when one subscriber leaves, including repeated cleanup", async () => {
    const calls = fixture();
    const first = subscribe<{ value: number }>(),
      second = subscribe<{ value: number }>();
    expect(calls).toHaveLength(1);
    expect(first.promise).toBe(second.promise);
    first.release();
    first.release();
    expect(calls[0].signal.aborted).toBe(false);
    calls[0].respond({ value: 7 });
    expect(await second.promise).toEqual({ value: 7 });
    second.release();
    expect(calls[0].signal.aborted).toBe(false);
  });

  it("aborts the last subscriber immediately without an old cleanup removing a replacement read", async () => {
    const calls = fixture();
    const first = subscribe();
    first.release();
    expect(calls[0].signal.aborted).toBe(true);
    const second = subscribe();
    await expect(first.promise).rejects.toMatchObject({ name: "AbortError" });
    const third = subscribe();
    expect(calls).toHaveLength(2);
    expect(third.promise).toBe(second.promise);
    expect(calls[1].signal.aborted).toBe(false);
    calls[1].respond({ value: "replacement" });
    expect(await third.promise).toEqual({ value: "replacement" });
  });

  it("does not cancel reads for another URL", async () => {
    const calls = fixture();
    const first = subscribe("/api/first-fixture"),
      second = subscribe("/api/second-fixture");
    first.release();
    await expect(first.promise).rejects.toMatchObject({ name: "AbortError" });
    expect(calls[1].signal.aborted).toBe(false);
    calls[1].respond({ value: "second" });
    expect(await second.promise).toEqual({ value: "second" });
  });

  it("starts a fresh read after completion instead of retaining a response", async () => {
    const calls = fixture();
    const first = subscribe();
    calls[0].respond({ value: "before mutation" });
    await first.promise;
    const second = subscribe();
    expect(calls).toHaveLength(2);
    calls[1].respond({ value: "after mutation" });
    expect(await second.promise).toEqual({ value: "after mutation" });
  });

  it("aborts old authentication reads and rejects their late responses without disturbing a new login", async () => {
    const calls = fixture({ ignoreAbort: true });
    const previous = subscribe();
    await api("/api/auth/login", { method: "POST" });
    expect(calls[0].signal.aborted).toBe(true);
    const current = subscribe();
    calls[0].respond({ identity: "old login" });
    await expect(previous.promise).rejects.toMatchObject({ name: "AbortError" });
    const shared = subscribe();
    expect(calls).toHaveLength(2);
    expect(shared.promise).toBe(current.promise);
    calls[1].respond({ identity: "new login" });
    expect(await current.promise).toEqual({ identity: "new login" });
  });

  it("keeps current reads when an authentication change fails", async () => {
    const calls = fixture({ authStatus: 403 });
    const current = subscribe();
    await expect(api("/api/auth/login", { method: "POST" })).rejects.toMatchObject({ status: 403 });
    expect(calls[0].signal.aborted).toBe(false);
    expect(subscribe().promise).toBe(current.promise);
    calls[0].respond({ value: "unchanged" });
    expect(await current.promise).toEqual({ value: "unchanged" });
  });

  it("keeps timeout failures distinct from deliberate subscriber cancellation", async () => {
    const timeout = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
    const calls = fixture();
    const current = subscribe();
    timeout.abort(new DOMException("Timed out", "TimeoutError"));
    await expect(current.promise).rejects.toMatchObject({ name: "TimeoutError" });
    expect(calls[0].signal.aborted).toBe(true);
    expect(current.signal.aborted).toBe(false);
  });
});
