import { httpRequestCounter, httpRequestDuration } from "../utils/metrics.js";

/**
 * Hono Middleware to track request count and latency
 */
export const metricsMiddleware = async (c, next) => {
  const path = c.req.path;

  // Skip metrics scraping endpoint itself to prevent self-sampling skew
  if (path === "/metrics") {
    return await next();
  }

  const start = process.hrtime();

  await next();

  const diff = process.hrtime(start);
  const durationInSeconds = diff[0] + diff[1] / 1e9;

  // Use matched route pattern if available (e.g. /product/:id) or fall back to raw path
  const route = c.req.routePath || path;
  const method = c.req.method;
  const status = String(c.res.status);

  const labels = { method, route, status };

  httpRequestCounter.inc(labels);
  httpRequestDuration.observe(labels, durationInSeconds);
};