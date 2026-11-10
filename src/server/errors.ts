export class AppError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
    public readonly code = "BAD_REQUEST",
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function safeMessage(error: unknown): string {
  if (error instanceof DrizzleQueryError) return "数据库操作失败，请稍后重试";
  const raw = error instanceof Error ? error.message : "操作失败，请稍后重试";
  return raw
    .replace(/-----BEGIN[\s\S]*?-----END[^-]+-----/g, "[redacted key]")
    .replace(/(authorization|privateKey|password|secret)\s*[:=]\s*[^,\n]+/gi, "$1=[redacted]")
    .slice(0, 1200);
}
import { DrizzleQueryError } from "drizzle-orm";
