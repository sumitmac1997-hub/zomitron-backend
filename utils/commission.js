/**
 * Calculate commission split between platform and vendor
 */
const calculateCommission = (orderTotal, commissionRate = 0.1) => {
    const platformFee = Math.round(orderTotal * commissionRate * 100) / 100;
    const vendorPayout = Math.round((orderTotal - platformFee) * 100) / 100;
    return { platformFee, vendorPayout, commissionRate };
};

/**
 * Calculate payouts for multi-vendor order
 * Returns { platformTotal, vendorPayouts: { vendorId: amount } }
 */
const calculateMultiVendorPayouts = (items, commissionRates = {}) => {
    const vendorSubtotals = {};

    items.forEach((item) => {
        const vendorId = item.vendorId.toString();
        if (!vendorSubtotals[vendorId]) vendorSubtotals[vendorId] = 0;
        vendorSubtotals[vendorId] += item.price * item.qty;
    });

    const vendorPayouts = {};
    let platformTotal = 0;

    Object.entries(vendorSubtotals).forEach(([vendorId, subtotal]) => {
        const rate = commissionRates[vendorId] || 0.1;
        const { platformFee, vendorPayout } = calculateCommission(subtotal, rate);
        vendorPayouts[vendorId] = vendorPayout;
        platformTotal += platformFee;
    });

    return {
        platformTotal: Math.round(platformTotal * 100) / 100,
        vendorPayouts,
    };
};

module.exports = { calculateCommission, calculateMultiVendorPayouts };
