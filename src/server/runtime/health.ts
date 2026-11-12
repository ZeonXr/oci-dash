interface HealthOptions {
  port?: number;
}

/** The application owns readiness and database checks; the probe only reads HTTP. */
export async function checkRuntimeHealth(options: HealthOptions = {}): Promise<boolean> {
  try {
    const port = options.port ?? Number(process.env.PORT ?? 6240);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(2000),
      redirect: "error",
    });
    return response.ok && (await response.json()).ok === true;
  } catch {
    return false;
  }
}
