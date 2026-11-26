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



export const scrapeServiceCenters = async (
  brand,
  product,
  coordinates, // { lat: number, lng: number } - Strictly required
  options = { authorizedOnly: false, maxDistanceKm: 75 }
) => {
  try {
    const hasBrand = brand && brand.trim() && brand.toUpperCase() !== 'N/A';
    const cleanBrand = hasBrand ? brand.trim() : '';
    const cleanProduct = product ? product.trim() : '';

    const suffix = options.authorizedOnly ? 'authorized service center' : 'repair service center';
    const queryTerm = [cleanBrand, cleanProduct, suffix].filter(Boolean).join(' ');

    // 1. Text Query is clean (no location strings attached)
    const requestPayload = {
      textQuery: queryTerm,
      locationBias: {
        circle: {
          center: {
            latitude: coordinates.lat,
            longitude: coordinates.lng,
          },
          radius: 50000.0, // 50 km circular spatial bias around pin
        },
      },
    };

    const response = await axios.post(
      'https://places.googleapis.com/v1/places:searchText',
      requestPayload,
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': GOOGLE_PLACES_API_KEY,
          'X-Goog-FieldMask':
            'places.displayName,places.nationalPhoneNumber,places.formattedAddress,places.rating,places.location',
        },
      }
    );

    const places = response.data.places || [];

    const fallbackName = options.authorizedOnly
      ? `${cleanBrand || cleanProduct} Authorized Service Center`
      : `${cleanProduct || cleanBrand} Repair Center`;

    // 2. Measure true Haversine distance from target pin to each place
    let normalizedData = places.map((place) => {
      const placeLat = place.location?.latitude ?? null;
      const placeLng = place.location?.longitude ?? null;

      let distanceKm = null;
      if (placeLat !== null && placeLng !== null) {
        distanceKm = parseFloat(
          calculateDistanceKm(coordinates.lat, coordinates.lng, placeLat, placeLng).toFixed(2)
        );
      }

      return {
        name: place.displayName?.text || fallbackName,
        phone: place.nationalPhoneNumber || 'N/A',
        address: place.formattedAddress || 'Address not available',
        rating: place.rating ? place.rating.toString() : 'N/A',
        distanceKm,
        location: place.location || null,
      };
    });

    // 3. Drop anything beyond max cutoff and enforce strict nearest-first ordering
    const maxDistance = options.maxDistanceKm || 75;

    return normalizedData
      .filter((p) => p.distanceKm !== null && p.distanceKm <= maxDistance)
      .sort((a, b) => a.distanceKm - b.distanceKm);

  } catch (error) {
    console.error(
      'Google Places API Error:',
      error.response?.data || error.message
    );
    throw new Error('Failed to fetch service centers from Google Places API.');
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