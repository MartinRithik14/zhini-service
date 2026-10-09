import { getMessaging } from 'firebase-admin/messaging';

/**
 * Dispatches a push notification to target FCM tokens.
 */
export const sendPushNotification = async (tokens = [], { title, body, data = {} }) => {
  const validTokens = [...new Set(tokens.filter((t) => typeof t === 'string' && t.trim().length > 0))];

  if (validTokens.length === 0) {
    console.log("ℹ️ No valid FCM tokens available to dispatch notification.");
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
    const messaging = getMessaging(); // Automatically binds to the initialized default app
    const response = await messaging.sendEachForMulticast(message);
    console.log(`📲 FCM Dispatched: ${response.successCount} success, ${response.failureCount} failed.`);
    return response;
  } catch (err) {
    console.error("❌ FCM Send Error:", err.message);
    return null;
  }
};