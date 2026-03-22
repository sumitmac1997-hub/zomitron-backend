const express = require('express');
const router = express.Router();
const asyncHandler = require('express-async-handler');
const Pincode = require('../models/Pincode');
const { geocodePincode } = require('../utils/geocode');
const { haversineDistance } = require('../utils/haversine');
const { getDeliveryInfo, isDeliveryAvailable } = require('../utils/deliveryETA');
const { localPincodes } = require('../utils/localPincodes');
const { buildCacheKey, getCacheEntry, setCacheEntry } = require('../utils/cache');

const PINCODE_CACHE_PREFIX = 'pincode';
const PINCODE_CACHE_TTL_SECONDS = Number(process.env.PINCODE_CACHE_TTL_SECONDS) || 60 * 10;
const PINCODE_SEARCH_CACHE_TTL_SECONDS = Number(process.env.PINCODE_SEARCH_CACHE_TTL_SECONDS) || 60;

const clean = (value) => (value ?? '').toString().trim();
const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const parsePositiveInt = (value, fallback, max = Number.MAX_SAFE_INTEGER) => {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return Math.min(parsed, max);
};

const resolvePincodeData = async (code) => {
    let pincodeData = await Pincode.findOne({ pincode: code }).lean();
    if (pincodeData) return pincodeData;

    const local = localPincodes.get(code);
    if (local) {
        return { pincode: code, city: local.city, state: local.state, lat: local.lat, lng: local.lng };
    }

    const geo = await geocodePincode(code);
    if (!geo) return null;

    return { pincode: code, city: geo.city, state: geo.state, lat: geo.lat, lng: geo.lng };
};

// GET /api/pincode/search?q=prayagraj — Search by city name
router.get('/search', asyncHandler(async (req, res) => {
    const query = clean(req.query.q).slice(0, 60);
    const limit = parsePositiveInt(req.query.limit, 10, 25);

    if (!query) return res.status(400).json({ success: false, message: 'Search query required' });

    const cacheKey = buildCacheKey(`${PINCODE_CACHE_PREFIX}:search`, { query, limit });
    const cached = getCacheEntry(cacheKey);
    if (cached) return res.json(cached);

    const safeRegex = new RegExp(escapeRegex(query), 'i');
    const pincodes = await Pincode.find({
        $or: [
            { city: safeRegex },
            { district: safeRegex },
            { pincode: { $regex: `^${escapeRegex(query)}` } },
        ],
    }).limit(limit).lean();

    const response = { success: true, pincodes };
    setCacheEntry(cacheKey, response, PINCODE_SEARCH_CACHE_TTL_SECONDS);
    res.json(response);
}));

// GET /api/pincode/:code — Validate pincode and get location
router.get('/:code', asyncHandler(async (req, res) => {
    const { code } = req.params;
    const { vendorLat, vendorLng, customerLat, customerLng } = req.query;

    if (!/^\d{6}$/.test(code)) {
        return res.status(400).json({ success: false, message: 'Invalid pincode format. Must be 6 digits.' });
    }

    const cacheKey = buildCacheKey(`${PINCODE_CACHE_PREFIX}:lookup`, {
        code,
        vendorLat,
        vendorLng,
        customerLat,
        customerLng,
    });
    const cached = getCacheEntry(cacheKey);
    if (cached) return res.json(cached);

    const pincodeData = await resolvePincodeData(code);
    if (!pincodeData) return res.status(404).json({ success: false, message: 'We currently do not deliver to this pincode.' });

    const result = {
        success: true,
        pincode: code,
        city: pincodeData.city,
        state: pincodeData.state,
        lat: pincodeData.lat,
        lng: pincodeData.lng,
    };

    // If vendor location provided, calculate delivery info
    if (vendorLat && vendorLng) {
        const distance = haversineDistance(parseFloat(vendorLat), parseFloat(vendorLng), pincodeData.lat, pincodeData.lng);
        result.distance = Math.round(distance);
        result.deliveryAvailable = isDeliveryAvailable(distance);
        result.deliveryInfo = getDeliveryInfo(distance);
    }

    // If customer location provided, show distance from customer
    if (customerLat && customerLng) {
        const customerDistance = haversineDistance(parseFloat(customerLat), parseFloat(customerLng), pincodeData.lat, pincodeData.lng);
        result.customerDistance = Math.round(customerDistance);
    }

    setCacheEntry(cacheKey, result, PINCODE_CACHE_TTL_SECONDS);
    res.json(result);
}));

// POST /api/pincode/validate-delivery — Check delivery between 2 pincodes
router.post('/validate-delivery', asyncHandler(async (req, res) => {
    const { fromPincode, toPincode } = req.body;
    if (!/^\d{6}$/.test(fromPincode) || !/^\d{6}$/.test(toPincode)) {
        return res.status(400).json({ success: false, message: 'Both pincodes must be 6 digits' });
    }

    const cacheKey = buildCacheKey(`${PINCODE_CACHE_PREFIX}:validate-delivery`, { fromPincode, toPincode });
    const cached = getCacheEntry(cacheKey);
    if (cached) return res.json(cached);

    const [from, to] = await Promise.all([
        resolvePincodeData(fromPincode),
        resolvePincodeData(toPincode),
    ]);

    if (!from || !to) return res.status(404).json({ success: false, message: 'One or both pincodes not found' });

    const distance = haversineDistance(from.lat, from.lng, to.lat, to.lng);
    const deliveryInfo = getDeliveryInfo(distance);

    const response = {
        success: true,
        from: { pincode: fromPincode, city: from.city, state: from.state },
        to: { pincode: toPincode, city: to.city, state: to.state },
        distance: Math.round(distance),
        deliveryAvailable: isDeliveryAvailable(distance),
        deliveryInfo,
    };

    setCacheEntry(cacheKey, response, PINCODE_CACHE_TTL_SECONDS);
    res.json(response);
}));

module.exports = router;
