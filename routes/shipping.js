const express = require('express');
const router = express.Router();
const asyncHandler = require('express-async-handler');
const ShippingRule = require('../models/ShippingRule');
const { normalizeCity, calculateShippingQuote } = require('../utils/shippingRules');

// Ensure we always have at least one rule so checkout doesn't fail in fresh DBs
const ensureDefaultShippingRule = async () => {
    const existing = await ShippingRule.findOne({ isActive: true });
    if (existing) return;
    await ShippingRule.create({
        city: '*',
        cityNormalized: '*',
        pincodeRanges: [{ start: '000000', end: '999999' }],
        shippingCharge: 0,
        freeShippingThreshold: 0,
        isActive: true,
    });
};

// GET /api/shipping/quote — compute customer shipping charge for a city/pincode/order value
router.get('/quote', asyncHandler(async (req, res) => {
    const { city, pincode, subtotal = 0, discount = 0 } = req.query;
    const cityNormalized = normalizeCity(city);

    if (!cityNormalized && !pincode) {
        return res.status(400).json({ success: false, message: 'City or pincode is required' });
    }

    await ensureDefaultShippingRule();

    // Fetch all active rules and let the matcher pick the best one
    const ruleList = await ShippingRule.find({ isActive: true }).sort({ updatedAt: -1 }).lean();
    const quote = calculateShippingQuote({ city, pincode, subtotal, discount }, ruleList);

    res.json({ success: true, quote, message: quote.message });
}));

module.exports = router;
