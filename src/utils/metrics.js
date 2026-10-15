import client from "prom-client";

// Initialize a custom registry
export const register = new client.Registry();

// Set default labels (optional, tags all metrics with the app name)
register.setDefaultLabels({
  app: "zhini-backend",
});

// Collect NodeJS process/runtime metrics (event loop lag, memory, CPU, GC, etc.)
client.collectDefaultMetrics({ register });

// 1. Total HTTP Requests Counter
export const httpRequestCounter = new client.Counter({
  name: "http_requests_total",
  help: "Total number of HTTP requests processed",
  labelNames: ["method", "route", "status"],
  registers: [register],
});

// 2. HTTP Request Duration Histogram
export const httpRequestDuration = new client.Histogram({
  name: "http_request_duration_seconds",
  help: "Duration of HTTP requests in seconds",
  labelNames: ["method", "route", "status"],
  buckets: [0.05, 0.1, 0.3, 0.5, 1, 2, 5],
  registers: [register],
});