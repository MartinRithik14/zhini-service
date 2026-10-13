// Import MONGODB_URI and withDatabase exactly how authMiddleware does it
import { withDatabase } from "../utils/config.js"; 

const MONGODB_URI = process.env.MONGODB_URI;


// --- IN-MEMORY CACHE FOR SETTINGS ---
let cachedConfig = null;
let lastConfigFetch = 0;
const CONFIG_CACHE_TTL = 60 * 1000; // Refresh from DB every 60 seconds

// Default fallback if DB read fails or config document is missing
const DEFAULT_CONFIG = {
  isEnabled: true,
  maxRequests: 30,
  windowMs: 60 * 1000,
};

// --- IN-MEMORY IP HIT TRACKER ---
// Key: client IP -> Value: { count: number, resetTime: number }
const ipHitMap = new Map();

// Periodic cleanup every 5 minutes to prevent memory leaks from stale IPs
setInterval(() => {
  const now = Date.now();
  for (const [ip, data] of ipHitMap.entries()) {
    if (now > data.resetTime) {
      ipHitMap.delete(ip);
    }
  }
}, 5 * 60 * 1000);

/**
 * Loads rate limiter settings from MongoDB with 60s memory caching
 */
async function getRateLimiterConfig() {
  const now = Date.now();
  if (cachedConfig && now - lastConfigFetch < CONFIG_CACHE_TTL) {
    return cachedConfig;
  }

  try {
    const configDoc = await withDatabase(MONGODB_URI, async (db) => {
      return await db.collection("settings").findOne({ _id: "rate_limiter_config" });
    });

    if (configDoc) {
      cachedConfig = {
        isEnabled: configDoc.isEnabled ?? true,
        maxRequests: Number(configDoc.maxRequests) || 30,
        windowMs: Number(configDoc.windowMs) || 60000,
      };
    } else {
      cachedConfig = DEFAULT_CONFIG;
    }
  } catch (err) {
    console.error("⚠️ Failed to load rate limiter settings from DB, using fallback!!!:", err.message);
    if (!cachedConfig) cachedConfig = DEFAULT_CONFIG;
  }

  lastConfigFetch = now;
  return cachedConfig;
}

/**
 * Extracts real client IP behind proxies, load balancers, or Cloudflare
 */
function getClientIp(c) {
  const forwarded = c.req.header("x-forwarded-for");
  if (forwarded) {
    return forwarded.split(",")[0].trim();
  }
  return (
    c.req.header("cf-connecting-ip") ||
    c.req.header("x-real-ip") ||
    "127.0.0.1"
  );
}

/**
 * Global Rate Limiter Middleware for Hono
 */
export const rateLimiter = async (c, next) => {
  const config = await getRateLimiterConfig();

  // If disabled in MongoDB settings, bypass
  if (!config.isEnabled) {
    return await next();
  }

  const clientIp = getClientIp(c);
  const now = Date.now();

  let clientData = ipHitMap.get(clientIp);

  // Initialize or reset if the window expired
  if (!clientData || now > clientData.resetTime) {
    clientData = {
      count: 1,
      resetTime: now + config.windowMs,
    };
    ipHitMap.set(clientIp, clientData);
  } else {
    clientData.count += 1;
  }

  const remaining = Math.max(0, config.maxRequests - clientData.count);
  const resetSeconds = Math.ceil((clientData.resetTime - now) / 1000);

  // Standard rate limit response headers
  c.header("X-RateLimit-Limit", String(config.maxRequests));
  c.header("X-RateLimit-Remaining", String(remaining));
  c.header("X-RateLimit-Reset", String(Math.ceil(clientData.resetTime / 1000)));

  // Threshold exceeded: reject with 429
  if (clientData.count > config.maxRequests) {
    c.header("Retry-After", String(resetSeconds));
    return c.json(
      {
        success: false,
        message: "Too many requests. Please slow down.",
        retryAfterSeconds: resetSeconds,
      },
      429
    );
  }

  await next();
};