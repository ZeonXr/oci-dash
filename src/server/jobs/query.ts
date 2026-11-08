import { z } from "zod";
import type { JobListQuery } from "@/lib/contracts";
import { AppError } from "../errors";

const optionalText = z.string().max(200).optional();
const querySchema = z
  .object({
    page: z.coerce.number().int().min(1).max(1_000_000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(100),
    query: z.string().max(200).optional(),
    accountId: optionalText,
    resourceId: z.string().max(2048).optional(),
    state: z
      .enum([
        "queued",
        "running",
        "retrying",
        "succeeded",
        "failed",
        "cancel_requested",
        "cancelled",
        "interrupted",
      ])
      .optional(),
    sort: z.enum(["ascending", "descending"]).default("descending"),
  })
  .strict();

export function parseJobQuery(params: URLSearchParams): JobListQuery | "active" {
  const input: Record<string, string> = Object.create(null);
  for (const [key, value] of params) {
    if (Object.hasOwn(input, key)) throw new AppError("查询参数不能重复", 400, "INVALID_JOB_QUERY");
    input[key] = value;
  }
  if (input.active === "true" && Object.keys(input).length === 1) return "active";
  const result = querySchema.safeParse(input);
  if (!result.success) throw new AppError("任务查询参数不正确", 400, "INVALID_JOB_QUERY");
  return result.data;
}
