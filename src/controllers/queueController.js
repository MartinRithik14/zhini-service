import { withDatabase } from "../utils/config.js";
import { notifyUserByMobile } from "../utils/fcmHelper.js";

const MONGODB_URI = process.env.MONGODB_URI;




import { notifyUserByMobile } from "../utils/fcmHelper.js";

/**
 * 🛠️ Daily Warranty Expiry Notification Engine
 * - Scans devices with active warranty dates
 * - Calculates remaining calendar days relative to UTC midnight
 * - Dispatches FCM alerts on target milestones (30, 15, 7, 3, 1, 0)
 * - Stamps notified milestones via $addToSet to prevent duplicate alerts
 * - Reschedules the queue job in-place for 24 hours later
 */
export const processDailyWarrantyExpiryJob = async (db, job) => {
  const devicesCollection = db.collection("devices");
  const jobsQueue = db.collection("jobs_queue");

  try {
    const now = new Date();
    const todayMidnight = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
    );

    const TARGET_MILESTONES = [30, 15, 7, 3, 1, 0];

    const devices = await devicesCollection
      .find({
        warranty: { $exists: true, $nin: [null, "", "N/A"] },
      })
      .toArray();

    let sentCount = 0;

    for (const device of devices) {
      const userMobile = device.addedByUserMobile || device.userMobile;
      if (!userMobile) continue;

      const expiryDate = new Date(device.warranty);
      if (isNaN(expiryDate.getTime())) continue;

      const expiryMidnight = new Date(
        Date.UTC(
          expiryDate.getUTCFullYear(),
          expiryDate.getUTCMonth(),
          expiryDate.getUTCDate()
        )
      );

      const diffTime = expiryMidnight.getTime() - todayMidnight.getTime();
      const diffDays = Math.round(diffTime / (1000 * 60 * 60 * 24));

      if (diffDays < 0 || diffDays > 30) continue;

      if (TARGET_MILESTONES.includes(diffDays)) {
        const alreadyNotified =
          Array.isArray(device.notifiedMilestones) &&
          device.notifiedMilestones.includes(diffDays);

        if (!alreadyNotified) {
          const deviceName = `${device.brand ? device.brand + " " : ""}${
            device.product || "Device"
          }`.trim();

          const title =
            diffDays === 0
              ? `Warranty Expires Today! ⚠️`
              : `Warranty Expiring in ${diffDays} Days! ⚠️`;

          const body =
            diffDays === 0
              ? `Your ${deviceName} warranty expires today. Tap to check details.`
              : `Your ${deviceName} warranty expires in ${diffDays} days. Tap to check details.`;

          await notifyUserByMobile(userMobile.toString().trim(), {
            title,
            body,
            data: {
              type: "WARRANTY_EXPIRY",
              deviceId: String(device.deviceId || device._id),
              daysRemaining: String(diffDays),
            },
          }).catch((err) =>
            console.error(
              `⚠️ [FCM Failed] User ${userMobile}:`,
              err.message
            )
          );

          await devicesCollection.updateOne(
            { _id: device._id },
            {
              $addToSet: { notifiedMilestones: diffDays },
              $set: { updatedAt: new Date() },
            }
          );

          sentCount++;
        }
      }
    }

    console.log(
      `[WARRANTY JOB] Scan completed. Candidate devices: ${devices.length} | Dispatched: ${sentCount}`
    );

    // Reschedule for next 24-hour cycle
    await jobsQueue.updateOne(
      { _id: job._id },
      {
        $set: {
          status: "pending",
          runAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
          lastRunAt: new Date(),
          lockedAt: null,
          lastError: null,
        },
      }
    );
  } catch (error) {
    console.error("❌ [WARRANTY JOB] Execution error:", error.message);

    // Unlock and retry after a 5-minute backoff
    await jobsQueue.updateOne(
      { _id: job._id },
      {
        $set: {
          status: "pending",
          runAt: new Date(Date.now() + 5 * 60 * 1000),
          lockedAt: null,
          lastError: error.message,
        },
      }
    );
  }
};

export const startQueueRunner = () => {
  console.log("🚀 Zhini Queue Runner initialized (Polling every 30s)");

  setInterval(async () => {
    try {
      const now = new Date();
      if (!MONGODB_URI) return;

      await withDatabase(MONGODB_URI, async (db) => {
        const result = await db.collection("jobs_queue").findOneAndUpdate(
          {
            status: "pending",
            runAt: { $lte: now },
          },
          {
            $set: { status: "processing", lockedAt: now },
          },
          {
            returnDocument: "after",
          }
        );

        const activeJob = result?.value !== undefined ? result.value : result;
        if (!activeJob) return;

        if (activeJob.taskType === "DAILY_WARRANTY_EXPIRY_CHECK") {
          await processDailyWarrantyExpiryJob(db, activeJob);
        }
      });
    } catch (error) {
      console.error("❌ Queue Runner Loop Error:", error.message);
    }
  }, 30000);
};

