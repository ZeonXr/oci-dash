import { describe, expect, it, vi } from "vitest";
import type { InstanceSummary } from "@/lib/contracts";
import { createOciAdapter } from "@/server/oci/adapter";
import type { CloudDocument, ClientPort, OciClients } from "@/server/oci/sdk";

const id = (kind: string, name = "fixture") => `ocid1.${kind}.oc1..${name}`;
const credentials = {
  tenancyId: id("tenancy"),
  userId: id("user"),
  privateKey: "synthetic",
  fingerprint: "synthetic",
  region: "ap-test-1",
};
const target = { id: id("instance"), region: credentials.region } as InstanceSummary;
function fixture() {
  const handlers: Record<string, (request: CloudDocument) => unknown> = {
    getInstance: () => ({ instance: { id: target.id, compartmentId: credentials.tenancyId } }),
    listCompartments: () => ({ items: [] }),
    listVnicAttachments: () => ({
      items: ["one", "two"].map((name) => ({
        lifecycleState: "ATTACHED",
        instanceId: target.id,
        vnicId: id("vnic", name),
      })),
    }),
    getVnic: (request) => ({ vnic: { id: request.vnicId, compartmentId: credentials.tenancyId } }),
    summarizeMetricsData: () => ({ items: [] }),
  };
  let active = 0,
    peak = 0;
  const closed: ReturnType<typeof vi.fn>[] = [];
  const calls: { operation: string; request: CloudDocument; signal?: AbortSignal }[] = [];
  const adapter = createOciAdapter({
    clientFactory: (_credentials, _region, signal) => {
      const close = vi.fn();
      closed.push(close);
      const client: ClientPort = {
        async call(operation, request) {
          calls.push({ operation, request, signal });
          active++;
          peak = Math.max(peak, active);
          try {
            return (await handlers[operation](request)) as CloudDocument;
          } finally {
            active--;
          }
        },
        close,
      };
      return Object.fromEntries(
        ["compute", "identity", "network", "storage", "monitoring"].map((name) => [name, client]),
      ) as unknown as OciClients;
    },
  });
  return { adapter, handlers, calls, closed, peak: () => peak };
}

describe("bounded instance metric RPCs", () => {
  it("reads series in parallel and keeps four actual RPC slots until cancelled work settles", async () => {
    const f = fixture(),
      caller = new AbortController();
    const releases: (() => void)[] = [];
    f.handlers.summarizeMetricsData = () =>
      releases.length < 4
        ? new Promise((resolve) => {
            releases.push(() => resolve({ items: [] }));
          })
        : { items: [] };
    const abandoned = f.adapter
      .metrics(credentials, target, "1h", caller.signal)
      .catch((error) => error);
    await vi.waitFor(() => expect(releases).toHaveLength(4));
    expect(f.peak()).toBe(4);
    caller.abort();
    const next = f.adapter.metrics(credentials, target, "1h");
    await Promise.resolve();
    await Promise.resolve();
    expect(f.calls.filter((call) => call.operation === "summarizeMetricsData")).toHaveLength(4);
    expect(f.closed[0]).not.toHaveBeenCalled();
    for (const release of releases) release();
    expect(await abandoned).toMatchObject({ code: "CANCELLED" });
    await next;
    expect(f.peak()).toBe(4);
    const oldMetrics = f.calls.filter(
      (call) => call.operation === "summarizeMetricsData" && call.signal === caller.signal,
    );
    expect(oldMetrics).toHaveLength(4); // The fifth series was never dispatched.
    expect(f.closed[0]).toHaveBeenCalledTimes(1);
    expect(f.closed[1]).toHaveBeenCalledTimes(1);
  });
  it("waits for a sibling preflight read before closing clients after a failure", async () => {
    const f = fixture();
    let release!: () => void;
    f.handlers.getInstance = () => {
      throw new Error("unavailable");
    };
    f.handlers.listCompartments = () =>
      new Promise((resolve) => {
        release = () => resolve({ items: [] });
      });
    const pending = f.adapter.metrics(credentials, target, "1h").catch((error) => error);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    expect(f.closed[0]).not.toHaveBeenCalled();
    release();
    expect(await pending).toMatchObject({ name: "CloudError" });
    expect(f.closed[0]).toHaveBeenCalledTimes(1);
  });
  it("keeps incomplete multi-VNIC totals null instead of counting missing observations as zero", async () => {
    const f = fixture();
    f.handlers.summarizeMetricsData = (request) => {
      const query = request.summarizeMetricsDataDetails.query as string;
      return query.includes(`"${id("vnic", "two")}"`)
        ? { items: [] }
        : {
            items: [
              {
                aggregatedDatapoints: [
                  {
                    timestamp: new Date("2026-11-09T00:00:00Z"),
                    value: query.startsWith("Cpu") ? 12 : 0,
                  },
                ],
              },
            ],
          };
    };
    const result = await f.adapter.metrics(credentials, target, "1h");
    expect(result.points[0]).toMatchObject({ cpu: 12, receivedBytes: null, sentBytes: null });
    expect(result.note).toContain("部分网卡采样缺失");
  });
  it.each([
    ["1h", 60],
    ["24h", 300],
    ["7d", 3600],
  ] as const)(
    "declares the %s sample interval and adds matching VNIC observations",
    async (range, intervalSeconds) => {
      const f = fixture();
      f.handlers.summarizeMetricsData = (request) => {
        const query = request.summarizeMetricsDataDetails.query as string;
        return {
          items: [
            {
              aggregatedDatapoints: [
                {
                  timestamp: new Date("2026-11-09T00:00:00Z"),
                  value: query.startsWith("Cpu") ? 12 : query.includes("one") ? 100 : 200,
                },
              ],
            },
          ],
        };
      };
      const result = await f.adapter.metrics(credentials, target, range);
      expect(result.intervalSeconds).toBe(intervalSeconds);
      expect(result.points).toEqual([
        {
          timestamp: "2026-11-09T00:00:00.000Z",
          cpu: 12,
          receivedBytes: 300,
          sentBytes: 300,
        },
      ]);
    },
  );
});
