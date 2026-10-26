import 'dotenv/config';
import axios from "axios";
import { withDatabase } from '../utils/config.js';
import {  notifyUserByMobile } from '../utils/fcmHelper.js';
import { scrapeServiceCenters, scrapeHomeServices } from '../services/scrapeService.js';
import { ObjectId } from "mongodb";
import { uploadToR2 } from "../services/r2.service.js";
import { createServiceCard, moveCardToList, createProviderBoard, getWekanAuthHeaders } from '../services/wekan.js';

const mongoUri = process.env.MONGODB_URI;
// 1 Month / 30 Days (new)
const CACHE_EXPIRATION_MS = 30 * 24 * 60 * 60 * 1000; //One month cache 
const GOOGLE_PLACES_API_KEY = process.env.GOOGLE_PLACES_API_KEY;

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

// 📍 Resolve Pincode to Lat/Lng with Permanent MongoDB Caching
export const getCoordinatesFromPincode = async (pincode, db) => {
  if (!pincode || !/^\d{6}$/.test(pincode.trim())) return null;
  const cleanPin = pincode.trim();

  try {
    const geoCache = db.collection('pincode_cache');
    const cached = await geoCache.findOne({ pincode: cleanPin });
    if (cached && cached.location?.lat && cached.location?.lng) {
      return cached.location;
    }

    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${cleanPin}&components=country:IN&key=${GOOGLE_PLACES_API_KEY}`;
    const res = await axios.get(url);

    if (res.data.status === 'OK' && res.data.results.length > 0) {
      const loc = res.data.results[0].geometry.location;
      const coordinates = { lat: loc.lat, lng: loc.lng };

      await geoCache.updateOne(
        { pincode: cleanPin },
        { $set: { pincode: cleanPin, location: coordinates, updatedAt: new Date() } },
        { upsert: true }
      );

      return coordinates;
    }
  } catch (err) {
    console.warn(`⚠️ Pincode geocode lookup failed for ${cleanPin}:`, err.message);
  }

  return null;
};

// Clean phone numbers to last 10 digits to prevent string format mismatches
const normalizePhone = (phone) => {
  if (!phone) return '';
  const digits = String(phone).replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : digits;
};

export const getNearbyService = async (c) => {
  try {
    let body = {};
    try {
      body = await c.req.json();
    } catch (_) {
      // Body was empty or not JSON; fallback to query params
    }

    // 👤 Customer Phone from Auth Header
    const customerPhoneHeader = c.req.header('x-user-phone') || '';
    const cleanCustomerPhone = normalizePhone(customerPhoneHeader);

    const rawBrand = body.brand || c.req.query('brand') || '';
    const rawProduct = body.product || c.req.query('product') || '';
    const rawPincode = body.pincode || c.req.query('pincode') || '';

    const rawLat = body.latitude || body.lat || c.req.query('latitude') || c.req.query('lat') || null;
    const rawLng = body.longitude || body.lng || c.req.query('longitude') || c.req.query('lng') || null;

    const lat = rawLat !== null ? parseFloat(rawLat) : null;
    const lng = rawLng !== null ? parseFloat(rawLng) : null;

    const isUnderWarranty =
      body.isUnderWarranty === true ||
      body.inWarranty === true ||
      c.req.query('isUnderWarranty') === 'true' ||
      c.req.query('inWarranty') === 'true';

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

    if (!hasLocation || (!brand && !product)) {
      console.warn(`⚠️ Validation Failed [400]: brand="${rawBrand}", product="${rawProduct}", pincode="${rawPincode}", lat="${rawLat}", lng="${rawLng}"`);
      return c.json({
        success: false,
        message: 'A valid location (pincode or latitude/longitude) and at least one search term (brand or product) are required'
      }, 400);
    }

    const response = await withDatabase(mongoUri, async (db) => {
      const cacheCollection = db.collection('service_cache');

      // Resolve effective coordinates (Mobile GPS or Geocoded Pincode)
      let effectiveCoords = hasCoordinates ? { lat, lng } : null;
      if (!effectiveCoords && pincode) {
        effectiveCoords = await getCoordinatesFromPincode(pincode, db);
      }

      const locationQuery = pincode || (effectiveCoords ? `${effectiveCoords.lat.toFixed(4)},${effectiveCoords.lng.toFixed(4)}` : '');

      // -------------------------------------------------------------
      // TIER 1: ACTIVE WARRANTY -> Authorized Service Centers Only
      // -------------------------------------------------------------
      if (isUnderWarranty) {
        console.log(`🛡️ Tier 1 Triggered: Searching Authorized Centers for ${brand} ${product} near ${locationQuery}`);
        const cacheKey = `tier1_${brand}_${product}_${locationQuery}`.toLowerCase().replace(/[^a-z0-9]/g, '');

        const cached = await cacheCollection.findOne({ key: cacheKey });
        if (cached && (Date.now() - cached.timestamp) < CACHE_EXPIRATION_MS) {
          console.log(`💾 Cache Hit (Tier 1): ${cacheKey}`);
          return { tier: 1, tierName: 'Brand Authorized', data: cached.data };
        }

        const centers = await scrapeServiceCenters(
          brand,
          product,
          locationQuery,
          effectiveCoords,
          { authorizedOnly: true, maxDistanceKm: 75 }
        );

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
      // TIER 2: OUT OF WARRANTY -> Zhini Providers (Tags + Wekan Trust Ranking)
      // -------------------------------------------------------------
      console.log(`🔍 Checking Tier 2: Zhini Local Providers for "${product || brand}" near location="${locationQuery}"`);

      try {
        const providerCollection = db.collection('service-providers');
        const wekanCollection = db.collection('wekan-service');

        // Normalize requested product/brand into search slugs
        const targetProductTag = normalizeTag(product);
        const targetBrandTag = normalizeTag(brand);

        // 1. Fetch active providers
        const activeProviders = await providerCollection.find({ status: 'active' }).toArray();

        // 2. Filter providers by Expertise Tag match & Geographical Distance
        const matchingProviders = activeProviders
          .map((provider) => {
            const providerTags = Array.isArray(provider.expertise)
              ? provider.expertise.map(normalizeTag)
              : [];

            // Tag match: tag slug includes query slug or vice-versa (e.g. "laptop" matches "laptop" or "laptop_repair")
            const isMatch = providerTags.some((tag) => {
              if (targetProductTag && (tag.includes(targetProductTag) || targetProductTag.includes(tag))) {
                return true;
              }
              if (targetBrandTag && (tag.includes(targetBrandTag) || targetBrandTag.includes(tag))) {
                return true;
              }
              return false;
            });

            if (!isMatch) return null;

            // Distance calculation & radius cutoff
            let distanceKm = null;
            if (effectiveCoords && provider.location?.coordinates) {
              const [pLng, pLat] = provider.location.coordinates;
              distanceKm = parseFloat(
                calculateDistanceKm(effectiveCoords.lat, effectiveCoords.lng, pLat, pLng).toFixed(2)
              );
              const maxRadius = Number(provider.serviceRadiusKm) || 10;
              if (distanceKm > maxRadius) return null; // Outside provider's operational zone
            } else if (pincode && provider.pincode !== pincode) {
              // Direct pincode fallback if geocoding coordinates are missing
              return null;
            }

            return {
              ...provider,
              distanceKm,
            };
          })
          .filter(Boolean);

        // 3. If matching providers exist, apply Wekan Social Proof & History Ranking
        if (matchingProviders.length > 0) {
          // A. User Past Service History
          let userPastMobiles = new Set();
          if (cleanCustomerPhone) {
            const customerTickets = await wekanCollection.find({
              'customerDetails.phone': { $regex: cleanCustomerPhone }
            }).toArray();

            customerTickets.forEach((t) => {
              if (t.assignedTo) {
                userPastMobiles.add(normalizePhone(t.assignedTo));
              }
            });
          }

          // B. Neighbor Service History (Tickets in the customer's pincode area)
          let neighborCountMap = {};
          if (pincode) {
            // Match pincode inside customerDetails.address
            const neighborTickets = await wekanCollection.find({
              'customerDetails.address': { $regex: pincode }
            }).toArray();

            neighborTickets.forEach((t) => {
              if (t.assignedTo) {
                const pPhone = normalizePhone(t.assignedTo);
                neighborCountMap[pPhone] = (neighborCountMap[pPhone] || 0) + 1;
              }
            });
          }

          // C. Map & Enrich Providers with trust scores
          const rankedProviders = matchingProviders.map((provider) => {
            const pPhone = normalizePhone(provider.mobile);
            const hasUsedBefore = userPastMobiles.has(pPhone);
            const neighborServiceCount = neighborCountMap[pPhone] || 0;

            return {
              id: provider._id,
              name: provider.name,
              mobile: provider.mobile,
              address: provider.address,
              pincode: provider.pincode,
              shopImageUrl: provider.shopImageUrl || null,
              serviceRadiusKm: provider.serviceRadiusKm,
              distanceKm: provider.distanceKm ?? null,
              gstNumber: provider.gstNumber || null,
              expertise: provider.expertise || [],
              hasUsedBefore,
              neighborServiceCount,
            };
          });

          // D. Multi-Factor Sort: Past Provider > Neighbor Trust > Distance (Ascending)
          rankedProviders.sort((a, b) => {
            // 1. Personal past relationship comes first
            if (a.hasUsedBefore !== b.hasUsedBefore) {
              return b.hasUsedBefore ? 1 : -1;
            }
            // 2. Neighbor service volume (social proof)
            if (b.neighborServiceCount !== a.neighborServiceCount) {
              return b.neighborServiceCount - a.neighborServiceCount;
            }
            // 3. Proximity
            return (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity);
          });

          console.log(`🎯 Tier 2 Hit: Found ${rankedProviders.length} Zhini Service Provider(s) ranked by history & proximity`);

          return {
            tier: 2,
            tierName: 'Zhini Verified Partner',
            data: rankedProviders
          };
        }
      } catch (err) {
        console.warn(`⚠️ Tier 2 execution failed or bypassed: ${err.message}`);
      }

      // -------------------------------------------------------------
      // TIER 3 (Fallback): OUT OF WARRANTY + NO LOCAL ZHINI PARTNER -> Google Places
      // -------------------------------------------------------------
      console.log(`🏢 Tier 3 Fallback Triggered: Fetching local centers for ${brand || product} in ${locationQuery}`);
      const cacheKeyTier3 = `tier3_${brand}_${product}_${locationQuery}`.toLowerCase().replace(/[^a-z0-9]/g, '');

      const cachedTier3 = await cacheCollection.findOne({ key: cacheKeyTier3 });
      if (cachedTier3 && (Date.now() - cachedTier3.timestamp) < CACHE_EXPIRATION_MS) {
        console.log(`💾 Cache Hit (Tier 3): ${cacheKeyTier3}`);
        return { tier: 3, tierName: 'General Top Rated', data: cachedTier3.data };
      }

      const rawCenters = await scrapeServiceCenters(
        brand,
        product,
        locationQuery,
        effectiveCoords,
        { authorizedOnly: false, maxDistanceKm: 75 }
      );

      let sortedCenters = rawCenters;
      if (!effectiveCoords) {
        sortedCenters = rawCenters.sort(
          (a, b) => (parseFloat(b.rating) || 0) - (parseFloat(a.rating) || 0)
        );
      }

      const finalCenters = sortedCenters.slice(0, 20);

      if (finalCenters.length > 0) {
        await cacheCollection.updateOne(
          { key: cacheKeyTier3 },
          { $set: { key: cacheKeyTier3, data: finalCenters, timestamp: Date.now() } },
          { upsert: true }
        );
      }

      return { tier: 3, tierName: 'General Top Rated', data: finalCenters };
    });

    const hasResults = response.data && response.data.length > 0;

    return c.json({
      success: true,
      tier: response.tier,
      tierName: response.tierName,
      count: response.data.length,
      message: hasResults
        ? 'Service centers retrieved successfully'
        : 'No authorized or repair service centers found within your area (75 km).',
      data: response.data
    }, 200);

  } catch (error) {
    console.error('❌ Service Controller Error:', error);
    return c.json({ success: false, message: 'Internal Server Error', error: error.message }, 500);
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

// Helper to normalize any tag string into a clean lowercase slug
export const normalizeTag = (tag) => {
  return String(tag || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_') // Replace spaces, hyphens, symbols with underscores
    .replace(/^_+|_+$/g, '');   // Trim leading/trailing underscores
};

export const createServiceProvider = async (c) => {
  try {
    const body = await c.req.parseBody();

    const name = body['name'];
    const mobile = body['mobile'];
    const range = body['range'];
    const expertiseInput = body['expertise'];
    const gstNumber = body['gstNumber'] || null;
    const address = body['address'];
    const pincode = body['pincode'] || null;

    if (!name || !mobile || !range || !expertiseInput || !address) {
      return c.json({
        success: false,
        message: 'Missing required fields: name, mobile, range, or expertise.'
      }, 400);
    }

    const cleanMobile = mobile.trim();

    // 🏷️ Tag Normalization: sanitize tags to lowercase slugs (e.g., ["ac_repair", "laptop", "plumbing"])
    let rawTags = [];
    if (typeof expertiseInput === 'string') {
      rawTags = expertiseInput.split(',').map((e) => e.trim());
    } else if (Array.isArray(expertiseInput)) {
      rawTags = expertiseInput.map((e) => String(e).trim());
    }

    const expertise = [...new Set(rawTags.map(normalizeTag).filter(Boolean))];

    if (expertise.length === 0) {
      return c.json({
        success: false,
        message: 'At least one valid expertise tag is required (e.g. laptop, ac_repair).'
      }, 400);
    }

    // Resolve GeoJSON Coordinates [longitude, latitude]
    const coordinates = await getCoordinatesFromLocation(address, pincode);

    // Upload shop photo directly to Cloudflare R2 if provided
    let shopImageUrl = null;
    const photoFile = body['photo'];
    if (photoFile && photoFile instanceof File) {
      shopImageUrl = await uploadToR2(photoFile, 'shop-images');
    }

    // Provision Wekan Board
    console.log(`📋 Provisioning Wekan Board for Provider: ${cleanMobile}`);
    const boardResult = await createProviderBoard(cleanMobile);

    const newProvider = {
      name: name.trim(),
      mobile: cleanMobile,
      expertise, // Standardized slugs array
      serviceRadiusKm: Number(range) || 10,
      gstNumber: gstNumber ? gstNumber.trim() : null,
      shopImageUrl,
      status: 'active',
      address: address.trim(),
      pincode: pincode ? pincode.trim() : null,
      location: {
        type: 'Point',
        coordinates: coordinates // [longitude, latitude]
      },
      wekanBoardId: boardResult.boardId,
      wekanLists: boardResult.lists,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await withDatabase(mongoUri, async (db) => {
      const collection = db.collection('service-providers');
      await collection.createIndex({ location: '2dsphere' });
      return await collection.insertOne(newProvider);
    });

    return c.json({
      success: true,
      message: 'Service Provider created successfully with standardized tags, Wekan board, and GeoJSON location.',
      data: {
        _id: result.insertedId,
        ...newProvider
      }
    }, 201);

  } catch (error) {
    console.error('❌ Create Service Provider Controller Error:', error);
    return c.json({
      success: false,
      message: 'Internal Server Error',
      error: error.message
    }, 500);
  }
};

export const updateServiceProvider = async (c) => {
  try {
    let body = {};
    try {
      body = await c.req.json();
    } catch (_) {
      body = await c.req.parseBody();
    }

    // 1. Resolve target provider mobile (Route Param > Header > Body)
    const mobileParam = c.req.param("mobile");
    const headerMobile = c.req.header("x-user-phone");
    const targetMobile = (mobileParam || headerMobile || body.mobile || "").trim();

    if (!targetMobile) {
      return c.json({
        success: false,
        message: "Provider mobile number is required to perform an update.",
      }, 400);
    }

    // 2. Extract allowed fields from payload
    const {
      name,
      shopName,
      email,
      address,
      pincode,
      servicePincodes,
      categories,
      isAvailable,
      operatingHours,
      gstNumber,
      upiId,
      profileImageUrl,
    } = body;

    const providerUpdates = {};

    if (name !== undefined) providerUpdates.name = String(name).trim();
    if (shopName !== undefined) providerUpdates.shopName = String(shopName).trim();
    if (email !== undefined) providerUpdates.email = String(email).trim().toLowerCase();
    if (address !== undefined) providerUpdates.address = typeof address === "string" ? address.trim() : address;
    if (pincode !== undefined) providerUpdates.pincode = String(pincode).trim();
    if (isAvailable !== undefined) providerUpdates.isAvailable = Boolean(isAvailable);
    if (operatingHours !== undefined) providerUpdates.operatingHours = String(operatingHours).trim();
    if (gstNumber !== undefined) providerUpdates.gstNumber = String(gstNumber).trim();
    if (upiId !== undefined) providerUpdates.upiId = String(upiId).trim();
    if (profileImageUrl !== undefined) providerUpdates.profileImageUrl = String(profileImageUrl).trim();

    if (Array.isArray(servicePincodes)) {
      providerUpdates.servicePincodes = servicePincodes.map((p) => String(p).trim()).filter(Boolean);
    }
    if (Array.isArray(categories)) {
      providerUpdates.categories = categories.map((cat) => String(cat).trim()).filter(Boolean);
    }

    if (Object.keys(providerUpdates).length === 0) {
      return c.json({
        success: false,
        message: "No valid fields provided for update.",
      }, 400);
    }

    providerUpdates.updatedAt = new Date();

    // 3. Database operations: Update provider doc & sync name to users doc
    const updatedProvider = await withDatabase(mongoUri, async (db) => {
      const providerCollection = db.collection("service-providers");
      const usersCollection = db.collection("users");

      // Update service-providers collection
      const providerResult = await providerCollection.findOneAndUpdate(
        { mobile: targetMobile },
        { $set: providerUpdates },
        { returnDocument: "after" }
      );

      if (!providerResult) {
        return null;
      }

      // Sync name to users collection if name was updated
      if (providerUpdates.name) {
        await usersCollection.updateOne(
          {
            $or: [
              { mobile: targetMobile },
              { "UserInfo.phoneNo": targetMobile },
            ],
          },
          {
            $set: {
              name: providerUpdates.name,
              "UserInfo.name": providerUpdates.name,
              updatedAt: new Date(),
            },
          }
        );
      }

      return providerResult;
    });

    if (!updatedProvider) {
      return c.json({
        success: false,
        message: `Service provider with mobile '${targetMobile}' not found.`,
      }, 404);
    }

    return c.json({
      success: true,
      message: "Provider profile and user name synced successfully.",
      data: updatedProvider,
    }, 200);

  } catch (error) {
    console.error("❌ Update Service Provider Error:", error);
    return c.json({
      success: false,
      message: "Failed to update service provider details.",
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
  "CANCELED": "Canceled",
  "IN_PROGRESS": "In Progress",
  "WAITING_FOR_PARTS": "Waiting for Parts",
  "COMPLETED": "Completed"
};



export const cancelTicket = async (c) => {
  try {
    let body = {};
    try {
      body = await c.req.json();
    } catch (_) {
      body = await c.req.parseBody();
    }

    const { ticketId, customerMobile, reason } = body;

    if (!ticketId) {
      return c.json({
        success: false,
        message: "Missing required field: ticketId is required."
      }, 400);
    }

    const cancelReason = (reason || "No cancellation reason provided.").trim();

    const updatedTicket = await withDatabase(mongoUri, async (db) => {
      const wekanServiceCollection = db.collection("wekan-services");
      const providerCollection = db.collection("service-providers");

      // 1. Fetch current ticket document from MongoDB
      const ticket = await wekanServiceCollection.findOne({ ticketId: ticketId.trim() });
      if (!ticket) {
        throw new Error(`Ticket '${ticketId}' not found in database.`);
      }

      const { boardId, cardId } = ticket.wekan;
      const assignedProviderMobile = ticket.assignedTo;
      const finalCustomerMobile = customerMobile || ticket.customerMobile || ticket.customerPhone || "N/A";

      // 2. Resolve "Canceled" List ID from Provider document
      const provider = await providerCollection.findOne({ mobile: assignedProviderMobile });
      let canceledListId = provider?.wekanLists?.["Canceled"] || provider?.wekanLists?.["Cancelled"];

      // Fallback: Resolve list directly from Wekan if missing on provider doc
      const baseUrl = process.env.WEKAN_BASE_URL || "http://wekan-app:8080";
      const headers = await getWekanAuthHeaders();

      if (!canceledListId) {
        const listsRes = await fetch(`${baseUrl}/api/boards/${boardId}/lists`, {
          method: "GET",
          headers,
        });

        if (listsRes.ok) {
          const lists = await listsRes.json();
          const targetList = lists.find((l) =>
            ["canceled", "cancelled"].includes(l.title?.trim().toLowerCase())
          );
          canceledListId = targetList?._id || targetList?.id;
        }
      }

      if (!canceledListId) {
        throw new Error(`"Canceled" list could not be resolved on Wekan Board ${boardId}`);
      }

      // 3. Construct updated description with customer number and reason
      const cancelDescription = [
        `❌ [STATUS]: CANCELED`,
        `📞 Customer Mobile: ${finalCustomerMobile}`,
        `📝 Reason: ${cancelReason}`,
        `⏰ Cancelled At: ${new Date().toISOString()}`
      ].join("\n");

      // 4. Move card to Canceled list and update description in Wekan
      const moveRes = await fetch(
        `${baseUrl}/api/boards/${boardId}/lists/${canceledListId}/cards/${cardId}`,
        {
          method: "PUT",
          headers,
          body: JSON.stringify({
            listId: canceledListId,
            description: cancelDescription,
          }),
        }
      );

      if (!moveRes.ok) {
        const errText = await moveRes.text();
        throw new Error(`Wekan card update failed (${moveRes.status}): ${errText}`);
      }

      // 5. Update ticket status in MongoDB
      const updateResult = await wekanServiceCollection.findOneAndUpdate(
        { ticketId: ticketId.trim() },
        {
          $set: {
            status: "CANCELED",
            cancelReason,
            "wekan.listId": canceledListId,
            updatedAt: new Date()
          }
        },
        { returnDocument: "after" }
      );

      return updateResult;
    });

    return c.json({
      success: true,
      message: `Ticket ${ticketId} canceled successfully.`,
      data: updatedTicket
    }, 200);

  } catch (error) {
    console.error("❌ Cancel Ticket Controller Error:", error);
    return c.json({
      success: false,
      message: "Failed to cancel ticket",
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


export const submitTicketRating = async (c) => {
  try {
    let body = {};
    try {
      body = await c.req.json();
    } catch (_) {
      body = await c.req.parseBody();
    }

    const { ticketId, reviewedBy, rating, feedback } = body;

    // 1. Validation
    if (!ticketId || !reviewedBy || rating === undefined) {
      return c.json({
        success: false,
        message: "Missing required fields: ticketId, reviewedBy (CUSTOMER/PROVIDER), and rating (1-5)."
      }, 400);
    }

    const numRating = Number(rating);
    if (isNaN(numRating) || numRating < 1 || numRating > 5) {
      return c.json({ success: false, message: "Rating must be a number between 1 and 5." }, 400);
    }

    const role = String(reviewedBy).trim().toUpperCase();
    if (!["CUSTOMER", "PROVIDER"].includes(role)) {
      return c.json({ success: false, message: "reviewedBy must be either 'CUSTOMER' or 'PROVIDER'." }, 400);
    }

    const ratingKey = role === "CUSTOMER" ? "ratings.byCustomer" : "ratings.byProvider";
    const now = new Date();

    const result = await withDatabase(mongoUri, async (db) => {
      const wekanServiceCollection = db.collection("wekan-services");
      const providerCollection = db.collection("service-providers");

      // 2. Fetch ticket to verify status
      const ticket = await wekanServiceCollection.findOne({ ticketId: ticketId.trim() });
      if (!ticket) {
        throw new Error(`Ticket '${ticketId}' not found.`);
      }

      if (ticket.status !== "COMPLETED") {
        throw new Error(`Ratings can only be submitted for COMPLETED tickets. Current status: ${ticket.status}`);
      }

      // Check for existing review
      if (ticket.ratings && ticket.ratings[role === "CUSTOMER" ? "byCustomer" : "byProvider"]) {
        throw new Error(`Rating already submitted by ${role.toLowerCase()} for this ticket.`);
      }

      // 3. Update the ticket with rating
      const updatedTicket = await wekanServiceCollection.findOneAndUpdate(
        { ticketId: ticketId.trim() },
        {
          $set: {
            [ratingKey]: {
              rating: numRating,
              feedback: (feedback || "").trim(),
              submittedAt: now
            },
            updatedAt: now
          }
        },
        { returnDocument: "after" }
      );

      // 4. If Customer rated the Provider, update Provider's aggregate average
      if (role === "CUSTOMER" && ticket.assignedTo) {
        const providerTickets = await wekanServiceCollection
          .find({
            assignedTo: ticket.assignedTo,
            "ratings.byCustomer.rating": { $exists: true }
          })
          .toArray();

        const totalReviews = providerTickets.length;
        const sumRatings = providerTickets.reduce((acc, curr) => acc + curr.ratings.byCustomer.rating, 0);
        const avgRating = Number((sumRatings / totalReviews).toFixed(1));

        await providerCollection.updateOne(
          { mobile: ticket.assignedTo },
          {
            $set: {
              "ratingSummary.averageRating": avgRating,
              "ratingSummary.totalReviews": totalReviews,
              updatedAt: now
            }
          }
        );
      }

      return updatedTicket;
    });

    return c.json({
      success: true,
      message: `Rating from ${role.toLowerCase()} submitted successfully.`,
      data: result
    }, 200);

  } catch (error) {
    console.error("❌ Rating Submission Error:", error);
    return c.json({
      success: false,
      message: error.message || "Failed to submit rating",
    }, 400);
  }
};


const STATUS_NOTIFICATION_MAP = {
  ACCEPTED: {
    title: "Service Request Accepted! 🤝",
    body: (shop) => `${shop || "The service partner"} has accepted your repair booking.`,
  },
  ON_THE_WAY: {
    title: "Technician On The Way 🛵",
    body: (shop) => `${shop || "The technician"} is heading to your address.`,
  },
  PICKED_UP: {
    title: "Device Picked Up 📦",
    body: () => "Your appliance was collected and is headed to the workshop.",
  },
  IN_PROGRESS: {
    title: "Repair In Progress 🔧",
    body: () => "Diagnosis complete. Repair work has begun on your appliance.",
  },
  ON_HOLD_PARTS: {
    title: "Repair Temporarily On Hold ⏳",
    body: () => "Work is paused while waiting for required spare parts to arrive.",
  },
  READY_FOR_DELIVERY: {
    title: "Repair Complete! ✨",
    body: () => "Your appliance has been serviced and is scheduled for return delivery.",
  },
  COMPLETED: {
    title: "Service Completed ✅",
    body: () => "Your device has been delivered. Thank you for choosing Zhini!",
  },
  CANCELLED: {
    title: "Service Cancelled ❌",
    body: () => "Your service ticket has been cancelled.",
  },
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

    const cleanProviderMobile = providerMobile.toString().trim();
    const cleanCustomerMobile = custNumber.toString().trim();

    const ticketResult = await withDatabase(mongoUri, async (db) => {
      const providerCollection = db.collection("service-providers");
      const wekanServiceCollection = db.collection("wekan-services");

      // 1. Fetch Provider record to get board context
      let provider = await providerCollection.findOne({ mobile: cleanProviderMobile });

      let boardId = provider?.wekanBoardId;
      let newListId = provider?.wekanLists?.["New"];

      // 2. Fallback: If board or list mapping is missing, provision new board and sync back
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

      // 3. Format details and create card in Wekan
      const cardTitle = `Ticket: ${customerName.trim()} (${cleanCustomerMobile})`;
      const cardDescription = `Customer Name: ${customerName.trim()}\nCustomer Phone: ${cleanCustomerMobile}\nAddress: ${address.trim()}\nAvailable Time: ${availableTime}\nDescription: ${description.trim()}`;

      const cardId = await createServiceCard(boardId, newListId, {
        title: cardTitle,
        description: cardDescription,
        customerPhone: cleanCustomerMobile,
      });

      // 4. Save ticket document in 'wekan-services' collection
      const ticketRecord = {
        ticketId: `TICK-${Date.now()}`,
        assignedTo: cleanProviderMobile,
        customerDetails: {
          name: customerName.trim(),
          phone: cleanCustomerMobile,
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

    // 5. Non-blocking push notification dispatch to Provider via notifyUserByMobile
    notifyUserByMobile(cleanProviderMobile, {
      title: "New Service Request! 🛠️",
      body: `${customerName.trim()} requested a service at ${address.trim()}.`,
      data: {
        type: "SERVICE_TICKET",
        ticketId: ticketResult.ticketId,
        customerName: customerName.trim(),
        customerPhone: cleanCustomerMobile,
      },
    }).catch((err) => console.error("⚠️ Background FCM Dispatch failed:", err));

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

    let customerMobile = null;
    let providerShopName = "";

    const updatedTicket = await withDatabase(mongoUri, async (db) => {
      const wekanServiceCollection = db.collection("wekan-services");
      const providerCollection = db.collection("service-providers");

      // 1. Fetch current ticket document from MongoDB
      const ticket = await wekanServiceCollection.findOne({ ticketId: ticketId.trim() });
      if (!ticket) {
        throw new Error(`Ticket '${ticketId}' not found in database.`);
      }

      // Extract customer mobile for push notification
      customerMobile = ticket.customerDetails?.phone;

      const { boardId, cardId, listId: currentListId } = ticket.wekan;
      const assignedProviderMobile = ticket.assignedTo;

      // 2. Fetch Provider details to resolve list ID mapping and shop name
      let provider = await providerCollection.findOne({ mobile: assignedProviderMobile });
      providerShopName = provider?.shopName || provider?.name || "";
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

    // 5. Non-blocking push notification dispatch to Customer
    const statusMeta = STATUS_NOTIFICATION_MAP[normalizedStatus];
    if (statusMeta && customerMobile) {
      notifyUserByMobile(customerMobile, {
        title: statusMeta.title,
        body: statusMeta.body(providerShopName),
        data: {
          type: "TICKET_STATUS_UPDATE",
          ticketId: ticketId.trim(),
          status: normalizedStatus,
        },
      }).catch((err) => console.error("⚠️ Customer FCM Dispatch Error:", err));
    }

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