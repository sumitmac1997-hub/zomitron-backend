/**
 * Delivery ETA and cost calculation based on straight-line distance
 * between customer and vendor coordinates.
 * Distance bands:
 *   - 0-5km:      10 minutes
 *   - 5-10km:     15 minutes
 *   - 10-50km:    45 minutes
 *   - 50-70km:    1 hour
 *   - 70-100km:   2 hours
 *   - >100km:     Same day delivery
 */

const getDeliveryInfo = (distanceKm) => {
    if (!Number.isFinite(distanceKm) || distanceKm < 0) return null;

    if (distanceKm <= 5) {
        return {
            eta: '10 minutes',
            etaLabel: '⚡ 10 Min Delivery',
            etaType: 'express',
            estimatedDays: 0,
            estimatedHours: 0.17,
            deliveryCharge: 0,
            badge: '10min',
            color: 'green',
        };
    } else if (distanceKm <= 10) {
        return {
            eta: '15 minutes',
            etaLabel: '⚡ 15 Min Delivery',
            etaType: 'fast',
            estimatedDays: 0,
            estimatedHours: 0.25,
            deliveryCharge: 10,
            badge: '15min',
            color: 'green',
        };
    } else if (distanceKm <= 50) {
        return {
            eta: '45 minutes',
            etaLabel: '⚡ 45 Min Delivery',
            etaType: 'standard',
            estimatedDays: 0,
            estimatedHours: 0.75,
            deliveryCharge: Math.round(15 + (distanceKm - 10) * 0.35),
            badge: '45min',
            color: 'blue',
        };
    } else if (distanceKm <= 70) {
        return {
            eta: '1 hour',
            etaLabel: '⚡ 1 Hr Delivery',
            etaType: 'normal',
            estimatedDays: 0,
            estimatedHours: 1,
            deliveryCharge: Math.round(29 + (distanceKm - 50) * 0.8),
            badge: '1hr',
            color: 'orange',
        };
    } else if (distanceKm <= 100) {
        return {
            eta: '2 hours',
            etaLabel: '🚀 2 Hr Delivery',
            etaType: 'slow',
            estimatedDays: 0,
            estimatedHours: 2,
            deliveryCharge: Math.round(45 + (distanceKm - 70) * 1),
            badge: '2hr',
            color: 'gray',
        };
    }

    return {
        eta: '3 hours (same day)',
        etaLabel: '📦 Same Day Delivery',
        etaType: 'same_day',
        estimatedDays: 0,
        estimatedHours: 3,
        deliveryCharge: Math.round(75 + (distanceKm - 100) * 0.25),
        badge: 'same-day',
        color: 'gray',
    };
};

/**
 * Get estimated delivery date
 */
const getEstimatedDeliveryDate = (distanceKm) => {
    const info = getDeliveryInfo(distanceKm);
    const now = new Date();
    if (info.estimatedDays === 0) {
        return new Date(now.getTime() + info.estimatedHours * 60 * 60 * 1000);
    }
    const delivery = new Date(now);
    delivery.setDate(delivery.getDate() + info.estimatedDays);
    return delivery;
};

/**
 * Check if delivery is available (within 100km by default)
 */
const isDeliveryAvailable = (distanceKm, maxRadius = 100) => {
    return Number.isFinite(distanceKm) && distanceKm <= maxRadius;
};

module.exports = { getDeliveryInfo, getEstimatedDeliveryDate, isDeliveryAvailable };
