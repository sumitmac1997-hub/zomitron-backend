/**
 * Haversine Formula - Calculate distance between two lat/lng points
 * Returns distance in kilometers
 */
const haversineDistance = (lat1, lng1, lat2, lng2) => {
    const R = 6371; // Earth radius in km
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
        Math.sin(dLng / 2) * Math.sin(dLng / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
};

const toRad = (deg) => (deg * Math.PI) / 180;

/**
 * Check if a point (lat2, lng2) is within radius km of (lat1, lng1)
 */
const isWithinRadius = (lat1, lng1, lat2, lng2, radiusKm = 100) => {
    return haversineDistance(lat1, lng1, lat2, lng2) <= radiusKm;
};

/**
 * Filter an array of items by distance from a center point
 * Items must have lat/lng or location.coordinates fields
 */
const filterByRadius = (items, centerLat, centerLng, radiusKm = 100) => {
    return items
        .map((item) => {
            let itemLat, itemLng;
            if (item.location?.coordinates) {
                [itemLng, itemLat] = item.location.coordinates;
            } else {
                itemLat = item.lat;
                itemLng = item.lng;
            }
            const distance = haversineDistance(centerLat, centerLng, itemLat, itemLng);
            return { ...item.toObject ? item.toObject() : item, distance };
        })
        .filter((item) => item.distance <= radiusKm)
        .sort((a, b) => a.distance - b.distance);
};

module.exports = { haversineDistance, isWithinRadius, filterByRadius, toRad };
