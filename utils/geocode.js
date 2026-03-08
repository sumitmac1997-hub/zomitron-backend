const axios = require('axios');

/**
 * Convert pincode to lat/lng using Google Maps Geocoding API
 * Falls back to MongoDB Pincode collection
 */
const geocodePincode = async (pincode) => {
    // First try MongoDB Pincode collection
    try {
        const Pincode = require('../models/Pincode');
        const pincodeDoc = await Pincode.findOne({ pincode: String(pincode) });
        if (pincodeDoc) {
            return {
                lat: pincodeDoc.lat,
                lng: pincodeDoc.lng,
                city: pincodeDoc.city,
                state: pincodeDoc.state,
                source: 'db',
            };
        }
    } catch (err) {
        console.error('Pincode DB lookup failed:', err.message);
    }

    // Fallback to Google Maps Geocoding API
    if (process.env.GOOGLE_MAPS_API_KEY) {
        try {
            const response = await axios.get('https://maps.googleapis.com/maps/api/geocode/json', {
                params: {
                    address: `${pincode}, India`,
                    key: process.env.GOOGLE_MAPS_API_KEY,
                },
                timeout: 5000,
            });
            if (response.data.results && response.data.results.length > 0) {
                const { lat, lng } = response.data.results[0].geometry.location;
                const addressComponents = response.data.results[0].address_components;
                const cityComp = addressComponents.find((c) => c.types.includes('locality'));
                const stateComp = addressComponents.find((c) => c.types.includes('administrative_area_level_1'));
                return {
                    lat,
                    lng,
                    city: cityComp?.long_name || '',
                    state: stateComp?.long_name || '',
                    source: 'google',
                };
            }
        } catch (err) {
            console.error('Google Geocoding failed:', err.message);
        }
    }

    // Fallback to free geocoding API
    try {
        const response = await axios.get(`https://api.postalpincode.in/pincode/${pincode}`, { timeout: 5000 });
        const data = response.data?.[0];
        if (data?.Status === 'Success' && data.PostOffice?.length > 0) {
            const po = data.PostOffice[0];
            // Use approximate city-level coords from a secondary geocoding
            const geoRes = await axios.get(`https://nominatim.openstreetmap.org/search`, {
                params: { q: `${po.Name}, ${po.District}, ${po.State}, India`, format: 'json', limit: 1 },
                headers: { 'User-Agent': 'Zomitron/1.0' },
                timeout: 5000,
            });
            if (geoRes.data?.[0]) {
                return {
                    lat: parseFloat(geoRes.data[0].lat),
                    lng: parseFloat(geoRes.data[0].lon),
                    city: po.District,
                    state: po.State,
                    source: 'nominatim',
                };
            }
        }
    } catch (err) {
        console.error('PostalPincode API failed:', err.message);
    }

    return null;
};

/**
 * Get lat/lng from address string using Google Maps
 */
const geocodeAddress = async (address) => {
    if (!process.env.GOOGLE_MAPS_API_KEY) return null;
    try {
        const response = await axios.get('https://maps.googleapis.com/maps/api/geocode/json', {
            params: { address, key: process.env.GOOGLE_MAPS_API_KEY },
            timeout: 5000,
        });
        if (response.data.results?.length > 0) {
            return response.data.results[0].geometry.location;
        }
    } catch (err) {
        console.error('Geocode address failed:', err.message);
    }
    return null;
};

module.exports = { geocodePincode, geocodeAddress };
