const express = require('express');
const router = express.Router();
const asyncHandler = require('express-async-handler');
const ShippingRule = require('../models/ShippingRule');
const { normalizeCity, calculateShippingQuote } = require('../utils/shippingRules');

// Ensure we always have at least one rule so checkout doesn't fail in fresh DBs
// (Removed ensureDefaultShippingRule: if admin deletes all rules, orders should be blocked instead of secretly allowing free shipping everywhere)

// GET /api/shipping/quote — compute customer shipping charge for a city/pincode/order value
router.get('/quote', asyncHandler(async (req, res) => {
    const { city, pincode, subtotal = 0, discount = 0 } = req.query;
    const cityNormalized = normalizeCity(city);

    if (!cityNormalized && !pincode) {
        return res.status(400).json({ success: false, message: 'City or pincode is required' });
    }

    // Fetch all active rules and let the matcher pick the best one
    const ruleList = await ShippingRule.find({ isActive: true }).sort({ updatedAt: -1 }).lean();
    const quote = calculateShippingQuote({ city, pincode, subtotal, discount }, ruleList);

    res.json({ success: true, quote, message: quote.message });
}));

module.exports = router;
