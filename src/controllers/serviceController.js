import { withDatabase } from '../utils/config.js';
import { scrapeServiceCenters, scrapeHomeServices } from '../services/scrapeService.js';
import 'dotenv/config';
import { ObjectId } from "mongodb";
import { uploadToR2 } from "../services/r2.service.js";
import { createServiceCard, moveCardToList, createProviderBoard } from '../services/wekan.js';

const mongoUri = process.env.MONGODB_URI;
const CACHE_EXPIRATION_MS = 24 * 60 * 60 * 1000; // 24 Hours in milliseconds


const getCoordinatesFromLocation = async (address, pincode) => {
  try {
    const query = encodeURIComponent(`${address || ''} ${pincode || ''}`.trim());
    const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${query}`, {
      headers: { "User-Agent": "ZhiniServiceApp/1.0" }
    });
    const data = await res.json();
    if (data && data.length > 0) {
      return [parseFloat(data[0].lon), parseFloat(data[0].lat)];
    }
  } catch (err) {
    console.warn("⚠️ Geocoding failed, falling back to default coordinates:", err.message);
  }
  // Fallback coordinates if geocoding service fails
  return [80.1918, 12.9171];
};



export const getNearbyService = async (c) => {
  try {
    // 1. Read request body (for JSON payloads) with fallback to query params
    let body = {};
    try {
      body = await c.req.json();
    } catch (_) {
      // Body was empty or not JSON; fall back to query params
    }

    const rawBrand = body.brand || c.req.query('brand') || '';
    const rawProduct = body.product || c.req.query('product') || '';
    const rawPincode = body.pincode || c.req.query('pincode') || '';

    // Direct coordinates passed from mobile
    const rawLat = body.latitude || body.lat || c.req.query('latitude') || c.req.query('lat') || null;
    const rawLng = body.longitude || body.lng || c.req.query('longitude') || c.req.query('lng') || null;

    const lat = rawLat !== null ? parseFloat(rawLat) : null;
    const lng = rawLng !== null ? parseFloat(rawLng) : null;

    const isUnderWarranty = body.isUnderWarranty === true ||
      body.inWarranty === true ||
      c.req.query('isUnderWarranty') === 'true' ||
      c.req.query('inWarranty') === 'true';

    // Helper to sanitize inputs
    const cleanValue = (val) => {
      if (!val) return '';
      const sanitized = String(val).trim();
      const upper = sanitized.toUpperCase();
      if (upper === 'N/A' || upper === 'UNDEFINED' || upper === 'NULL') return '';
      return sanitized;
    };

    const brand = cleanValue(rawBrand);
    const product = cleanValue(rawProduct);
    const pincode = cleanValue(rawPincode);

    const hasCoordinates = lat !== null && !isNaN(lat) && lng !== null && !isNaN(lng);
    const hasLocation = pincode || hasCoordinates;

    // Validation: Require location (pincode OR lat/lng) and at least one search term
    if (!hasLocation || (!brand && !product)) {
      console.warn(`⚠️ Validation Failed [400]: brand="${rawBrand}", product="${rawProduct}", pincode="${rawPincode}", lat="${rawLat}", lng="${rawLng}"`);
      return c.json({
        success: false,
        message: 'A valid location (pincode or latitude/longitude) and at least one search term (brand or product) are required'
      }, 400);
    }

    // Determine location string for scraper & cache keys
    const locationQuery = pincode || `${lat.toFixed(4)},${lng.toFixed(4)}`;

    const response = await withDatabase(mongoUri, async (db) => {
      const cacheCollection = db.collection('service_cache');

      // -------------------------------------------------------------
      // TIER 1: ACTIVE WARRANTY -> Authorized Service Centers Only
      // -------------------------------------------------------------
      if (isUnderWarranty) {
        console.log(`🛡️ Tier 1 Triggered: Searching Authorized Centers for ${brand} ${product} in ${locationQuery}`);
        const cacheKey = `tier1_${brand}_${product}_${locationQuery}`.toLowerCase().replace(/[^a-z0-9]/g, '');

        const cached = await cacheCollection.findOne({ key: cacheKey });
        if (cached && (Date.now() - cached.timestamp) < CACHE_EXPIRATION_MS) {
          console.log(`💾 Cache Hit (Tier 1): ${cacheKey}`);
          return { tier: 1, tierName: 'Brand Authorized', data: cached.data };
        }

        const centers = await scrapeServiceCenters(brand, product, locationQuery, { authorizedOnly: true });

        if (centers.length > 0) {
          await cacheCollection.updateOne(
            { key: cacheKey },
            { $set: { key: cacheKey, data: centers, timestamp: Date.now() } },
            { upsert: true }
          );
        }

        return { tier: 1, tierName: 'Brand Authorized', data: centers };
      }

      // -------------------------------------------------------------
      // TIER 2: OUT OF WARRANTY -> Local Zhini Service Providers (GeoJSON Radius + Expertise Match)
      // -------------------------------------------------------------
      console.log(`🔍 Checking Tier 2: Zhini Local Providers for "${product || brand}" near location="${locationQuery}"`);

      try {
        const providerCollection = db.collection('service-providers');

        const searchTerm = product || brand;
        const searchRegex = new RegExp(searchTerm.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&'), 'i');

        // Query active providers matching expertise
        const activeProviders = await providerCollection.find({
          status: 'active',
          expertise: { $elemMatch: { $regex: searchRegex } }
        }).toArray();

        let matchingProviders = [];

        if (hasCoordinates) {
          // Precise distance calculation using mobile coordinates [lng, lat]
          matchingProviders = activeProviders.filter((provider) => {
            if (!provider.location || !provider.location.coordinates) return false;

            const [pLng, pLat] = provider.location.coordinates;

            // Haversine distance formula in km
            const R = 6371;
            const dLat = (pLat - lat) * (Math.PI / 180);
            const dLon = (pLng - lng) * (Math.PI / 180);
            const a =
              Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(lat * (Math.PI / 180)) * Math.cos(pLat * (Math.PI / 180)) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
            const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
            const distanceKm = R * c;

            const maxRadius = Number(provider.serviceRadiusKm) || 10;
            return distanceKm <= maxRadius;
          });
        } else {
          // Direct pincode match fallback if no coordinates were provided
          matchingProviders = activeProviders.filter(
            (provider) => provider.pincode === pincode
          );
        }

        if (matchingProviders.length > 0) {
          console.log(`🎯 Tier 2 Hit: Found ${matchingProviders.length} Zhini Service Provider(s) in range`);

          const providerList = matchingProviders.map((provider) => ({
            id: provider._id,
            name: provider.name,
            mobile: provider.mobile,
            address: provider.address,
            pincode: provider.pincode,
            shopImageUrl: provider.shopImageUrl || null,
            serviceRadiusKm: provider.serviceRadiusKm,
            gstNumber: provider.gstNumber || null,
            expertise: provider.expertise || []
          }));

          return {
            tier: 2,
            tierName: 'Zhini Verified Partner',
            data: providerList
          };
        }
      } catch (err) {
        console.warn(`⚠️ Tier 2 execution failed or bypassed: ${err.message}`);
      }

      // -------------------------------------------------------------
      // TIER 3 (Fallback): OUT OF WARRANTY + NO IN-RANGE ZHINI PROVIDER -> Top 20 General
      // -------------------------------------------------------------
      console.log(`🏢 Tier 3 Fallback Triggered: Fetching Top 20 local centers for ${brand || product} in ${locationQuery}`);
      const cacheKeyTier3 = `tier3_${brand}_${product}_${locationQuery}`.toLowerCase().replace(/[^a-z0-9]/g, '');

      const cachedTier3 = await cacheCollection.findOne({ key: cacheKeyTier3 });
      if (cachedTier3 && (Date.now() - cachedTier3.timestamp) < CACHE_EXPIRATION_MS) {
        console.log(`💾 Cache Hit (Tier 3): ${cacheKeyTier3}`);
        return { tier: 3, tierName: 'General Top Rated', data: cachedTier3.data };
      }

      const rawCenters = await scrapeServiceCenters(brand, product, locationQuery, { authorizedOnly: false });

      // Sort by rating descending and store Top 20
      const top20Centers = rawCenters
        .sort((a, b) => (parseFloat(b.rating) || 0) - (parseFloat(a.rating) || 0))
        .slice(0, 20);

      if (top20Centers.length > 0) {
        await cacheCollection.updateOne(
          { key: cacheKeyTier3 },
          { $set: { key: cacheKeyTier3, data: top20Centers, timestamp: Date.now() } },
          { upsert: true }
        );
      }

      return { tier: 3, tierName: 'General Top Rated', data: top20Centers };
    });

    return c.json({
      success: true,
      tier: response.tier,
      tierName: response.tierName,
      count: response.data.length,
      data: response.data
    }, 200);

  } catch (error) {
    console.error("❌ Service Controller Error:", error);
    return c.json({ success: false, message: "Internal Server Error", error: error.message }, 500);
  }
};


export const getNearbyHomeServices = async (c) => {
  try {
    // Read directly from body (with fallback for raw json or query)
    let body = {};
    try { 
      body = await c.req.json(); 
    } catch (_) { 
      body = await c.req.parseBody(); 
    }

    const serviceType = (body.serviceType || body.category || c.req.query('serviceType') || '').trim();
    const pincode = (body.pincode || c.req.query('pincode') || '').trim();
    const rawLat = body.latitude || body.lat || c.req.query('latitude') || c.req.query('lat') || null;
    const rawLng = body.longitude || body.lng || c.req.query('longitude') || c.req.query('lng') || null;

    const lat = rawLat !== null && !isNaN(Number(rawLat)) ? Number(rawLat) : null;
    const lng = rawLng !== null && !isNaN(Number(rawLng)) ? Number(rawLng) : null;
    const hasCoordinates = lat !== null && lng !== null;

    if (!serviceType || (!pincode && !hasCoordinates)) {
      return c.json({
        success: false,
        message: 'serviceType and at least one location parameter (pincode or latitude/longitude) are required.'
      }, 400);
    }

    // Generate unique cache key based on available location identifier
    const locationKey = hasCoordinates ? `${lat.toFixed(4)}_${lng.toFixed(4)}` : pincode;
    const cacheKey = `home_service_${serviceType}_${locationKey}`.toLowerCase().replace(/[^a-z0-9]/g, '');

    const servicesData = await withDatabase(mongoUri, async (db) => {
      const collection = db.collection('common_cache');

      // 1. Check Cache
      const cached = await collection.findOne({ key: cacheKey });
      if (cached && (Date.now() - cached.timestamp) < CACHE_EXPIRATION_MS) {
        console.log(`💾 Cache Hit (Home Services): ${cacheKey}`);
        return cached.data;
      }

      // 2. Fetch live local technicians
      console.log(`🌐 Fetching live local services for "${serviceType}" at (${locationKey})...`);
      const freshData = await scrapeHomeServices(serviceType, { pincode, lat, lng });

      const topServices = freshData
        .sort((a, b) => (parseFloat(b.rating) || 0) - (parseFloat(a.rating) || 0))
        .slice(0, 20);

      if (topServices.length > 0) {
        await collection.updateOne(
          { key: cacheKey },
          { $set: { key: cacheKey, data: topServices, timestamp: Date.now() } },
          { upsert: true }
        );
      }

      return topServices;
    });

    return c.json({
      success: true,
      category: serviceType,
      count: servicesData.length,
      data: servicesData
    }, 200);

  } catch (error) {
    console.error("❌ Home Services Controller Error:", error);
    return c.json({ success: false, message: "Internal Server Error", error: error.message }, 500);
  }
};



//Service Provider Part//

export const getServiceProviderByMobile = async (c) => {
  try {
    // 1. Extract mobile number from query params
    const mobile = c.req.query("mobile");

    // 2. Validate input
    if (!mobile) {
      return c.json({
        success: false,
        message: "Mobile number is required as a query parameter."
      }, 400);
    }

    const cleanMobile = mobile.trim();

    // 3. Query database using withDatabase wrapper
    const providers = await withDatabase(mongoUri, async (db) => {
      const collection = db.collection("service-providers");

      // Find all matching service provider profiles for this mobile
      return await collection.find({ mobile: cleanMobile }).toArray();
    });

    // 4. Handle case where no record is found
    if (!providers || providers.length === 0) {
      return c.json({
        success: false,
        message: "No service provider profile found for this mobile number.",
        count: 0,
        data: []
      }, 404);
    }

    // 5. Return success response
    return c.json({
      success: true,
      message: `Successfully retrieved ${providers.length} service provider record(s).`,
      count: providers.length,
      data: providers
    }, 200);

  } catch (error) {
    console.error("❌ Get Service Provider Controller Error:", error);
    return c.json({
      success: false,
      message: "Internal Server Error",
      error: error.message
    }, 500);
  }
};

export const createServiceProvider = async (c) => {
  try {
    const body = await c.req.parseBody();

    const name = body["name"];
    const mobile = body["mobile"];
    const range = body["range"];
    const expertiseInput = body["expertise"];
    const gstNumber = body["gstNumber"] || null;
    const address = body["address"];
    const pincode = body["pincode"] || null;

    if (!name || !mobile || !range || !expertiseInput || !address) {
      return c.json({
        success: false,
        message: "Missing required fields: name, mobile, range, or expertise."
      }, 400);
    }

    const cleanMobile = mobile.trim();

    let expertise = [];
    if (typeof expertiseInput === "string") {
      expertise = expertiseInput.split(",").map((e) => e.trim()).filter(Boolean);
    } else if (Array.isArray(expertiseInput)) {
      expertise = expertiseInput.map((e) => String(e).trim());
    }

    // Resolve GeoJSON Coordinates [longitude, latitude]
    const coordinates = await getCoordinatesFromLocation(address, pincode);

    // Upload shop photo directly to Cloudflare R2
    let shopImageUrl = null;
    const photoFile = body["photo"];

    if (photoFile && photoFile instanceof File) {
      shopImageUrl = await uploadToR2(photoFile, "shop-images");
    }

    // Provision Wekan Board
    console.log(`📋 Provisioning Wekan Board for Provider: ${cleanMobile}`);
    const boardResult = await createProviderBoard(cleanMobile);

    const newProvider = {
      name: name.trim(),
      mobile: cleanMobile,
      expertise,
      serviceRadiusKm: Number(range) || range,
      gstNumber: gstNumber ? gstNumber.trim() : null,
      shopImageUrl, // Stores HTTPS R2 URL
      status: "active",
      address: address.trim(),
      pincode: pincode ? pincode.trim() : null,
      location: {
        type: "Point",
        coordinates: coordinates // [longitude, latitude]
      },
      wekanBoardId: boardResult.boardId,
      wekanLists: boardResult.lists,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await withDatabase(mongoUri, async (db) => {
      const collection = db.collection("service-providers");

      // Ensure 2dsphere index exists for spatial queries
      await collection.createIndex({ location: "2dsphere" });

      return await collection.insertOne(newProvider);
    });

    return c.json({
      success: true,
      message: "Service Provider created successfully with Wekan board, R2 image storage, and GeoJSON location.",
      data: {
        _id: result.insertedId,
        ...newProvider
      }
    }, 201);

  } catch (error) {
    console.error("❌ Create Service Provider Controller Error:", error);
    return c.json({
      success: false,
      message: "Internal Server Error",
      error: error.message
    }, 500);
  }
};


export const createServiceTicket = async (c) => {
  try {
    let body = {};

    try {
      body = await c.req.json();
    } catch (_) {
      body = await c.req.parseBody();
    }

    const customerName = body.customerName || body.customer_name;
    const custNumber = body.cust_number || body.customerPhone || body.mobile;
    const address = body.address;
    const description = body.description || body.notes || "Service Request";
    const providerMobile = body.providerMobile;

    const rawAvailableTime = body.availableTime || body.preferredTime || body.timeSlot;
    const availableTime = rawAvailableTime ? String(rawAvailableTime).trim() : "Flexible / Not specified";

    if (!customerName || !custNumber || !address || !providerMobile) {
      return c.json({
        success: false,
        message: "Missing required fields: customerName, cust_number, address, and providerMobile are required.",
      }, 400);
    }

    const ticketResult = await withDatabase(mongoUri, async (db) => {
      const providerCollection = db.collection("service-providers");
      const wekanServiceCollection = db.collection("wekan-services");

      const cleanProviderMobile = providerMobile.trim();

      // 1. Fetch Provider record to get board context
      let provider = await providerCollection.findOne({ mobile: cleanProviderMobile });

      let boardId = provider?.wekanBoardId;
      let newListId = provider?.wekanLists?.["New"];

      // 2. Fallback: If board or list mapping is missing, provision new board and sync back to MongoDB
      if (!boardId || !newListId) {
        console.warn(`⚠️ Board info missing for provider '${cleanProviderMobile}'. Provisioning now...`);
        const boardResult = await createProviderBoard(cleanProviderMobile);
        boardId = boardResult.boardId;
        newListId = boardResult.lists["New"];

        if (provider) {
          await providerCollection.updateOne(
            { mobile: cleanProviderMobile },
            {
              $set: {
                wekanBoardId: boardId,
                wekanLists: boardResult.lists,
                updatedAt: new Date()
              }
            }
          );
        }
      }

      // 3. Format details and create card in Wekan under Customer Phone Swimlane
      const cardTitle = `Ticket: ${customerName.trim()} (${custNumber.trim()})`;
      const cardDescription = `Customer Name: ${customerName.trim()}\nCustomer Phone: ${custNumber.trim()}\nAddress: ${address.trim()}\nAvailable Time: ${availableTime}\nDescription: ${description.trim()}`;

      const cardId = await createServiceCard(boardId, newListId, {
        title: cardTitle,
        description: cardDescription,
        customerPhone: custNumber.trim(),
      });

      // 4. Save ticket document in 'wekan-services' collection
      const ticketRecord = {
        ticketId: `TICK-${Date.now()}`,
        assignedTo: cleanProviderMobile,
        customerDetails: {
          name: customerName.trim(),
          phone: custNumber.trim(),
          address: address.trim(),
        },
        serviceDetails: {
          description: description.trim(),
          availableTime: availableTime,
        },
        wekan: {
          boardId: boardId,
          cardId: cardId,
          listId: newListId,
        },
        status: "NEW",
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      await wekanServiceCollection.insertOne(ticketRecord);
      return ticketRecord;
    });

    return c.json({
      success: true,
      message: "Ticket created and assigned to service provider.",
      data: ticketResult,
    }, 201);

  } catch (error) {
    console.error("❌ Create Service Ticket Controller Error:", error);

    return c.json({
      success: false,
      message: "Failed to create service ticket",
      error: error.message,
    }, 500);
  }
};


export const getProviderTickets = async (c) => {
  try {
    let body = {};
    try {
      body = await c.req.json();
    } catch (_) { }

    const providerMobile = body.providerMobile || c.req.query('providerMobile') || c.req.query('mobile');

    if (!providerMobile) {
      return c.json({
        success: false,
        message: "providerMobile query param or body field is required."
      }, 400);
    }

    const tickets = await withDatabase(mongoUri, async (db) => {
      const wekanServiceCollection = db.collection("wekan-services");
      return await wekanServiceCollection
        .find({ assignedTo: providerMobile.trim() })
        .sort({ createdAt: -1 })
        .toArray();
    });

    return c.json({
      success: true,
      count: tickets.length,
      data: tickets
    }, 200);

  } catch (error) {
    console.error("❌ Get Provider Tickets Controller Error:", error);
    return c.json({
      success: false,
      message: "Failed to fetch provider tickets",
      error: error.message
    }, 500);
  }
};



const STATUS_TO_WEKAN_LIST = {
  "NEW": "New",
  "ACCEPTED": "Accepted",
  "REJECTED": "Rejected",
  "IN_PROGRESS": "In Progress",
  "WAITING_FOR_PARTS": "Waiting for Parts",
  "COMPLETED": "Completed"
};

export const updateTicketStatus = async (c) => {
  try {
    let body = {};
    try {
      body = await c.req.json();
    } catch (_) {
      body = await c.req.parseBody();
    }

    const { ticketId, newStatus } = body;

    if (!ticketId || !newStatus) {
      return c.json({
        success: false,
        message: "Missing required fields: ticketId and newStatus are required."
      }, 400);
    }

    const normalizedStatus = String(newStatus).trim().toUpperCase();
    const targetListName = STATUS_TO_WEKAN_LIST[normalizedStatus];

    if (!targetListName) {
      return c.json({
        success: false,
        message: `Invalid status '${newStatus}'. Allowed statuses: ${Object.keys(STATUS_TO_WEKAN_LIST).join(", ")}`
      }, 400);
    }

    const updatedTicket = await withDatabase(mongoUri, async (db) => {
      const wekanServiceCollection = db.collection("wekan-services");
      const providerCollection = db.collection("service-providers");

      // 1. Fetch current ticket document from MongoDB
      const ticket = await wekanServiceCollection.findOne({ ticketId: ticketId.trim() });
      if (!ticket) {
        throw new Error(`Ticket '${ticketId}' not found in database.`);
      }

      const { boardId, cardId, listId: currentListId } = ticket.wekan;
      const assignedProviderMobile = ticket.assignedTo;

      // 2. Fetch Provider details to resolve list ID mapping
      let provider = await providerCollection.findOne({ mobile: assignedProviderMobile });
      let newListId = provider?.wekanLists?.[targetListName];

      // Fallback: If list mapping is missing on provider doc, fetch board structure directly from Wekan
      if (!newListId) {
        const boardResult = await createProviderBoard(assignedProviderMobile);
        newListId = boardResult.lists[targetListName];
      }

      if (!newListId) {
        throw new Error(`Target list '${targetListName}' could not be resolved on Wekan Board ${boardId}`);
      }

      // 3. Move card to the new list in Wekan
      await moveCardToList(boardId, currentListId, cardId, newListId);

      // 4. Update status and list context in MongoDB
      const updateResult = await wekanServiceCollection.findOneAndUpdate(
        { ticketId: ticketId.trim() },
        {
          $set: {
            status: normalizedStatus,
            "wekan.listId": newListId,
            updatedAt: new Date()
          }
        },
        { returnDocument: "after" }
      );

      return updateResult;
    });

    return c.json({
      success: true,
      message: `Ticket ${ticketId} updated to '${normalizedStatus}' successfully.`,
      data: updatedTicket
    }, 200);

  } catch (error) {
    console.error("❌ Update Ticket Status Controller Error:", error);
    return c.json({
      success: false,
      message: "Failed to update ticket status",
      error: error.message
    }, 500);
  }
};

export const addTicketBilling = async (c) => {
  try {
    // 1. Get Ticket MongoDB ID from route params
    const ticketMongoId = c.req.param("id");

    if (!ticketMongoId || !ObjectId.isValid(ticketMongoId)) {
      return c.json({
        success: false,
        message: "Invalid or missing ticket ID format."
      }, 400);
    }

    // 2. Parse dynamic billing payload from mobile request
    let body = {};
    try {
      body = await c.req.json();
    } catch (_) {
      body = await c.req.parseBody();
    }

    // Accept either a nested billing object { billing: { ... } } or raw root key-values
    const billingData = body.billing || body;

    if (!billingData || Object.keys(billingData).length === 0) {
      return c.json({
        success: false,
        message: "Billing details payload cannot be empty."
      }, 400);
    }

    // 3. Update document in 'wekan-services' collection
    const updatedRecord = await withDatabase(mongoUri, async (db) => {
      const collection = db.collection("wekan-services");

      const result = await collection.findOneAndUpdate(
        { _id: new ObjectId(ticketMongoId) },
        {
          $set: {
            billing: billingData,
            updatedAt: new Date()
          }
        },
        { returnDocument: "after" }
      );

      return result;
    });

    if (!updatedRecord) {
      return c.json({
        success: false,
        message: "Ticket not found with the provided ID."
      }, 404);
    }

    return c.json({
      success: true,
      message: "Billing details attached and ticket marked as completed successfully.",
      data: updatedRecord
    }, 200);

  } catch (error) {
    console.error("❌ Add Ticket Billing Error:", error);
    return c.json({
      success: false,
      message: "Failed to save billing information.",
      error: error.message
    }, 500);
  }
};

export const getHomeServiceHistory = async (c) => {
  try {
    // 1. Get user identifier (phone or userId)
    const phoneParam = c.req.param("phone") || c.req.query("phone");

    if (!phoneParam) {
      return c.json({
        success: false,
        message: "Customer phone number is required."
      }, 400);
    }

    const cleanPhone = phoneParam.trim();
    const numMobile = Number(cleanPhone);

    const tickets = await withDatabase(mongoUri, async (db) => {
      const usersCol = db.collection("Users");
      const homesCol = db.collection("Homes");
      const ticketsCol = db.collection("wekan-services");

      // STEP A: Find User Document
      const user = await usersCol.findOne({
        $or: [
          { mobile: cleanPhone },
          { mobile: isNaN(numMobile) ? cleanPhone : numMobile }
        ]
      });

      // STEP B: Find all Homes linked to this user or phone number
      const homeQueryFilters = [
        { mobile: cleanPhone }
      ];

      if (user) {
        homeQueryFilters.push(
          { ownerId: user._id },
          { userId: user._id },
          { members: user._id },
          { memberIds: user._id }
        );
      }

      const userHomes = await homesCol.find({ $or: homeQueryFilters }).toArray();

      // STEP C: Collect all member User IDs & member mobile numbers across those homes
      const memberUserIds = new Set();
      const memberPhones = new Set([cleanPhone]);

      userHomes.forEach((home) => {
        if (home.ownerId) memberUserIds.add(home.ownerId.toString());
        if (home.userId) memberUserIds.add(home.userId.toString());

        const membersList = [...(home.members || []), ...(home.memberIds || [])];
        membersList.forEach((mId) => {
          if (mId) memberUserIds.add(mId.toString());
        });

        if (home.mobile) memberPhones.add(String(home.mobile).trim());
      });

      // Fetch user documents for all co-members to grab their mobile numbers as well
      if (memberUserIds.size > 0) {
        const objectIds = Array.from(memberUserIds)
          .filter((id) => ObjectId.isValid(id))
          .map((id) => new ObjectId(id));

        const coMembers = await usersCol.find({ _id: { $in: objectIds } }).toArray();
        coMembers.forEach((m) => {
          if (m.mobile) memberPhones.add(String(m.mobile).trim());
        });
      }

      // STEP D: Fetch all tickets raised by ANY household member
      const homeObjectIds = userHomes.map((h) => h._id);
      const homeStringIds = userHomes.map((h) => h._id.toString());
      const allPhones = Array.from(memberPhones);

      const records = await ticketsCol.find({
        $or: [
          { homeId: { $in: [...homeObjectIds, ...homeStringIds] } },
          { "customerDetails.phone": { $in: allPhones } }
        ]
      })
        .sort({ createdAt: -1 })
        .toArray();

      return records;
    });

    return c.json({
      success: true,
      message: "Household service history retrieved successfully.",
      count: tickets.length,
      data: tickets
    }, 200);

  } catch (error) {
    console.error("❌ Get Home Service History Error:", error);
    return c.json({
      success: false,
      message: "Failed to retrieve household service history.",
      error: error.message
    }, 500);
  }
};


