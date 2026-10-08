import { withDatabase } from '../utils/config.js';
import { ObjectId } from "mongodb";
import { GoogleGenAI } from "@google/genai";
import { uploadToR2 } from "../services/r2.service.js";
import { verifyFirebaseToken } from '../utils/firebase.js';
import crypto from 'crypto';



const mongoUri = process.env.MONGODB_URI;

export const syncUserSession = async (c) => {
  try {
    const incomingSecurityToken =
      c.req.header("x-auth-token") ||
      c.req.header("Authorization")?.replace(/^Bearer\s+/i, "");
    const headerDeviceId = c.req.header("x-device-id");

    const body = await c.req.json().catch(() => ({}));
    const rawMobile = body.mobile || body.UserInfo?.phoneNo || body.phoneNo;
    const incomingDevice = body.PlatformInfo?.devices?.[0] || body.PlatformInfo?.device || body.device;
    const deviceId = headerDeviceId || incomingDevice?.deviceId || body.deviceId;

    if (!incomingSecurityToken) {
      return c.json({ success: false, error: "Unauthorized: Missing security token" }, 401);
    }
    if (!rawMobile) {
      return c.json({ success: false, message: "Missing required field: mobile is required." }, 400);
    }
    if (!deviceId) {
      return c.json({ success: false, message: "Device ID is required." }, 400);
    }

    // Verify the refreshed Firebase token
    try {
      await verifyFirebaseToken(incomingSecurityToken);
    } catch (authError) {
      return c.json({
        success: false,
        error: "Unauthorized: Invalid or expired Firebase security token.",
        details: authError.message
      }, 401);
    }

    const cleanMobile = rawMobile.toString().trim();
    const numMobile = Number(cleanMobile);
    const now = new Date().toISOString();

    return await withDatabase(process.env.MONGODB_URI, async (db) => {
      const usersCol = db.collection("users");

      const existingUser = await usersCol.findOne({
        $or: [
          { mobile: cleanMobile },
          { mobile: isNaN(numMobile) ? cleanMobile : numMobile },
          { "UserInfo.phoneNo": cleanMobile }
        ]
      });

      if (!existingUser) {
        return c.json({ success: false, message: "User profile not found. Please create home/register first." }, 404);
      }

      let currentDevicesList =
        existingUser["PlatformInfo.devices"] ||
        existingUser.PlatformInfo?.devices ||
        [];

      let deviceFound = false;

      currentDevicesList = currentDevicesList.map((d) => {
        if (d.deviceId === deviceId) {
          deviceFound = true;
          return {
            ...d,
            os: incomingDevice?.os || body.os || d.os || "Unknown",
            version: incomingDevice?.version || body.version || d.version || "Unknown",
            authToken: incomingSecurityToken,
            fcmToken: incomingDevice?.fcmToken || body.fcmToken || d.fcmToken || null,
            lastUsedAt: now,
            isLastLoggedIn: true
          };
        }
        return {
          ...d,
          isLastLoggedIn: false
        };
      });

      if (!deviceFound) {
        currentDevicesList.push({
          deviceId: deviceId,
          os: incomingDevice?.os || body.os || "Unknown",
          version: incomingDevice?.version || body.version || "Unknown",
          authToken: incomingSecurityToken,
          fcmToken: incomingDevice?.fcmToken || body.fcmToken || null,
          lastUsedAt: now,
          isLastLoggedIn: true
        });
      }

      await usersCol.updateOne(
        { _id: existingUser._id },
        {
          $set: {
            "PlatformInfo.devices": currentDevicesList,
            updatedAt: now
          }
        }
      );

      return c.json({
        success: true,
        message: "Session token updated successfully."
      }, 200);
    });

  } catch (err) {
    console.error("❌ Sync User Session Error:", err);
    return c.json({ success: false, error: "Internal Server Error", details: err.message }, 500);
  }
};



export const createHome = async (c) => {
  try {
    // 1. Capture transit security headers
    const incomingSecurityToken =
      c.req.header("x-auth-token") ||
      c.req.header("Authorization")?.replace(/^Bearer\s+/i, "");
    const headerDeviceId = c.req.header("x-device-id");

    const body = await c.req.json().catch(async () => await c.req.parseBody());
    const { name, mobile, address, pincode, homeName, UserInfo, PlatformInfo, AppInfo } = body;

    const rawMobile = mobile || UserInfo?.phoneNo || UserInfo?.mobile;
    const incomingDevice = PlatformInfo?.devices?.[0] || PlatformInfo?.device;
    const deviceId = headerDeviceId || incomingDevice?.deviceId;

    // 2. Input Validations
    if (!incomingSecurityToken) {
      return c.json({ success: false, error: "Unauthorized: No security token provided in headers" }, 401);
    }
    if (!rawMobile) {
      return c.json({ success: false, message: "Missing required field: mobile is required." }, 400);
    }
    if (!deviceId) {
      return c.json({ success: false, message: "Device ID is required for session tracking." }, 400);
    }

    // 3. Verify Firebase Auth Token
    let decodedToken;
    try {
      decodedToken = await verifyFirebaseToken(incomingSecurityToken);
    } catch (authError) {
      return c.json({
        success: false,
        error: "Unauthorized: Invalid or expired Firebase security token.",
        details: authError.message
      }, 401);
    }

    const cleanMobile = rawMobile.toString().trim();
    const cleanUserName = (name || UserInfo?.name || decodedToken.name || "Guest").toString().trim();
    const cleanHomeName = (homeName || "Default Home").toString().trim();
    const cleanAddress = (address || "").toString().trim();
    const cleanPincode = (pincode || "").toString().trim();
    const numMobile = Number(cleanMobile);

    const result = await withDatabase(process.env.MONGODB_URI, async (db) => {
      const usersCol = db.collection("users");
      const homesCol = db.collection("homes");

      const now = new Date().toISOString();

      // 4. Find existing user
      let userDoc = await usersCol.findOne({
        $or: [
          { mobile: cleanMobile },
          { mobile: isNaN(numMobile) ? cleanMobile : numMobile },
          { "UserInfo.phoneNo": cleanMobile }
        ]
      });

      // 5. Multi-Device Session Management (PlatformInfo.devices)
      let currentDevicesList =
        userDoc?.["PlatformInfo.devices"] ||
        userDoc?.PlatformInfo?.devices ||
        [];

      let deviceFound = false;

      currentDevicesList = currentDevicesList.map((d) => {
        if (d.deviceId === deviceId) {
          deviceFound = true;
          return {
            ...d,
            os: incomingDevice?.os || d.os || "Unknown",
            version: incomingDevice?.version || d.version || "Unknown",
            authToken: incomingSecurityToken,
            fcmToken: incomingDevice?.fcmToken || d.fcmToken || UserInfo?.fcmToken || null,
            lastUsedAt: now,
            isLastLoggedIn: true
          };
        }
        return {
          ...d,
          isLastLoggedIn: false
        };
      });

      if (!deviceFound) {
        currentDevicesList.push({
          deviceId: deviceId,
          os: incomingDevice?.os || "Unknown",
          version: incomingDevice?.version || "Unknown",
          authToken: incomingSecurityToken,
          fcmToken: incomingDevice?.fcmToken || UserInfo?.fcmToken || null,
          lastUsedAt: now,
          isLastLoggedIn: true
        });
      }

      // 6. Build User Update / Upsert Payload
      const setFields = {
        name: cleanUserName,
        mobile: cleanMobile,
        updatedAt: now,
        "PlatformInfo.devices": currentDevicesList,
        "UserInfo.name": cleanUserName,
        "UserInfo.phoneNo": cleanMobile,
        "UserInfo.role": userDoc?.["UserInfo.role"] || userDoc?.UserInfo?.role || UserInfo?.role || "user"
      };

      if (AppInfo) {
        setFields.AppInfo = AppInfo;
      }

      const user = await usersCol.findOneAndUpdate(
        {
          $or: [
            { mobile: cleanMobile },
            { mobile: isNaN(numMobile) ? cleanMobile : numMobile }
          ]
        },
        {
          $set: setFields,
          $setOnInsert: {
            createdAt: now
          }
        },
        { upsert: true, returnDocument: "after" }
      );

      const userId = user._id;

      // 7. Check for duplicate home
      let existingHome = null;
      if (cleanAddress) {
        existingHome = await homesCol.findOne({
          ownerId: userId,
          address: cleanAddress,
          homeName: cleanHomeName
        });
      }

      if (existingHome) {
        return { homeId: existingHome._id.toString(), reused: true, userId };
      }

      // 8. Create Home
      const homeInsert = await homesCol.insertOne({
        ownerId: userId,
        homeName: cleanHomeName,
        address: cleanAddress,
        pincode: cleanPincode,
        members: [userId],
        memberIds: [userId],
        createdAt: now,
        updatedAt: now
      });

      return { homeId: homeInsert.insertedId.toString(), reused: false, userId };
    });

    return c.json({
      success: true,
      message: result.reused ? "Existing home reused." : "Home created successfully.",
      data: {
        homeId: result.homeId,
        userId: result.userId
      }
    }, result.reused ? 200 : 201);

  } catch (error) {
    console.error("❌ Create Home Controller Error:", error);
    return c.json({ success: false, message: "Internal Server Error", error: error.message }, 500);
  }
};

export const createProductSubmission = async (c) => {
  try {
    // 1. Get authenticated user resolved from requireAuth middleware
    const currentUser = c.get("user");
    const userId = currentUser._id;
    const cleanMobile = currentUser.mobile || currentUser?.UserInfo?.phoneNo;

    // 2. Parse multipart/form-data request
    const body = await c.req.parseBody();
    const { homeId, roomName, product, brand, warranty } = body;
    const file = body.file; // Uploaded File object or undefined

    // 3. Validation
    if (!homeId || !product || !brand) {
      return c.json({
        success: false,
        message: "Missing required fields: homeId, product, and brand are mandatory."
      }, 400);
    }

    if (!ObjectId.isValid(homeId)) {
      return c.json({
        success: false,
        message: "Invalid homeId format provided."
      }, 400);
    }

    const cleanHomeId = homeId.toString().trim();
    const targetHomeId = new ObjectId(cleanHomeId);
    const targetRoomName = (roomName || "Default Room").toString().trim();

    // 4. Handle Cloudflare R2 Image Upload
    let imageUrl = null;
    if (file && typeof file !== "string" && file.name) {
      imageUrl = await uploadToR2(file, {
        homeId: cleanHomeId,
        folder: "product-images"
      });
    }

    // 5. Database Operations
    const result = await withDatabase(mongoUri, async (db) => {
      const homesCol = db.collection("homes");
      const roomsCol = db.collection("rooms");
      const devicesCol = db.collection("devices");

      const now = new Date().toISOString();

      // STEP A: Verify Home Exists
      const existingHome = await homesCol.findOne({ _id: targetHomeId });
      if (!existingHome) {
        throw new Error("HOME_NOT_FOUND");
      }

      // Ensure user is in home's member list
      await homesCol.updateOne(
        { _id: targetHomeId },
        {
          $addToSet: {             members: userId,             memberIds: userId           },$set: { updatedAt: now }
        }
      );

      // STEP B: Find or Create Room on Demand
      const escapedRoomName = targetRoomName.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, "\\$&");
      let room = await roomsCol.findOne({
        $or: [
          { homeId: targetHomeId },
          { homeId: targetHomeId.toString() }
        ],
        roomName: { $regex: new RegExp(`^${escapedRoomName}$`, "i") }
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

      // STEP C: Create Device Record
      const newDeviceId = `DEV-${Date.now()}-${crypto.randomBytes(2).toString("hex").toUpperCase()}`;

      const newDevice = {
        deviceId: newDeviceId,
        homeId: targetHomeId,
        roomId: room._id,
        product: product.toString().trim(),
        brand: brand.toString().trim(),
        warranty: warranty || null,
        imageUrl: imageUrl,
        addedByUserId: userId,
        addedByUserMobile: cleanMobile,
        createdAt: now,
        updatedAt: now
      };

      const deviceInsertResult = await devicesCol.insertOne(newDevice);

      return {
        deviceId: newDeviceId,
        deviceDbId: deviceInsertResult.insertedId,
        homeId: targetHomeId,
        roomId: room._id,
        roomName: room.roomName,
        userId: userId,
        imageUrl: imageUrl
      };
    });

    return c.json({
      success: true,
      message: "Device registered successfully.",
      data: result
    }, 200);

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
    // 🛡️ 1. Enforce authenticated session context
    const currentUser = c.get("user");
    if (!currentUser) {
      return c.json({ success: false, message: "Unauthorized: Active session required." }, 401);
    }
    const currentUserId = currentUser._id;

    const body = await c.req.json().catch(async () => await c.req.parseBody());

    const {
      homeId,
      homeName,
      address,
      pincode,
      name,
      mobile,
      roomId,
      roomName,
      deviceId,
      product,
      brand,
      warranty
    } = body;

    // 2. Validate mandatory root anchor
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

    const cleanHomeIdStr = homeId.toString().trim();
    const targetHomeId = new ObjectId(cleanHomeIdStr);

    const result = await withDatabase(process.env.MONGODB_URI, async (db) => {
      const homesCol = db.collection("homes");
      const usersCol = db.collection("users");
      const roomsCol = db.collection("rooms");
      const devicesCol = db.collection("devices");

      // 3. Verify Home exists AND ensure current user is an owner or member
      const homeDoc = await homesCol.findOne({
        _id: targetHomeId,
        $or: [
          { ownerId: currentUserId },
          { members: currentUserId },
          { memberIds: currentUserId }
        ]
      });

      if (!homeDoc) {
        throw new Error("HOME_FORBIDDEN_OR_NOT_FOUND");
      }

      const updatedSummary = {
        homeUpdated: false,
        userUpdated: false,
        roomUpdated: false,
        roomCreated: false,
        createdRoomId: null,
        deviceUpdated: false
      };

      const now = new Date().toISOString();

      // 4. Update Home Details
      if (homeName !== undefined || address !== undefined || pincode !== undefined) {
        const homeUpdates = { updatedAt: now };
        if (homeName !== undefined) homeUpdates.homeName = homeName.toString().trim();
        if (address !== undefined) homeUpdates.address = address.toString().trim();
        if (pincode !== undefined) homeUpdates.pincode = pincode.toString().trim();

        const homeRes = await homesCol.updateOne(
          { _id: targetHomeId },
          { $set: homeUpdates }
        );
        updatedSummary.homeUpdated = homeRes.modifiedCount > 0;
      }

      // 5. Update User Profile Details (for the authenticated user)
      if (name !== undefined || mobile !== undefined) {
        const userUpdates = { updatedAt: now };

        if (name !== undefined) {
          const cleanName = name.toString().trim();
          userUpdates.name = cleanName;
          userUpdates["UserInfo.name"] = cleanName;
        }

        if (mobile !== undefined) {
          const cleanMobile = mobile.toString().trim();
          userUpdates.mobile = cleanMobile;
          userUpdates["UserInfo.phoneNo"] = cleanMobile;
        }

        const userQuery = ObjectId.isValid(currentUserId)
          ? { _id: new ObjectId(currentUserId) }
          : { _id: currentUserId };

        const userRes = await usersCol.updateOne(
          userQuery,
          { $set: userUpdates }
        );
        updatedSummary.userUpdated = userRes.modifiedCount > 0;
      }

      // 6. Room Management: Update existing OR Add new Room
      if (roomName) {
        const cleanRoomName = roomName.toString().trim();
        let existingRoom = null;

        if (roomId && ObjectId.isValid(roomId)) {
          existingRoom = await roomsCol.findOne({
            _id: new ObjectId(roomId.toString().trim()),
            $or: [{ homeId: targetHomeId }, { homeId: cleanHomeIdStr }]
          });
        } else {
          const escapedName = cleanRoomName.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, "\\$&");
          existingRoom = await roomsCol.findOne({
            $or: [{ homeId: targetHomeId }, { homeId: cleanHomeIdStr }],
            roomName: { $regex: new RegExp(`^${escapedName}$`, "i") }
          });
        }

        if (existingRoom) {
          const roomRes = await roomsCol.updateOne(
            { _id: existingRoom._id },
            { $set: { roomName: cleanRoomName, updatedAt: now } }
          );
          updatedSummary.roomUpdated = roomRes.modifiedCount > 0;
        } else {
          const insertRoomRes = await roomsCol.insertOne({
            homeId: targetHomeId,
            roomName: cleanRoomName,
            createdAt: now,
            updatedAt: now
          });
          updatedSummary.roomCreated = true;
          updatedSummary.createdRoomId = insertRoomRes.insertedId.toString();
        }
      }

      // 7. Update Device Details (Bug fixed: Wrapped in $and to prevent duplicate$or key collision)
      if (deviceId && (product !== undefined || brand !== undefined || warranty !== undefined)) {
        const deviceUpdates = { updatedAt: now };
        if (product !== undefined) deviceUpdates.product = product.toString().trim();
        if (brand !== undefined) deviceUpdates.brand = brand.toString().trim();
        if (warranty !== undefined) deviceUpdates.warranty = warranty;

        const cleanDeviceIdStr = deviceId.toString().trim();

        const deviceFilter = {
          $and: [
            {
              $or: [
                { deviceId: cleanDeviceIdStr },
                ...(ObjectId.isValid(cleanDeviceIdStr) ? [{ _id: new ObjectId(cleanDeviceIdStr) }] : [])
              ]
            },
            {
              $or: [
                { homeId: targetHomeId },
                { homeId: cleanHomeIdStr }
              ]
            }
          ]
        };

        const deviceRes = await devicesCol.updateOne(
          deviceFilter,
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

    if (error.message === "HOME_FORBIDDEN_OR_NOT_FOUND") {
      return c.json({
        success: false,
        message: "Home record not found or you do not have permission to modify it."
      }, 403);
    }

    return c.json({ success: false, message: "Internal Server Error", error: error.message }, 500);
  }
};



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

      // C. Upsert the new member user in users collection matching schema standard
      const newMemberUser = await usersCol.findOneAndUpdate(
        {
          $or: [
            { mobile: cleanNewMobile },
            { mobile: isNaN(numNewMobile) ? cleanNewMobile : numNewMobile }
          ]
        },
        {
          $setOnInsert: {
            name: cleanNewName,
            mobile: cleanNewMobile,
            createdAt: now,
            UserInfo: {
              name: cleanNewName,
              phoneNo: cleanNewMobile,
              role: "member"
            },
            PlatformInfo: {
              devices: []
            }
          },
          $set: { updatedAt: now }
        },
        { upsert: true, returnDocument: "after" }
      );

      // D. Check if already a member in this home
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

export const deleteRoom = async (c) => {
  try {
    // 1. Extract params/body
    const paramRoomId = c.req.param("roomId");
    const body = await c.req.json().catch(async () => await c.req.parseBody().catch(() => ({})));
    const targetRoomId = paramRoomId || body?.roomId;
    const targetHomeId = body?.homeId;

    // 2. Input Validations
    if (!targetRoomId) {
      return c.json({
        success: false,
        message: "Missing required field: roomId is required to delete a room."
      }, 400);
    }

    if (!ObjectId.isValid(targetRoomId)) {
      return c.json({
        success: false,
        message: "Invalid roomId format provided."
      }, 400);
    }

    if (targetHomeId && !ObjectId.isValid(targetHomeId)) {
      return c.json({
        success: false,
        message: "Invalid homeId format provided."
      }, 400);
    }

    const roomObjectId = new ObjectId(targetRoomId);

    // 3. Database Execution
    const result = await withDatabase(mongoUri, async (db) => {
      const roomsCol = db.collection("rooms");
      const homesCol = db.collection("homes");
      const devicesCol = db.collection("devices");

      // Verify room exists (optionally scoped to homeId if provided)
      const roomQuery = { _id: roomObjectId };
      if (targetHomeId) {
        const homeObjectId = new ObjectId(targetHomeId);
        roomQuery.$or = [
          { homeId: homeObjectId },
          { homeId: targetHomeId.toString() }
        ];
      }

      const roomDoc = await roomsCol.findOne(roomQuery);
      if (!roomDoc) {
        throw new Error("ROOM_NOT_FOUND");
      }

      const linkedHomeId = roomDoc.homeId;

      // Unlink room reference from parent home document if stored in an array
      if (linkedHomeId) {
        const homeQuery = ObjectId.isValid(linkedHomeId)
          ? { _id: new ObjectId(linkedHomeId) }
          : { _id: linkedHomeId };

        await homesCol.updateOne(homeQuery, {
          $pull: {
            rooms: {
              $in: [roomObjectId, targetRoomId.toString()]
            }
          },
          $set: { updatedAt: new Date().toISOString() }
        });
      }

      // Cleanup associated devices inside this room (unassign room or cascade)
      const deviceCleanupRes = await devicesCol.updateMany(
        {
          $or: [
            { roomId: roomObjectId },
            { roomId: targetRoomId.toString() }
          ]
        },
        {
          $unset: { roomId: "" },
          $set: { updatedAt: new Date().toISOString() }
        }
      );

      // Delete the room document
      const deleteRes = await roomsCol.deleteOne({ _id: roomObjectId });

      return {
        deleted: deleteRes.deletedCount > 0,
        roomId: targetRoomId,
        homeId: linkedHomeId ? linkedHomeId.toString() : null,
        unlinkedDevicesCount: deviceCleanupRes.modifiedCount
      };
    });

    return c.json({
      success: true,
      message: "Room deleted successfully.",
      data: result
    }, 200);

  } catch (error) {
    console.error("❌ Delete Room Controller Error:", error);

    if (error.message === "ROOM_NOT_FOUND") {
      return c.json({
        success: false,
        message: "No room record found with the provided roomId."
      }, 404);
    }

    return c.json({
      success: false,
      message: "Internal Server Error",
      error: error.message
    }, 500);
  }
};


const FREE_GEMINI_KEYS = [
  process.env.KEY_1,
  process.env.KEY_2,
  process.env.KEY_3,
].filter(Boolean);

let currentFreeKeyIndex = 0;

// 2. Production Master Pay-As-You-Go Key
const MASTER_GEMINI_KEY = process.env.GEMINI_MASTER_KEY;

// 3. Whitelisted Test Mobile Numbers (Normalized 10 digits)
const TEST_NUMBERS = new Set([
  "1111111111",
  "2222222222",
  "3333333333",
  "4444444444",
  "5555555555",
  "9999999999"
]);

export const AIassist = async (c) => {
  try {
    const { imageBase64, mimeType = "image/jpeg", mobile: bodyMobile } = await c.req.json();

    if (!imageBase64) {
      return c.json({ success: false, message: "No imageBase64 provided" }, 400);
    }

    // 4. Resolve and normalize caller's phone number
    const currentUser = c.get("user");
    const rawMobile =
      currentUser?.mobile ||
      currentUser?.UserInfo?.phoneNo ||
      c.get("userMobile") ||
      c.req.header("x-user-phone") ||
      c.req.header("x-phone-no") ||
      bodyMobile ||
      "";

    // Strip out non-digit characters and standard prefixes (e.g. +91 or leading 0)
    const cleanMobile = rawMobile
      .toString()
      .replace(/\D/g, "")
      .replace(/^91(?=\d{10}$)/, "");

    const isTestUser = TEST_NUMBERS.has(cleanMobile);

    const promptText =
      "Identify the appliance in this image. Return ONLY a raw JSON object with exactly two keys: 'brand' and 'product'. Example: {\"brand\": \"Samsung\", \"product\": \"Washing Machine\"}";

    let responseText;

    // -------------------------------------------------------------
    // SCENARIO A: REAL / PRODUCTION USER -> Master Key (Pay-As-You-Go)
    // -------------------------------------------------------------
    if (!isTestUser) {
      if (!MASTER_GEMINI_KEY) {
        console.error("❌ Master Gemini API key is missing from environment variables.");
        return c.json({ success: false, message: "Service temporarily unavailable: Master API key not configured." }, 500);
      }

      console.log(`💳 Production User (${cleanMobile || "Unknown"}): Routing to Pay-As-You-Go Master Key`);
      const ai = new GoogleGenAI({ apiKey: MASTER_GEMINI_KEY });

      const response = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: [
          {
            inlineData: {
              mimeType: mimeType,
              data: imageBase64,
            },
          },
          promptText,
        ],
        config: {
          responseMimeType: "application/json",
        },
      });

      responseText = response.text;
    } 
    // -------------------------------------------------------------
    // SCENARIO B: TEST USER (1111111111 - 5555555555) -> Rotating Free Keys
    // -------------------------------------------------------------
    else {
      if (FREE_GEMINI_KEYS.length === 0) {
        return c.json({ success: false, message: "No free-tier testing API keys configured" }, 500);
      }

      console.log(`🧪 Test User (${cleanMobile}): Routing to Free-Tier Rotating Keys`);
      let geminiAttempts = 0;

      while (geminiAttempts < FREE_GEMINI_KEYS.length) {
        const apiKey = FREE_GEMINI_KEYS[currentFreeKeyIndex];

        try {
          console.log(`🤖 Attempting Free Gemini Key at index: ${currentFreeKeyIndex}`);
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
              promptText,
            ],
            config: {
              responseMimeType: "application/json",
            },
          });

          responseText = response.text;
          console.log("✅ Free Gemini Key execution successful!");
          break; // Exit loop on success
        } catch (err) {
          console.warn(`⚠️️ Free Gemini key index ${currentFreeKeyIndex} failed: ${err.message}. Rotating key...`);
          geminiAttempts++;
          currentFreeKeyIndex = (currentFreeKeyIndex + 1) % FREE_GEMINI_KEYS.length;
        }
      }

      if (!responseText) {
        return c.json(
          { success: false, message: "All free Gemini API keys failed or quota exceeded." },
          429
        );
      }
    }

    // 5. Parse and return result
    const cleanedText = responseText.replace(/```json|```/g, "").trim();
    const parsedResult = JSON.parse(cleanedText);

    return c.json({
      success: true,
      data: parsedResult,
    }, 200);

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



export const shiftDevices = async (c) => {
  try {
    // 1. Authenticated user from requireAuth middleware
    const currentUser = c.get("user");
    if (!currentUser) {
      return c.json({ success: false, message: "Unauthorized: Active session required." }, 401);
    }
    const currentUserId = currentUser._id;

    // 2. Parse request body
    const body = await c.req.json().catch(async () => await c.req.parseBody());
    const {
      deviceIds,        // Array of deviceId strings (e.g., ["DEV-..."]) or string ObjectId
      sourceRoomId,     // Optional: Shift all devices from this room
      sourceHomeId,     // Optional: Shift all devices from this home
      targetHomeId,     // Required: Target home
      targetRoomId,     // Optional: Specific destination room ID
      targetRoomName    // Optional: Target room name (finds or auto-creates room)
    } = body;

    // 3. Validation
    if (!targetHomeId || !ObjectId.isValid(targetHomeId)) {
      return c.json({ success: false, message: "A valid targetHomeId is required." }, 400);
    }

    const hasSpecificDevices = Array.isArray(deviceIds) && deviceIds.length > 0;
    const hasSourceScope = Boolean(sourceRoomId || sourceHomeId);

    if (!hasSpecificDevices && !hasSourceScope) {
      return c.json({
        success: false,
        message: "Specify either 'deviceIds' array, 'sourceRoomId', or 'sourceHomeId' to shift."
      }, 400);
    }

    const cleanTargetHomeId = new ObjectId(targetHomeId.toString().trim());

    // 4. Database Operations
    const result = await withDatabase(process.env.MONGODB_URI, async (db) => {
      const homesCol = db.collection("homes");
      const roomsCol = db.collection("rooms");
      const devicesCol = db.collection("devices");
      const now = new Date().toISOString();

      // STEP A: Verify user has access to target home
      const targetHome = await homesCol.findOne({
        _id: cleanTargetHomeId,
        $or: [
          { ownerId: currentUserId },
          { members: currentUserId },
          { memberIds: currentUserId }
        ]
      });

      if (!targetHome) {
        throw new Error("TARGET_HOME_FORBIDDEN_OR_NOT_FOUND");
      }

      // STEP B: Resolve Target Room (by targetRoomId or targetRoomName)
      let resolvedTargetRoomId = null;
      let resolvedTargetRoomName = "";

      if (targetRoomId && ObjectId.isValid(targetRoomId)) {
        const roomDoc = await roomsCol.findOne({
          _id: new ObjectId(targetRoomId.toString().trim()),
          $or: [
            { homeId: cleanTargetHomeId },
            { homeId: cleanTargetHomeId.toString() }
          ]
        });

        if (!roomDoc) {
          throw new Error("TARGET_ROOM_NOT_FOUND");
        }
        resolvedTargetRoomId = roomDoc._id;
        resolvedTargetRoomName = roomDoc.roomName;
      } else if (targetRoomName) {
        const cleanName = targetRoomName.toString().trim();
        const escapedName = cleanName.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, "\\$&");

        let roomDoc = await roomsCol.findOne({
          $or: [
            { homeId: cleanTargetHomeId },
            { homeId: cleanTargetHomeId.toString() }
          ],
          roomName: { $regex: new RegExp(`^${escapedName}$`, "i") }
        });

        if (!roomDoc) {
          const newRoomResult = await roomsCol.insertOne({
            homeId: cleanTargetHomeId,
            roomName: cleanName,
            createdAt: now,
            updatedAt: now
          });
          resolvedTargetRoomId = newRoomResult.insertedId;
          resolvedTargetRoomName = cleanName;
        } else {
          resolvedTargetRoomId = roomDoc._id;
          resolvedTargetRoomName = roomDoc.roomName;
        }
      } else {
        return { error: "TARGET_ROOM_REQUIRED" };
      }

      // STEP C: Build match query for devices to shift
      const deviceQuery = {};

      if (hasSpecificDevices) {
        // Support both custom device string IDs ('DEV-...') and MongoDB ObjectIds
        const objectIdCandidates = deviceIds
          .filter((id) => ObjectId.isValid(id))
          .map((id) => new ObjectId(id));

        deviceQuery.$or = [
          { deviceId: { $in: deviceIds } },
          { _id: { $in: objectIdCandidates } }
        ];
      } else if (sourceRoomId) {
        const cleanSourceRoomId = ObjectId.isValid(sourceRoomId)
          ? new ObjectId(sourceRoomId)
          : sourceRoomId;

        deviceQuery.$or = [
          { roomId: cleanSourceRoomId },
          { roomId: cleanSourceRoomId.toString() }
        ];
      } else if (sourceHomeId) {
        const cleanSourceHomeId = ObjectId.isValid(sourceHomeId)
          ? new ObjectId(sourceHomeId)
          : sourceHomeId;

        deviceQuery.$or = [
          { homeId: cleanSourceHomeId },
          { homeId: cleanSourceHomeId.toString() }
        ];
      }

      // STEP D: Execute update
      const updatePayload = {
        $set: {
          homeId: cleanTargetHomeId,
          roomId: resolvedTargetRoomId,
          updatedAt: now
        }
      };

      const updateResult = await devicesCol.updateMany(deviceQuery, updatePayload);

      return {
        matchedCount: updateResult.matchedCount,
        modifiedCount: updateResult.modifiedCount,
        targetHomeId: cleanTargetHomeId,
        targetRoomId: resolvedTargetRoomId,
        targetRoomName: resolvedTargetRoomName
      };
    });

    if (result.error === "TARGET_ROOM_REQUIRED") {
      return c.json({
        success: false,
        message: "A target room is required. Provide either 'targetRoomId' or 'targetRoomName'."
      }, 400);
    }

    return c.json({
      success: true,
      message: `Successfully shifted ${result.modifiedCount} device(s).`,
      data: result
    }, 200);

  } catch (error) {
    console.error("❌ Shift Devices Controller Error:", error);

    if (error.message === "TARGET_HOME_FORBIDDEN_OR_NOT_FOUND") {
      return c.json({
        success: false,
        message: "Target home does not exist or you do not have permission to access it."
      }, 403);
    }

    if (error.message === "TARGET_ROOM_NOT_FOUND") {
      return c.json({
        success: false,
        message: "The specified targetRoomId was not found in the target home."
      }, 404);
    }

    return c.json({ success: false, message: "Internal Server Error", error: error.message }, 500);
  }
};