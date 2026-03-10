const express = require('express');
const router = express.Router();
const asyncHandler = require('express-async-handler');
const ShippingRule = require('../models/ShippingRule');
const { normalizeCity, calculateShippingQuote } = require('../utils/shippingRules');

// GET /api/shipping/quote — compute customer shipping charge for a city/pincode/order value
router.get('/quote', asyncHandler(async (req, res) => {
    const { city, pincode, subtotal = 0, discount = 0 } = req.query;
    const cityNormalized = normalizeCity(city);

    if (!cityNormalized && !pincode) {
        return res.status(400).json({ success: false, message: 'City or pincode is required' });
    }

    const query = cityNormalized ? { isActive: true, cityNormalized } : { isActive: true };
    const rules = await ShippingRule.find(query).sort({ updatedAt: -1 }).lean();
    const quote = calculateShippingQuote({ city, pincode, subtotal, discount }, rules);

    res.json({
        success: true,
        quote,
        message: quote.matched ? undefined : quote.message,
    });
}));

module.exports = router;
