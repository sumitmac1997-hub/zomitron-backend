/**
 * Delivery ETA and cost calculation based on distance
 * Matches Zomitron hyperlocal model:
 *   - Same city (0-5km):    1 hour   - ₹0-29
 *   - Near (5-60km):        2 hours  - ₹30-49
 *   - Mid (60-100km):       1 day    - ₹50-79
 *   - Far (100-500km):      2-3 days - ₹80-149
 *   - Very far (>500km):    5-7 days - ₹150+
 */

const getDeliveryInfo = (distanceKm) => {
    if (distanceKm <= 5) {
        return {
            eta: '1 hour',
            etaLabel: '⚡ 1 Hr Delivery',
            etaType: 'express',
            estimatedDays: 0,
            estimatedHours: 1,
            deliveryCharge: 0,
            badge: '1hr',
            color: 'green',
        };
    } else if (distanceKm <= 60) {
        return {
            eta: '2 hours',
            etaLabel: '🚀 2 Hr Delivery',
            etaType: 'fast',
            estimatedDays: 0,
            estimatedHours: 2,
            deliveryCharge: Math.round(29 + (distanceKm - 5) * 0.36),
            badge: '2hr',
            color: 'blue',
        };
    } else if (distanceKm <= 100) {
        return {
            eta: '1 day',
            etaLabel: '📦 1 Day Delivery',
            etaType: 'standard',
            estimatedDays: 1,
            estimatedHours: 24,
            deliveryCharge: Math.round(50 + (distanceKm - 60) * 0.725),
            badge: '1day',
            color: 'orange',
        };
    } else if (distanceKm <= 500) {
        return {
            eta: '2-3 days',
            etaLabel: '🚚 2-3 Days Delivery',
            etaType: 'normal',
            estimatedDays: 3,
            estimatedHours: 72,
            deliveryCharge: Math.round(80 + (distanceKm - 100) * 0.175),
            badge: '2-3days',
            color: 'gray',
        };
    } else {
        return {
            eta: '5-7 days',
            etaLabel: '📬 5-7 Days Delivery',
            etaType: 'slow',
            estimatedDays: 7,
            estimatedHours: 168,
            deliveryCharge: Math.round(150 + (distanceKm - 500) * 0.05),
            badge: '5-7days',
            color: 'red',
        };
    }
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
    return distanceKm <= maxRadius;
};

module.exports = { getDeliveryInfo, getEstimatedDeliveryDate, isDeliveryAvailable };
