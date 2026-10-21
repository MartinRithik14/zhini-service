import axios from "axios";

const GOOGLE_PLACES_API_KEY = process.env.GOOGLE_PLACES_API_KEY;

const calculateDistanceKm = (lat1, lon1, lat2, lon2) => {
  if (lat1 === null || lon1 === null || lat2 === null || lon2 === null) return Infinity;
  const R = 6371;
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLon = (lon2 - lon1) * (Math.PI / 180);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
};



// 🏢 Scrape & Distance-Filter Google Places Service Centers
export const scrapeServiceCenters = async (
  brand,
  product,
  locationQuery,
  coordinates = null, // { lat, lng }
  options = { authorizedOnly: false, maxDistanceKm: 75 }
) => {
  try {
    const hasBrand = brand && brand.trim() && brand.toUpperCase() !== "N/A";
    const cleanBrand = hasBrand ? brand.trim() : "";
    const cleanProduct = product ? product.trim() : "";

    let queryTerm = "";
    if (options.authorizedOnly) {
      queryTerm = hasBrand 
        ? `${cleanBrand} ${cleanProduct} authorized service center` 
        : `${cleanProduct} authorized service center`;
    } else {
      queryTerm = hasBrand 
        ? `${cleanBrand} ${cleanProduct} repair service center` 
        : `${cleanProduct} repair service center`;
    }

    // Do not append "near ..." when coordinates exist so locationBias takes precedence
    const searchQuery = (coordinates && coordinates.lat && coordinates.lng)
      ? queryTerm
      : `${queryTerm} near ${locationQuery}`;

    const requestPayload = {
      textQuery: searchQuery,
    };

    if (coordinates && coordinates.lat !== null && coordinates.lng !== null) {
      requestPayload.locationBias = {
        circle: {
          center: {
            latitude: coordinates.lat,
            longitude: coordinates.lng,
          },
          radius: 50000.0, // 50 km bias
        },
      };
      requestPayload.rankPreference = "DISTANCE";
    }

    const response = await axios.post(
      "https://places.googleapis.com/v1/places:searchText",
      requestPayload,
      {
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": GOOGLE_PLACES_API_KEY,
          "X-Goog-FieldMask":
            "places.displayName,places.nationalPhoneNumber,places.formattedAddress,places.rating,places.location",
        },
      }
    );

    const places = response.data.places || [];

    const fallbackName = options.authorizedOnly
      ? `${cleanBrand || cleanProduct} Authorized Service Center`
      : `${cleanProduct || cleanBrand} Repair Center`;

    let normalizedData = places.map((place) => {
      const placeLat = place.location?.latitude ?? null;
      const placeLng = place.location?.longitude ?? null;

      let distanceKm = null;
      if (coordinates && coordinates.lat !== null && coordinates.lng !== null && placeLat !== null && placeLng !== null) {
        distanceKm = parseFloat(
          calculateDistanceKm(coordinates.lat, coordinates.lng, placeLat, placeLng).toFixed(2)
        );
      }

      return {
        name: place.displayName?.text || fallbackName,
        phone: place.nationalPhoneNumber || "N/A",
        address: place.formattedAddress || "Address not available",
        rating: place.rating ? place.rating.toString() : "N/A",
        distanceKm,
        location: place.location || null,
      };
    });

    // 🛑 STRICT RADIUS FILTER: Drops anything outside maxDistanceKm
    if (coordinates && coordinates.lat !== null && coordinates.lng !== null) {
      const maxDistance = options.maxDistanceKm || 75;

      normalizedData = normalizedData
        .filter((p) => p.distanceKm !== null && p.distanceKm <= maxDistance)
        .sort((a, b) => a.distanceKm - b.distanceKm);
    }

    return normalizedData;
  } catch (error) {
    console.error(
      "Google Places API Error:",
      error.response?.data || error.message
    );
    throw new Error("Failed to fetch service centers from Google Places API.");
  }
};


export const scrapeHomeServices = async (serviceType, { pincode, lat, lng } = {}) => {
  try {
    const hasCoordinates = lat !== null && lng !== null && !isNaN(lat) && !isNaN(lng);

    // Construct payload for Google Places API (New)
    const requestBody = {
      textQuery: hasCoordinates 
        ? `${serviceType} services` 
        : `${serviceType} services in ${pincode}`
    };

    // If coordinates exist, bias results within a 15km radius of the user
    if (hasCoordinates) {
      requestBody.locationBias = {
        circle: {
          center: {
            latitude: Number(lat),
            longitude: Number(lng)
          },
          radius: 15000.0 // 15 km radius
        }
      };
    }

    const response = await axios.post(
      "https://places.googleapis.com/v1/places:searchText",
      requestBody,
      {
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": GOOGLE_PLACES_API_KEY,
          "X-Goog-FieldMask":
            "places.displayName,places.nationalPhoneNumber,places.formattedAddress,places.rating",
        },
      }
    );

    const places = response.data.places || [];

    const normalizedData = places.map((place) => ({
      name: place.displayName?.text || `${serviceType} Services`,
      phone: place.nationalPhoneNumber || "N/A",
      address: place.formattedAddress || "Address not available",
      rating: place.rating ? place.rating.toString() : "N/A",
      type: serviceType
    }));

    return normalizedData;
  } catch (error) {
    console.error(
      "Google Places API Error (Home Services):",
      error.response?.data || error.message
    );
    throw new Error("Failed to fetch nearby home services.");
  }
};