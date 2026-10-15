import { logAudit } from "../utils/auditLogger.js";

export const auditHttpMiddleware = async (c, next) => {
  const start = Date.now();
  await next();
  const duration = Date.now() - start;

  // Skip noise
  if (c.req.path === "/health" || c.req.path === "/favicon.ico") return;

  const status = c.res.status;
  const level = status >= 500 ? "ERROR" : status >= 400 ? "WARN" : "INFO";

  // Fire-and-forget: does not block the HTTP response
  logAudit({
    level,
    action: `HTTP_${c.req.method}`,
    message: `${c.req.method} ${c.req.path} -> ${status} (${duration}ms)`,
    actor: {
      type: "http_client",
      id: c.req.header("x-forwarded-for") || c.req.header("cf-connecting-ip") || "unknown"
    },
    metadata: {
      path: c.req.path,
      method: c.req.method,
      status,
      durationMs: duration
    }
  });
};