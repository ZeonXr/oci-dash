import { ZodError } from "zod";
import type { SessionUser } from "@/lib/contracts";
import { AppError, safeMessage } from "./errors";
import { requireUser, assertSameOrigin } from "./auth";
import { isDemo } from "./db";

export const json = (value: unknown, status = 200, headers?: HeadersInit) => Response.json(value, { status, headers: { "Cache-Control": "no-store", ...headers } });
export async function readJson(request: Request): Promise<unknown> {
  if (!(request.headers.get("content-type") ?? "").includes("application/json")) throw new AppError("请求应使用 JSON", 415);
  if (Number(request.headers.get("content-length") ?? 0) > 256 * 1024) throw new AppError("请求过大", 413);
  const reader = request.body?.getReader(); if (!reader) throw new AppError("请求内容不能为空");
  const chunks: Uint8Array[] = []; let size = 0;
  while (true) {
    const next = await reader.read(); if (next.done) break;
    size += next.value.byteLength;
    if (size > 256 * 1024) { await reader.cancel(); throw new AppError("请求过大", 413); }
    chunks.push(next.value);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  try { return JSON.parse(raw); } catch { throw new AppError("JSON 格式不正确"); }
}
export function errorResponse(error: unknown): Response {
  if (error instanceof ZodError) return json({ error: error.issues[0]?.message ?? "参数不正确", code: "VALIDATION_ERROR" }, 400);
  if (error instanceof AppError) return json({ error: safeMessage(error), code: error.code }, error.status);
  if (error && typeof error === "object" && "status" in error && typeof error.status === "number") {
    const code = "code" in error && typeof error.code === "string" ? error.code : "OPERATION_ERROR";
    return json({ error: safeMessage(error), code }, Math.max(400, Math.min(599, error.status)));
  }
  // OCI errors contain request metadata; only sanitized messages cross this boundary.
  if (error instanceof Error && error.name === "CloudError") return json({ error: safeMessage(error), code: "CLOUD_ERROR" }, 502);
  console.error("request failed:", safeMessage(error));
  return json({ error: "服务暂时不可用，请查看运行日志后重试", code: "INTERNAL_ERROR" }, 500);
}
export function api(handler: (request: Request, user: SessionUser) => Promise<Response> | Response, options: { mutation?: boolean; cloudWrite?: boolean } = {}) {
  return async (request: Request): Promise<Response> => {
    try {
      const user = requireUser(request);
      if (options.mutation || options.cloudWrite) assertSameOrigin(request);
      if (options.cloudWrite && isDemo()) throw new AppError("演示模式不执行云操作或保存真实凭据", 403, "DEMO_READ_ONLY");
      return await handler(request, user);
    } catch (error) { return errorResponse(error); }
  };
}
