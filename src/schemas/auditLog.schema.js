export const LogLevel = Object.freeze({
  INFO: "INFO",
  WARN: "WARN",
  ERROR: "ERROR",
  SECURITY: "SECURITY",
  CRITICAL: "CRITICAL"
});

export const RETENTION_RULES = Object.freeze({
  [LogLevel.INFO]: 3 * 24 * 60 * 60 * 1000,   // 3 days
  [LogLevel.WARN]: 30 * 24 * 60 * 60 * 1000,  // 30 days
  [LogLevel.ERROR]: 90 * 24 * 60 * 60 * 1000, // 90 days
  [LogLevel.SECURITY]: null,                   // Permanent
  [LogLevel.CRITICAL]: null                    // Permanent
});

/**
 * Validates and formats the raw audit log document
 */
export function formatAuditLog({ level = LogLevel.INFO, action, message, actor, metadata = {} }) {
  const normalizedLevel = level.toUpperCase();
  if (!LogLevel[normalizedLevel]) {
    throw new Error(`Invalid log level: ${level}`);
  }

  const now = new Date();
  const retentionMs = RETENTION_RULES[normalizedLevel];
  const expireAt = retentionMs ? new Date(now.getTime() + retentionMs) : null;

  return {
    level: normalizedLevel,
    action: action || "UNKNOWN_ACTION",
    message: String(message || ""),
    actor: {
      type: actor?.type || "system",
      id: actor?.id ? String(actor.id) : "anonymous"
    },
    metadata: metadata && typeof metadata === "object" ? metadata : {},
    createdAt: now,
    expireAt
  };
}