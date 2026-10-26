import { withDatabase } from "../utils/config.js";
import { sendPushNotification, notifyUserByMobile } from "../utils/fcmHelper.js";

const MONGODB_URI = process.env.MONGODB_URI;

// Countdown milestones (days remaining until warranty expiry)
const WARRANTY_MILESTONES = [30, 15, 7, 3, 1, 0];

/**
 * 🛠️ Daily Warranty Expiry Processor
 */
export const processDailyWarrantyExpiryJob = async (db, job) => {
  console.log(`🔍 [Job: ${job._id}] Processing daily warranty expiry scan...`);

  const devicesCollection = db.collection("devices");
  const usersCollection = db.collection("users");
  const jobsCollection = db.collection("jobs_queue");

  try {
    // 1. Fetch all active devices that have valid warranty data
    const devices = await devicesCollection.find({
      warranty: { $exists: true, $nin: [null, "", "N/A", "UNDEFINED", "null"] }
    }).toArray();

    const now = new Date();
    // Normalize to midnight for accurate whole-day comparison
    const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    let notificationsSent = 0;

    for (const device of devices) {
      const warrantyDate = new Date(device.warranty);
      if (isNaN(warrantyDate.getTime())) continue;

      const expiryMidnight = new Date(
        warrantyDate.getFullYear(),
        warrantyDate.getMonth(),
        warrantyDate.getDate()
      );

      // Calculate days remaining until expiry
      const diffTime = expiryMidnight.getTime() - todayMidnight.getTime();
      const daysRemaining = Math.round(diffTime / (1000 * 60 * 60 * 24));

      // Skip past expiries older than day 0 or days outside our target cadence
      if (!WARRANTY_MILESTONES.includes(daysRemaining)) {
        continue;
      }

      // Check if this device already received notification for this specific milestone
      const notifiedMilestones = Array.isArray(device.notifiedMilestones)
        ? device.notifiedMilestones
        : [];

      if (notifiedMilestones.includes(daysRemaining)) {
        continue;
      }

      // 2. Fetch user's registered FCM tokens via addedByUserMobile
      const userMobile = device.addedByUserMobile;
      if (!userMobile) continue;

      const user = await usersCollection.findOne({
        $or: [
          { mobile: userMobile },
          { "UserInfo.phoneNo": userMobile },
          { _id: device.addedByUserId }
        ]
      });

      // Extract device tokens from user document: PlatformInfo.devices[].fcmToken
      const userDevices = user?.PlatformInfo?.devices || [];
      const fcmTokens = userDevices
        .map((d) => d.fcmToken)
        .filter(Boolean);

      if (fcmTokens.length === 0) {
        console.warn(`⚠️ No active FCM token for user: ${userMobile} (Device: ${device.deviceId})`);
        continue;
      }

      // 3. Draft dynamic message content based on the milestone
      const productName = `${device.brand || ""} ${device.product || "Device"}`.trim();
      let title = "";
      let body = "";

      if (daysRemaining > 1) {
        title = `Warranty Expiry Alert ⚠️`;
        body = `Warranty for your ${productName} expires in ${daysRemaining} days. Check coverage on Zhini.`;
      } else if (daysRemaining === 1) {
        title = `Warranty Expires Tomorrow! ⏳`;
        body = `Tomorrow is the last day of official warranty for your ${productName}.`;
      } else if (daysRemaining === 0) {
        title = `Warranty Expired Today 🛡️`;
        body = `Warranty for your ${productName} has expired today. Switch to Zhini Verified local service partners.`;
      }

      // 4. Dispatch FCM Push via shared helper
      await sendPushNotification(fcmTokens, title, body, {
        type: "WARRANTY_EXPIRY",
        deviceId: device.deviceId || String(device._id),
        daysRemaining: String(daysRemaining),
        product: device.product || "",
        brand: device.brand || "",
      });

      // 5. Record milestone on device to ensure idempotency
      await devicesCollection.updateOne(
        { _id: device._id },
        {
          $addToSet: { notifiedMilestones: daysRemaining },
          $set: { lastWarrantyAlertAt: new Date(), updatedAt: new Date() }
        }
      );

      notificationsSent++;
    }

    console.log(`✅ [Job: ${job._id}] Finished warranty scan. Dispatched ${notificationsSent} notification(s).`);

    // 6. Complete and Reschedule Job for next run (24 hours later)
    const nextRun = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await jobsCollection.updateOne(
      { _id: job._id },
      {
        $set: {
          status: "pending",
          lastRunAt: now,
          runAt: nextRun,
          lockedAt: null,
          lastRunSummary: {
            notificationsDispatched: notificationsSent,
            completedAt: new Date()
          }
        }
      }
    );

  } catch (error) {
    console.error(`❌ [Job: ${job._id}] Failed to process warranty expiry job:`, error);
    await jobsCollection.updateOne(
      { _id: job._id },
      {
        $set: {
          status: "failed",
          failedAt: new Date(),
          errorReason: error.message
        }
      }
    );
  }
};

/**
 * ⏳ Mongo Queue Runner Started (Background Engine for Zhini)
 */
export const startQueueRunner = () => {
  console.log("⏳ Zhini Mongo Queue Runner Started...");

  setInterval(async () => {
    try {
      const now = new Date();

      if (!MONGODB_URI) {
        console.error("⚠️ Master Queue Runner: MONGODB_URI configuration string is completely missing.");
        return;
      }

      await withDatabase(MONGODB_URI, async (db) => {
        // Find pending jobs ready to run
        const job = await db.collection("jobs_queue").findOneAndUpdate(
          {
            status: "pending",
            runAt: { $lte: now }
          },
          {
            $set: { status: "processing", lockedAt: now }
          },
          {
            returnDocument: "after"
          }
        );

        if (!job) return;

        console.log(`🚀 Found active task to run: [${job.taskType}] (ID: ${job._id})`);

        // 🔀 TASK ROUTER
        switch (job.taskType) {
          case "DAILY_WARRANTY_EXPIRY_CHECK":
            await processDailyWarrantyExpiryJob(db, job);
            break;

          default:
            console.log(`⚠️ Unknown task type encountered: ${job.taskType}`);
            await db.collection("jobs_queue").updateOne(
              { _id: job._id },
              { $set: { status: "failed", reason: "Unknown task type", lockedAt: null } }
            );
        }
      });

    } catch (error) {
      console.error("❌ Error in Zhini Queue Runner loop:", error.message);
    }
  }, 30000); // Polls every 30 seconds
};

/**
 * 🧪 Test Runner: Directly fires a push notification to a specific mobile number using notifyUserByMobile
 */
export const testDirectNotification = async (targetMobile = "9342639912") => {
  console.log(`\n🧪 [TEST NOTIFICATION] Starting test for mobile: ${targetMobile}...`);

  try {
    const response = await notifyUserByMobile(targetMobile, {
      title: "Zhini Test Alert 🔔",
      body: "Your FCM notification pipeline is active and working!",
      data: {
        type: "TEST_ALERT",
        timestamp: new Date().toISOString()
      }
    });

    if (response && response.successCount > 0) {
      console.log(`🎉 [TEST NOTIFICATION] Successfully delivered test notification to mobile: ${targetMobile}\n`);
    } else {
      console.error(`❌ [TEST NOTIFICATION] Message dispatch failed or no tokens found.`);
    }
  } catch (error) {
    console.error("❌ [TEST NOTIFICATION] Error executing test function:", error.message);
  }
};