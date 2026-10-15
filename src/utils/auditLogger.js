import { withDatabase } from "../utils/config.js";
import { formatAuditLog } from "../schemas/auditLog.schema.js";

export async function ensureAuditLogIndexes() {
  try {
    await withDatabase(process.env.MONGODB_URI, async (db) => {
      await db.collection("audit_logs").createIndex({ expireAt: 1 }, { expireAfterSeconds: 0 });
      await db.collection("audit_logs").createIndex({ level: 1, createdAt: -1 });
      await db.collection("audit_logs").createIndex({ action: 1, createdAt: -1 });
    });
  } catch (err) {
    console.error("⚠️ Audit index setup error:", err.message);
  }
}

export async function logAudit(rawLog, existingDb = null) {
  try {
    const logDoc = formatAuditLog(rawLog);

    const write = async (db) => {
      await db.collection("audit_logs").insertOne(logDoc);
    };

    if (existingDb) {
      await write(existingDb);
    } else {
      await withDatabase(process.env.MONGODB_URI, write);
    }
  } catch (err) {
    console.error(`⚠️ Failed to persist audit record:`, err.message);
  }
}