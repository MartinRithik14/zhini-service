import { withDatabase } from '../utils/config.js';
import { ObjectId } from "mongodb";
import { GoogleGenAI, Type } from "@google/genai";
import { uploadToR2 } from "../services/r2.service.js";
import path from 'path';
import crypto from 'crypto';



const mongoUri = process.env.MONGODB_URI;


export const createHome = async (c) => {
  try {
    const body = await c.req.json().catch(async () => await c.req.parseBody());
    const { name, mobile, address, pincode, homeName } = body;

    if (!mobile) {
      return c.json({
        success: false,
        message: "Missing required field: mobile is required."
      }, 400);
    }

    const cleanMobile = mobile.toString().trim();
    const cleanUserName = (name || "Guest").toString().trim();
    const cleanHomeName = (homeName || "Default Home").toString().trim();
    const cleanAddress = (address || "").toString().trim();
    const cleanPincode = (pincode || "").toString().trim();

    const numMobile = Number(cleanMobile);

    const result = await withDatabase(mongoUri, async (db) => {
      const usersCol = db.collection("users");
      const homesCol = db.collection("homes");

      const now = new Date().toISOString();

      // 1. Upsert / Find user by mobile
      let userDoc = await usersCol.findOne({
        $or: [
          { mobile: cleanMobile },
          { mobile: isNaN(numMobile) ? cleanMobile : numMobile }
        ]
      });

      if (!userDoc) {
        const insertRes = await usersCol.insertOne({
          mobile: cleanMobile,
          name: cleanUserName,
          createdAt: now,
          updatedAt: now
        });
        userDoc = { _id: insertRes.insertedId, mobile: cleanMobile, name: cleanUserName };
      } else if (cleanUserName !== "Guest" && userDoc.name !== cleanUserName) {
        await usersCol.updateOne(
          { _id: userDoc._id },
          { $set: { name: cleanUserName, updatedAt: now } }
        );
      }

      // 2. Check duplicate ONLY if exact same address and homeName already exist for this user
      let existingHome = null;
      if (cleanAddress) {
        existingHome = await homesCol.findOne({
          ownerId: userDoc._id,
          address: cleanAddress,
          homeName: cleanHomeName
        });
      }

      if (existingHome) {
        return { homeId: existingHome._id.toString(), reused: true };
      }

      // 3. Create distinct new Home (Allows user to have multiple homes)
      const homeInsert = await homesCol.insertOne({
        ownerId: userDoc._id,
        homeName: cleanHomeName,
        address: cleanAddress,
        pincode: cleanPincode,
        members: [userDoc._id],
        createdAt: now,
        updatedAt: now
      });

      return { homeId: homeInsert.insertedId.toString(), reused: false };
    });

    return c.json({
      success: true,
      message: result.reused ? "Existing home reused." : "Home created successfully.",
      data: { homeId: result.homeId }
    }, result.reused ? 200 : 201);

  } catch (error) {
    console.error("❌ Create Home Controller Error:", error);
    return c.json({ success: false, message: "Internal Server Error", error: error.message }, 500);
  }
};



export const createProductSubmission = async (c) => {
  try {
    // 1. Parse multipart/form-data request
    const body = await c.req.parseBody();

    const { homeId, name, mobile, roomName, product, brand, warranty } = body;
    const file = body.file; // File object or undefined

    // Validation: homeId, mobile, product, and brand are mandatory
    if (!homeId || !mobile || !product || !brand) {
      return c.json({
        success: false,
        message: "Missing required fields (homeId, mobile, product, brand)."
      }, 400);
    }

    if (!ObjectId.isValid(homeId)) {
      return c.json({ success: false, message: "Invalid homeId format provided." }, 400);
    }

    // 2. Handle Cloudflare R2 Image Upload
    let imageUrl = null;
    if (file && typeof file !== 'string' && file.name) {
      imageUrl = await uploadToR2(file, "product-images");
    }

    const cleanMobile = mobile.trim();
    const cleanName = (name || "Member").trim();
    const targetHomeId = new ObjectId(homeId);
    // If no room specified, default to "default"
    const targetRoomName = (roomName || "default").trim().toLowerCase();

    // 3. Database Operations
    const result = await withDatabase(mongoUri, async (db) => {
      const usersCol = db.collection("users");
      const homesCol = db.collection("homes");
      const roomsCol = db.collection("rooms");
      const devicesCol = db.collection("devices");

      const now = new Date().toISOString();

      // STEP A: Verify Home Exists
      const existingHome = await homesCol.findOne({ _id: targetHomeId });
      if (!existingHome) {
        throw new Error("HOME_NOT_FOUND");
      }

      // STEP B: Upsert User & Link to Home
      const numMobile = Number(cleanMobile);
      const user = await usersCol.findOneAndUpdate(
        {
          $or: [
            { mobile: cleanMobile },
            { mobile: isNaN(numMobile) ? cleanMobile : numMobile }
          ]
        },
        {
          $setOnInsert: {
            name: cleanName,
            mobile: cleanMobile,
            roles: ["member"],
            createdAt: now
          },
          $set: { updatedAt: now }
        },
        { upsert: true, returnDocument: "after" }
      );

      // Link user to home members array
      await homesCol.updateOne(
        { _id: targetHomeId },
        {
          $addToSet: {
            members: user._id,
            memberIds: user._id
          },
          $set: { updatedAt: now }
        }
      );

      // STEP C: Find or Create Room on demand
      let room = await roomsCol.findOne({
        $or: [
          { homeId: targetHomeId },
          { homeId: targetHomeId.toString() }
        ],
        roomName: { $regex: new RegExp(`^${targetRoomName.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&')}$`, 'i') }
      });

      if (!room) {
        const newRoomResult = await roomsCol.insertOne({
          homeId: targetHomeId,
          roomName: targetRoomName,
          createdAt: now,
          updatedAt: now
        });
        room = { _id: newRoomResult.insertedId, roomName: targetRoomName };
      }

      // STEP D: Create Device Entry
      const deviceId = `DEV-${Date.now()}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;

      const newDevice = {
        deviceId: deviceId,
        homeId: targetHomeId,
        roomId: room._id,
        product: product.trim(),
        brand: brand.trim(),
        warranty: warranty || null,
        imageUrl: imageUrl,
        addedByUserId: user._id,
        createdAt: now,
        updatedAt: now
      };

      const deviceInsertResult = await devicesCol.insertOne(newDevice);

      return {
        deviceId: deviceId,
        deviceDbId: deviceInsertResult.insertedId,
        homeId: targetHomeId,
        roomId: room._id,
        roomName: room.roomName,
        userId: user._id
      };
    });

    return c.json({ success: true, message: "Device registered successfully.", data: result }, 200);

  } catch (error) {
    console.error("❌ Product Submission Controller Error:", error);

    if (error.message === "HOME_NOT_FOUND") {
      return c.json({ success: false, message: "No home record found with the provided homeId." }, 404);
    }

    return c.json({ success: false, message: "Internal Server Error", error: error.message }, 500);
  }
};


export const updateEntity = async (c) => {
  try {
    const body = await c.req.json().catch(async () => await c.req.parseBody());

    const {
      homeId,
      name,
      mobile,
      address,
      pincode,
      roomName,
      roomId,
      deviceId,
      product,
      brand,
      warranty
    } = body;

    // Validation: homeId is now the primary root anchor
    if (!homeId) {
      return c.json({
        success: false,
        message: "Missing required field: homeId is required to update details."
      }, 400);
    }

    if (!ObjectId.isValid(homeId)) {
      return c.json({
        success: false,
        message: "Invalid homeId format provided."
      }, 400);
    }

    const targetHomeId = new ObjectId(homeId);

    const result = await withDatabase(mongoUri, async (db) => {
      const homesCol = db.collection("homes");
      const usersCol = db.collection("users");
      const roomsCol = db.collection("rooms");
      const devicesCol = db.collection("devices");

      // 1. Verify Home exists and fetch linked user
      const homeDoc = await homesCol.findOne({ _id: targetHomeId });
      if (!homeDoc) {
        throw new Error("HOME_NOT_FOUND");
      }

      let updatedSummary = {
        homeUpdated: false,
        userUpdated: false,
        roomUpdated: false,
        deviceUpdated: false
      };

      const now = new Date().toISOString();

      // 2. Update Home Collection (Address / Pincode)
      if (address || pincode) {
        const homeUpdates = { updatedAt: now };
        if (address) homeUpdates.address = address.trim();
        if (pincode) homeUpdates.pincode = pincode.trim();

        const homeRes = await homesCol.updateOne(
          { _id: targetHomeId },
          { $set: homeUpdates }
        );
        updatedSummary.homeUpdated = homeRes.modifiedCount > 0;
      }

      // 3. Update User Collection (Name / Mobile)
      const linkedUserId = homeDoc.ownerId || homeDoc.userId || (homeDoc.members && homeDoc.members[0]);
      if (linkedUserId && (name || mobile)) {
        const userUpdates = { updatedAt: now };
        if (name) userUpdates.name = name.trim();
        if (mobile) userUpdates.mobile = mobile.trim();

        const userRes = await usersCol.updateOne(
          { _id: new ObjectId(linkedUserId) },
          { $set: userUpdates }
        );
        updatedSummary.userUpdated = userRes.modifiedCount > 0;
      }

      // 4. Update Room Collection (Rename room for this home)
      if (roomName) {
        const cleanRoomName = roomName.trim().toLowerCase();
        
        let roomQuery = {};
        if (roomId && ObjectId.isValid(roomId)) {
          roomQuery = { _id: new ObjectId(roomId), homeId: targetHomeId };
        } else {
          // If no specific roomId is passed, update the room attached to this homeId
          roomQuery = {
            $or: [
              { homeId: targetHomeId },
              { homeId: targetHomeId.toString() }
            ]
          };
        }

        const roomRes = await roomsCol.updateOne(
          roomQuery,
          { $set: { roomName: cleanRoomName, updatedAt: now } }
        );
        updatedSummary.roomUpdated = roomRes.modifiedCount > 0;
      }

      // 5. Update Device Collection (If device details or deviceId are provided)
      if (deviceId && (product || brand || warranty !== undefined)) {
        const deviceUpdates = { updatedAt: now };
        if (product) deviceUpdates.product = product.trim();
        if (brand) deviceUpdates.brand = brand.trim();
        if (warranty !== undefined) deviceUpdates.warranty = warranty;

        const deviceRes = await devicesCol.updateOne(
          {
            $or: [
              { deviceId: deviceId },
              ObjectId.isValid(deviceId) ? { _id: new ObjectId(deviceId) } : { deviceId: deviceId }
            ],
            homeId: targetHomeId
          },
          { $set: deviceUpdates }
        );
        updatedSummary.deviceUpdated = deviceRes.modifiedCount > 0;
      }

      return updatedSummary;
    });

    return c.json({
      success: true,
      message: "Entities updated successfully across collections.",
      data: result
    }, 200);

  } catch (error) {
    console.error("❌ Update Entity Controller Error:", error);

    if (error.message === "HOME_NOT_FOUND") {
      return c.json({ success: false, message: "No home record found with the provided homeId." }, 404);
    }

    return c.json({ success: false, message: "Internal Server Error", error: error.message }, 500);
  }
};



// Helper function — extracts a 6-digit pincode from an address string
function extractPincodeFromAddress(address) {
  const match = address?.match(/\b\d{6}\b/);
  return match ? match[0] : null;
}

export const addMember = async (c) => {
  try {
    const body = await c.req.json().catch(async () => await c.req.parseBody());
    const { homeId, myMobile, newName, newMobile } = body;

    // 1. Validate required inputs
    if (!homeId || !myMobile || !newMobile || !newName) {
      return c.json({
        success: false,
        message: "Missing fields! homeId, myMobile, newName, and newMobile are required."
      }, 400);
    }

    const cleanHomeId = homeId.toString().trim();
    const cleanMyMobile = myMobile.toString().trim();
    const cleanNewMobile = newMobile.toString().trim();
    const cleanNewName = newName.toString().trim();

    if (!ObjectId.isValid(cleanHomeId)) {
      return c.json({ success: false, message: "Invalid homeId format." }, 400);
    }

    if (cleanMyMobile === cleanNewMobile) {
      return c.json({
        success: false,
        message: "You cannot add your own mobile number as a new member."
      }, 400);
    }

    const targetHomeId = new ObjectId(cleanHomeId);
    const numMyMobile = Number(cleanMyMobile);
    const numNewMobile = Number(cleanNewMobile);

    const result = await withDatabase(mongoUri, async (db) => {
      const usersCol = db.collection("users");
      const homesCol = db.collection("homes");
      const now = new Date().toISOString();

      // A. Verify requester exists
      const requester = await usersCol.findOne({
        $or: [
          { mobile: cleanMyMobile },
          { mobile: isNaN(numMyMobile) ? cleanMyMobile : numMyMobile }
        ]
      });

      if (!requester) {
        return { status: "REQUESTER_NOT_FOUND" };
      }

      // B. Verify home exists AND requester belongs to it
      const targetHome = await homesCol.findOne({
        _id: targetHomeId,
        $or: [
          { ownerId: requester._id },
          { userId: requester._id },
          { members: requester._id },
          { memberIds: requester._id }
        ]
      });

      if (!targetHome) {
        return { status: "HOME_NOT_FOUND" };
      }

      // C. Upsert the new member user in users collection
      let newMemberUser = await usersCol.findOne({
        $or: [
          { mobile: cleanNewMobile },
          { mobile: isNaN(numNewMobile) ? cleanNewMobile : numNewMobile }
        ]
      });

      if (!newMemberUser) {
        const newUserResult = await usersCol.insertOne({
          name: cleanNewName,
          mobile: cleanNewMobile,
          roles: ["member"],
          createdAt: now,
          updatedAt: now
        });
        newMemberUser = { _id: newUserResult.insertedId };
      }

      // D. Check if already a member
      const memberArray = targetHome.members || targetHome.memberIds || [];
      const isAlreadyMember = memberArray.some(
        (id) => id.toString() === newMemberUser._id.toString()
      );

      if (isAlreadyMember) {
        return { status: "ALREADY_EXISTS" };
      }

      // E. Add member's ObjectId to home
      await homesCol.updateOne(
        { _id: targetHomeId },
        {
          $addToSet: {
            members: newMemberUser._id,
            memberIds: newMemberUser._id
          },
          $set: { updatedAt: now }
        }
      );

      return { status: "SUCCESS", newUserId: newMemberUser._id };
    });

    if (result.status === "REQUESTER_NOT_FOUND") {
      return c.json({ success: false, message: "Your user account was not found." }, 404);
    }

    if (result.status === "HOME_NOT_FOUND") {
      return c.json({
        success: false,
        message: "Home not found or you do not have permission to modify this home."
      }, 404);
    }

    if (result.status === "ALREADY_EXISTS") {
      return c.json({
        success: false,
        message: "This mobile number is already added as a member in this household."
      }, 400);
    }

    return c.json({
      success: true,
      message: `${cleanNewName} added successfully!`,
      data: { homeId: cleanHomeId, memberUserId: result.newUserId }
    }, 200);

  } catch (error) {
    console.error("❌ Add Member Controller Error:", error);
    return c.json({ success: false, message: "Internal Server Error", error: error.message }, 500);
  }
};

export const deleteMember = async (c) => {
  try {
    const body = await c.req.json().catch(async () => await c.req.parseBody()).catch(() => ({}));
    const homeIdParam = c.req.param("homeId");
    
    const homeId = homeIdParam || body.homeId;
    const mobile = body.mobile;

    if (!homeId || !mobile) {
      return c.json({
        success: false,
        message: "homeId and mobile are required to remove a member."
      }, 400);
    }

    const cleanHomeId = homeId.toString().trim();
    const cleanMobile = mobile.toString().trim();

    if (!ObjectId.isValid(cleanHomeId)) {
      return c.json({ success: false, message: "Invalid homeId format." }, 400);
    }

    const targetHomeId = new ObjectId(cleanHomeId);
    const numMobile = Number(cleanMobile);

    const result = await withDatabase(mongoUri, async (db) => {
      const usersCol = db.collection("users");
      const homesCol = db.collection("homes");
      const now = new Date().toISOString();

      // 1. Find user by mobile
      const user = await usersCol.findOne({
        $or: [
          { mobile: cleanMobile },
          { mobile: isNaN(numMobile) ? cleanMobile : numMobile }
        ]
      });

      if (!user) {
        return { status: "USER_NOT_FOUND" };
      }

      // 2. Fetch home to verify owner guardrail
      const home = await homesCol.findOne({ _id: targetHomeId });
      if (!home) {
        return { status: "HOME_NOT_FOUND" };
      }

      // Prevent removing the primary owner
      if (home.ownerId && home.ownerId.toString() === user._id.toString()) {
        return { status: "CANNOT_REMOVE_OWNER" };
      }

      // 3. Pull user ObjectId from members & memberIds arrays
      const updateRes = await homesCol.updateOne(
        { _id: targetHomeId },
        {
          $pull: {
            members: user._id,
            memberIds: user._id
          },
          $set: { updatedAt: now }
        }
      );

      if (updateRes.modifiedCount === 0) {
        return { status: "MEMBER_NOT_IN_HOME" };
      }

      return { status: "SUCCESS" };
    });

    if (result.status === "USER_NOT_FOUND" || result.status === "MEMBER_NOT_IN_HOME") {
      return c.json({ success: false, message: "Member not found in this home." }, 404);
    }

    if (result.status === "HOME_NOT_FOUND") {
      return c.json({ success: false, message: "Home record not found." }, 404);
    }

    if (result.status === "CANNOT_REMOVE_OWNER") {
      return c.json({ success: false, message: "Primary owner cannot be removed from the home." }, 400);
    }

    return c.json({
      success: true,
      message: "Member removed from household successfully."
    }, 200);

  } catch (error) {
    console.error("❌ Delete Member Controller Error:", error);
    return c.json({ success: false, message: "Internal Server Error", error: error.message }, 500);
  }
};

export const deleteRoomProduct = async (c) => {
  const homeId = c.req.param('homeId');
  const { roomName, product } = await c.req.json(); // e.g., roomName: "kitchen", product: "Laptop"

  const result = await withDatabase(mongoUri, async (db) => {
    return await db.collection('homes').updateOne(
      { _id: new ObjectId(homeId) },
      {
        $pull: {
          [`rooms.${roomName}`]: { product: product } // Dynamic key for room (e.g., rooms.kitchen)
        },
        $set: { updatedAt: new Date().toISOString() }
      }
    );
  });

  if (result.modifiedCount === 0) {
    return c.json({ success: false, message: 'Home, room, or product not found' }, 404);
  }

  return c.json({ success: true, message: 'Product deleted successfully' });
};


const GEMINI_KEYS = [
  process.env.KEY_1,
  process.env.KEY_2,
  process.env.KEY_3,
].filter(Boolean);

let currentGeminiKeyIndex = 0;

export const AIassist = async (c) => {
  try {
    const { imageBase64, mimeType = "image/jpeg" } = await c.req.json();

    if (!imageBase64) {
      return c.json({ success: false, message: "No imageBase64 provided" }, 400);
    }

    if (GEMINI_KEYS.length === 0) {
      return c.json({ success: false, message: "No API keys configured" }, 500);
    }

    const promptText =
      "Identify the appliance in this image. Return ONLY a raw JSON object with exactly two keys: 'brand' and 'product'. Example: {\"brand\": \"Samsung\", \"product\": \"Washing Machine\"}";

    let responseText;
    let geminiAttempts = 0;

    // Cycle through available Gemini API keys on failure
    while (geminiAttempts < GEMINI_KEYS.length) {
      const apiKey = GEMINI_KEYS[currentGeminiKeyIndex];

      try {
        console.log(`🤖 Attempting Gemini execution with Key index: ${currentGeminiKeyIndex}`);
        const ai = new GoogleGenAI({ apiKey });

        const response = await ai.models.generateContent({
          model: "gemini-2.5-flash",
          contents: [
            {
              inlineData: {
                mimeType: mimeType,
                data: imageBase64,
              },
            },
            promptText, // Text prompt passed alongside inlineData
          ],
          config: {
            responseMimeType: "application/json",
          },
        });

        responseText = response.text;
        console.log("✅ Gemini execution successful!");
        break; // Exit loop on success
      } catch (err) {
        console.warn(`⚠️ Gemini key index ${currentGeminiKeyIndex} failed: ${err.message}. Rotating key...`);
        geminiAttempts++;
        currentGeminiKeyIndex = (currentGeminiKeyIndex + 1) % GEMINI_KEYS.length;
      }
    }

    // Exhausted all key attempts
    if (!responseText) {
      return c.json(
        { success: false, message: "All Gemini API keys failed or quota exceeded." },
        429
      );
    }

    // Safely parse JSON response
    const cleanedText = responseText.replace(/```json|```/g, "").trim();
    const parsedResult = JSON.parse(cleanedText);

    return c.json({
      success: true,
      data: parsedResult,
    });
  } catch (error) {
    console.error("❌ AI Assist Error:", error.message);
    return c.json(
      { success: false, message: "Failed to identify product from image", error: error.message },
      500
    );
  }
};

export const getSubmissionByMobile = async (c) => {
  try {
    const mobile = c.req.query("mobile");

    if (!mobile) {
      return c.json({
        success: false,
        message: "Mobile number is required as a query parameter."
      }, 400);
    }

    const cleanMobile = mobile.trim();
    const numMobile = Number(cleanMobile);

    const homes = await withDatabase(mongoUri, async (db) => {
      // 1. Fetch User by Mobile
      const user = await db.collection("users").findOne({
        $or: [
          { mobile: cleanMobile },
          { mobile: isNaN(numMobile) ? cleanMobile : numMobile }
        ]
      });

      if (!user) {
        return [];
      }

      const userIdStr = user._id.toString();
      const userIdObj = user._id instanceof ObjectId ? user._id : new ObjectId(user._id);

      // 2. Aggregate Homes
      const rawHomes = await db.collection("homes").aggregate([
        // Match candidates
        {
          $match: {
            $or: [
              {
                $expr: {
                  $let: {
                    vars: { safeMembers: { $ifNull: ["$members", []] } },
                    in: {
                      $or: [
                        { $in: [userIdObj, "$$safeMembers"] },
                        { $in: [userIdStr, "$$safeMembers"] }
                      ]
                    }
                  }
                }
              },
              { userId: userIdObj },
              { userId: userIdStr },
              { ownerId: userIdObj },
              { ownerId: userIdStr },
              { createdBy: userIdObj },
              { createdBy: userIdStr },
              { mobile: cleanMobile },
              { mobile: isNaN(numMobile) ? cleanMobile : numMobile }
            ]
          }
        },

        // ★ Primary uniqueness: always group by real document _id
        {
          $group: {
            _id: "$_id",
            doc: { $first: "$$ROOT" }
          }
        },
        {
          $replaceRoot: {
            newRoot: "$doc"
          }
        },

        // Optional secondary collapse by name (only useful if you still have
        // dirty test documents that share a name but have different _ids)
        {
          $group: {
            _id: { $ifNull: ["$name", "$_id"] },
            doc: { $first: "$$ROOT" }
          }
        },
        {
          $replaceRoot: {
            newRoot: "$doc"
          }
        },

        // Prepare ID variants for joins
        {
          $addFields: {
            homeIdVariants: ["$_id", { $toString: "$_id" }]
          }
        },

        // Join Users
        {
          $lookup: {
            from: "users",
            let: { memberList: { $ifNull: ["$members", []] } },
            pipeline: [
              {
                $match: {
                  $expr: {
                    $or: [
                      { $in: ["$_id", "$$memberList"] },
                      { $in: [{ $toString: "$_id" }, "$$memberList"] }
                    ]
                  }
                }
              },
              { $project: { createdAt: 0, updatedAt: 0 } }
            ],
            as: "members"
          }
        },

        // Join Rooms
        {
          $lookup: {
            from: "rooms",
            let: { hVariants: "$homeIdVariants" },
            pipeline: [
              {
                $match: {
                  $expr: { $in: ["$homeId", "$$hVariants"] }
                }
              }
            ],
            as: "rooms"
          }
        },

        // Join Devices
        {
          $lookup: {
            from: "devices",
            let: { hVariants: "$homeIdVariants" },
            pipeline: [
              {
                $match: {
                  $expr: { $in: ["$homeId", "$$hVariants"] }
                }
              }
            ],
            as: "devices"
          }
        },

        // Nest Devices into Rooms
        {
          $addFields: {
            rooms: {
              $map: {
                input: "$rooms",
                as: "room",
                in: {
                  $mergeObjects: [
                    "$$room",
                    {
                      devices: {
                        $filter: {
                          input: "$devices",
                          as: "device",
                          cond: {
                            $or: [
                              { $eq: ["$$device.roomId", "$$room._id"] },
                              {
                                $eq: [
                                  { $toString: "$$device.roomId" },
                                  { $toString: "$$room._id" }
                                ]
                              }
                            ]
                          }
                        }
                      }
                    }
                  ]
                }
              }
            }
          }
        },

        {
          $project: {
            homeIdVariants: 0,
            devices: 0
          }
        }
      ]).toArray();

      // Final safety net – key purely by _id
      const uniqueMap = new Map();
      for (const home of rawHomes) {
        const key = home._id.toString();
        if (!uniqueMap.has(key)) {
          uniqueMap.set(key, home);
        }
      }

      return Array.from(uniqueMap.values());
    });

    if (!homes || homes.length === 0) {
      return c.json({
        success: false,
        message: "No household records found for this mobile number.",
        count: 0,
        data: []
      }, 404);
    }

    return c.json({
      success: true,
      message: `Found ${homes.length} household(s) associated with this request.`,
      count: homes.length,
      data: homes
    }, 200);

  } catch (error) {
    console.error("❌ Get Submission Controller Error:", error);
    return c.json({
      success: false,
      message: "Internal Server Error",
      error: error.message
    }, 500);
  }
};