import { withDatabase } from '../utils/config.js';

const MONGODB_URI = process.env.MONGODB_URI;

export const addcrash = async (c) => {
  try {

    const { data } = await c.req.json();

    if (!data || Object.keys(data).length === 0) {
      return c.json({ error: "Crash data is required!" }, 400);
    }

    return await withDatabase(MONGODB_URI, async (db) => {
      const crashRecord = {
        ...data,
        createdAt: new Date()
      };

      const result = await db.collection("mobile_audit_log").insertOne(crashRecord);

      return c.json({
        success: true,
        message: "Crash analytics recorded successfully!",
        id: result.insertedId
      }, 201);
    });

  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
};



