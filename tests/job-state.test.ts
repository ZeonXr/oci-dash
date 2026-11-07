import { describe, expect, it } from "vitest";
import type { JobSummary } from "@/lib/contracts";
import { isJobPending, isJobCancellable } from "@/lib/job-state";

const base = { attempt: 1, maxAttempts: 4, nextRunAt: null };
describe("shared task lifecycle decisions", () => {
  it.each(["queued", "running", "retrying", "cancel_requested"] as const)(
    "continues polling %s",
    (state) => {
      expect(isJobPending({ ...base, state })).toBe(true);
    },
  );
  it("distinguishes recoverable interruption from exhausted or unscheduled interruption", () => {
    const interrupted = { ...base, state: "interrupted" as const };
    expect(isJobPending(interrupted)).toBe(false);
    expect(isJobPending({ ...interrupted, nextRunAt: "2026-01-01T00:00:01Z" })).toBe(true);
    expect(isJobPending({ ...interrupted, attempt: 4, nextRunAt: "2026-01-01T00:00:01Z" })).toBe(
      false,
    );
    expect(
      isJobPending({
        ...interrupted,
        attempt: 4,
        waitingForCompletion: true,
        nextRunAt: "2026-01-01T00:00:01Z",
      }),
    ).toBe(true);
  });
  it.each(["queued", "running", "retrying", "interrupted"] as const)(
    "offers cancellation for %s",
    (state) => {
      expect(isJobCancellable({ state })).toBe(true);
    },
  );
  it.each(["failed", "cancelled", "succeeded", "cancel_requested"] as const)(
    "does not offer another cancellation for %s",
    (state) => {
      expect(isJobCancellable({ state })).toBe(false);
      if (state !== "cancel_requested")
        expect(isJobPending({ ...base, state } as JobSummary)).toBe(false);
    },
  );
});
