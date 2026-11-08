import { AppError } from "./errors";

const mismatch = () => new AppError("请求来源不匹配，请从面板页面操作", 403, "ORIGIN_MISMATCH");

/** Only an HTTP(S) origin is accepted; URL credentials, paths and lists are not origins. */
export function parseOrigin(value: string): URL {
  if (!/^https?:\/\/[^\s\\/?#]+\/?$/i.test(value)) throw mismatch();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw mismatch();
  }
  if (url.username || url.password || !url.hostname || /[,;%]/.test(url.host)) throw mismatch();
  return url;
}

export function configuredOrigin(value = process.env.APP_ORIGIN): string | undefined {
  if (value === undefined || value === "") return;
  return parseOrigin(value).origin;
}

/** The real Host header is authoritative. Never substitute X-Forwarded-Host. */
export function hostOrigin(host: string, protocol: string): URL {
  if (!["http:", "https:"].includes(protocol) || !host || /[\s\\/?#@,;%]/.test(host))
    throw mismatch();
  const url = parseOrigin(`${protocol}//${host}`);
  // A trailing colon is accepted by URL(), but is not a valid Host authority.
  if (host.endsWith(":")) throw mismatch();
  return url;
}

export function assertRequestOrigin(
  request: Pick<Request, "headers" | "url">,
  expected = configuredOrigin(),
): URL {
  const raw = request.headers.get("origin");
  if (!raw || request.headers.get("sec-fetch-site")?.toLowerCase() === "cross-site")
    throw mismatch();
  const origin = parseOrigin(raw);
  // A Request created from a public URL may omit Host. The HTTP gateway requires
  // it; framework-generated internal URLs must never override an existing Host.
  const host = request.headers.get("host") ?? new URL(request.url).host;
  if (hostOrigin(host, origin.protocol).origin !== origin.origin) throw mismatch();
  if (expected && origin.origin !== parseOrigin(expected).origin) throw mismatch();
  return origin;
}

/** Validate raw gateway targets before URL() can normalize a foreign authority away. */
export function gatewayRequestUrl(
  target: string,
  host: string,
  origin: string | undefined,
  expected?: string,
): URL {
  const base = hostOrigin(host, expected ? parseOrigin(expected).protocol : "http:");
  if (!target || /[\s\\#]/.test(target) || target.startsWith("//"))
    throw new AppError("请求地址无效", 400, "INVALID_REQUEST_TARGET");
  if (target.startsWith("/")) return new URL(target, base);
  let absolute: URL;
  try {
    absolute = new URL(target);
  } catch {
    throw new AppError("请求地址无效", 400, "INVALID_REQUEST_TARGET");
  }
  const compare = expected ?? (origin ? parseOrigin(origin).origin : base.origin);
  if (
    !["http:", "https:"].includes(absolute.protocol) ||
    absolute.username ||
    absolute.password ||
    absolute.origin !== compare ||
    hostOrigin(host, absolute.protocol).origin !== absolute.origin
  )
    throw new AppError("请求地址无效", 400, "INVALID_REQUEST_TARGET");
  return absolute;
}
