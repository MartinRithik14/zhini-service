import { getMessaging } from 'firebase-admin/messaging';
import { withDatabase } from '../utils/config.js';

const MONGODB_URI = process.env.MONGODB_URI;


export const sendPushNotification = async (tokens = [], arg2, arg3, arg4 = {}) => {
  let title = "";
  let body = "";
  let data = {};

  if (typeof arg2 === "object" && arg2 !== null && !Array.isArray(arg2)) {
    title = arg2.title || "";
    body = arg2.body || "";
    data = arg2.data || {};
  } else {
    title = arg2 || "";
    body = arg3 || "";
    data = arg4 || {};
  }

  const validTokens = [...new Set(
    (Array.isArray(tokens) ? tokens : [tokens]).filter(
      (t) => typeof t === 'string' && t.trim().length > 0
    )
  )];

  if (validTokens.length === 0) {
    console.log("ℹ️ [FCM] No valid FCM tokens available to dispatch notification.");
    return null;
  }

  // Ensure all data attributes are string values (FCM specification)
  const sanitizedData = Object.entries(data).reduce((acc, [key, val]) => {
    acc[key] = String(val ?? "");
    return acc;
  }, {});

  const message = {
    notification: { title, body },
    data: sanitizedData,
    tokens: validTokens,
  };

  try {
    const messaging = getMessaging(); // Binds to initialized default app
    const response = await messaging.sendEachForMulticast(message);
    console.log(`📲 [FCM] Dispatched: ${response.successCount} success, ${response.failureCount} failed.`);
    return response;
  } catch (err) {
    console.error("❌ [FCM] Send Error:", err.message);
    return null;
  }
};

/**
 * 👤 Dispatches push notifications to a user looked up by mobile number
 * Resolves tokens from `users.PlatformInfo.devices[].fcmToken`
 */
export const notifyUserByMobile = async (targetMobile, { title, body, data = {} }) => {
  if (!targetMobile) {
    console.warn("⚠️ [notifyUserByMobile] Mobile number missing.");
    return null;
  }

  const cleanMobile = String(targetMobile).trim();

  try {
    return await withDatabase(MONGODB_URI, async (db) => {
      const usersCollection = db.collection("users");

      const user = await usersCollection.findOne({
        $or: [
          { mobile: cleanMobile },
          { "UserInfo.phoneNo": cleanMobile },
        ],
      });

      const userDevices = user?.PlatformInfo?.devices || [];
      const tokens = userDevices
        .map((d) => d.fcmToken)
        .filter(Boolean);

      if (tokens.length === 0) {
        console.warn(`⚠️ [notifyUserByMobile] No active FCM tokens found in PlatformInfo for: ${cleanMobile}`);
        return null;
      }

      return await sendPushNotification(tokens, { title, body, data });
    });
  } catch (err) {
    console.error(`❌ [notifyUserByMobile] Failed for mobile ${cleanMobile}:`, err.message);
    return null;
  }
};