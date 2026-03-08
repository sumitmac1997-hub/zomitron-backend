const express = require('express');
const router = express.Router();
const asyncHandler = require('express-async-handler');
const Pincode = require('../models/Pincode');
const { geocodePincode } = require('../utils/geocode');
const { haversineDistance } = require('../utils/haversine');
const { getDeliveryInfo, isDeliveryAvailable } = require('../utils/deliveryETA');
const { localPincodes } = require('../utils/localPincodes');

// GET /api/pincode/:code — Validate pincode and get location
router.get('/:code', asyncHandler(async (req, res) => {
    const { code } = req.params;
    const { vendorLat, vendorLng, customerLat, customerLng } = req.query;

    if (!/^\d{6}$/.test(code)) {
        return res.status(400).json({ success: false, message: 'Invalid pincode format. Must be 6 digits.' });
    }

    // Fetch pincode data
    let pincodeData = await Pincode.findOne({ pincode: code }).lean();
    if (!pincodeData) {
        const local = localPincodes.get(code);
        if (local) {
            pincodeData = { pincode: code, city: local.city, state: local.state, lat: local.lat, lng: local.lng };
        } else {
            const geo = await geocodePincode(code);
            if (!geo) return res.status(404).json({ success: false, message: 'We currently do not deliver to this pincode.' });
            pincodeData = { pincode: code, city: geo.city, state: geo.state, lat: geo.lat, lng: geo.lng };
        }
    }

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

    res.json(result);
}));

// GET /api/pincode/search?q=prayagraj — Search by city name
router.get('/search', asyncHandler(async (req, res) => {
    const { q, limit = 10 } = req.query;
    if (!q) return res.status(400).json({ success: false, message: 'Search query required' });

    const pincodes = await Pincode.find({
        $or: [
            { city: { $regex: q, $options: 'i' } },
            { district: { $regex: q, $options: 'i' } },
            { pincode: { $regex: `^${q}` } },
        ],
    }).limit(parseInt(limit)).lean();

    res.json({ success: true, pincodes });
}));

// POST /api/pincode/validate-delivery — Check delivery between 2 pincodes
router.post('/validate-delivery', asyncHandler(async (req, res) => {
    const { fromPincode, toPincode } = req.body;
    if (!/^\d{6}$/.test(fromPincode) || !/^\d{6}$/.test(toPincode)) {
        return res.status(400).json({ success: false, message: 'Both pincodes must be 6 digits' });
    }

    const [from, to] = await Promise.all([
        Pincode.findOne({ pincode: fromPincode }).lean() || geocodePincode(fromPincode),
        Pincode.findOne({ pincode: toPincode }).lean() || geocodePincode(toPincode),
    ]);

    if (!from || !to) return res.status(404).json({ success: false, message: 'One or both pincodes not found' });

    const distance = haversineDistance(from.lat, from.lng, to.lat, to.lng);
    const deliveryInfo = getDeliveryInfo(distance);

    res.json({
        success: true,
        from: { pincode: fromPincode, city: from.city, state: from.state },
        to: { pincode: toPincode, city: to.city, state: to.state },
        distance: Math.round(distance),
        deliveryAvailable: isDeliveryAvailable(distance),
        deliveryInfo,
    });
}));

module.exports = router;
