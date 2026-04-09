const express = require('express');
const router = express.Router();
const asyncHandler = require('express-async-handler');
const Vendor = require('../models/Vendor');
const User = require('../models/User');
const Product = require('../models/Product');
const Order = require('../models/Order');
const { protect, authorize } = require('../middleware/auth');
const { geocodePincode } = require('../utils/geocode');
const { uploadVendor, toUploadUrl } = require('../config/cloudinary');

const CITY_COORDS_FALLBACK = {
    prayagraj: { lat: 25.4358, lng: 81.8463, state: 'Uttar Pradesh' },
    allahabad: { lat: 25.4358, lng: 81.8463, state: 'Uttar Pradesh' },
    lucknow: { lat: 26.8467, lng: 80.9462, state: 'Uttar Pradesh' },
    varanasi: { lat: 25.3176, lng: 82.9739, state: 'Uttar Pradesh' },
    kanpur: { lat: 26.4499, lng: 80.3319, state: 'Uttar Pradesh' },
    bangalore: { lat: 12.9716, lng: 77.5946, state: 'Karnataka' },
    bengaluru: { lat: 12.9716, lng: 77.5946, state: 'Karnataka' },
    mumbai: { lat: 19.076, lng: 72.8777, state: 'Maharashtra' },
    delhi: { lat: 28.6139, lng: 77.209, state: 'Delhi' },
    'new delhi': { lat: 28.6139, lng: 77.209, state: 'Delhi' },
};

const PINCODE_PREFIX_FALLBACK = {
    '110': { lat: 28.6139, lng: 77.209, city: 'New Delhi', state: 'Delhi' },
    '208': { lat: 26.4499, lng: 80.3319, city: 'Kanpur', state: 'Uttar Pradesh' },
    '211': { lat: 25.4358, lng: 81.8463, city: 'Prayagraj', state: 'Uttar Pradesh' },
    '221': { lat: 25.3176, lng: 82.9739, city: 'Varanasi', state: 'Uttar Pradesh' },
    '226': { lat: 26.8467, lng: 80.9462, city: 'Lucknow', state: 'Uttar Pradesh' },
    '400': { lat: 19.076, lng: 72.8777, city: 'Mumbai', state: 'Maharashtra' },
    '560': { lat: 12.9716, lng: 77.5946, city: 'Bangalore', state: 'Karnataka' },
};

const isValidCoord = (val) => Number.isFinite(val);
const ALLOWED_VENDOR_FULFILL_STATUS = ['pending', 'confirmed', 'processing', 'shipped', 'out_for_delivery', 'delivered', 'cancelled'];
const STATUS_PRIORITY = ['pending', 'confirmed', 'processing', 'shipped', 'out_for_delivery', 'delivered'];

const deriveOverallStatus = (fulfillments = []) => {
    if (!fulfillments.length) return 'pending';
    if (fulfillments.some((f) => f.status === 'cancelled')) return 'cancelled';
    if (fulfillments.every((f) => f.status === 'delivered')) return 'delivered';
    const highest = fulfillments.reduce((acc, curr) => {
        const idx = STATUS_PRIORITY.indexOf(curr.status);
        return idx > acc ? idx : acc;
    }, 0);
    return STATUS_PRIORITY[highest] || 'pending';
};

// POST /api/vendors/register — Vendor registration
router.post('/register', protect, asyncHandler(async (req, res) => {
    const existing = await Vendor.findOne({ userId: req.user._id });
    if (existing) return res.status(400).json({ success: false, message: 'Vendor profile already exists' });

    const { storeName, storeDescription, pincode, phone, email, gstin } = req.body;
    let { lat, lng, city, state } = req.body;
    let { address, addressLine1, addressLine2, bankDetails, bankAccountNumber, ifsc, accountName } = req.body;

    // Accept flat payload from frontend vendor form and normalize it to schema shape.
    if (!address && addressLine1) {
        address = {
            line1: addressLine1,
            line2: addressLine2 || '',
            city,
            state,
            pincode,
        };
    }
    if (address && typeof address === 'string') {
        address = JSON.parse(address);
    }
    if (bankDetails && typeof bankDetails === 'string') {
        bankDetails = JSON.parse(bankDetails);
    }

    if (lat !== undefined) lat = parseFloat(lat);
    if (lng !== undefined) lng = parseFloat(lng);
    const cityKey = String(city || '').trim().toLowerCase();

    // Auto-geocode if no valid lat/lng given
    if (!isValidCoord(lat) || !isValidCoord(lng)) {
        const geo = await geocodePincode(pincode);
        if (geo) {
            lat = parseFloat(geo.lat);
            lng = parseFloat(geo.lng);
            city = city || geo.city;
            state = state || geo.state;
        }
    }

    // Fallback to known city center if pincode geocoding fails
    if ((!isValidCoord(lat) || !isValidCoord(lng)) && cityKey && CITY_COORDS_FALLBACK[cityKey]) {
        lat = CITY_COORDS_FALLBACK[cityKey].lat;
        lng = CITY_COORDS_FALLBACK[cityKey].lng;
        state = state || CITY_COORDS_FALLBACK[cityKey].state;
    }

    // Fallback by pincode prefix
    if ((!isValidCoord(lat) || !isValidCoord(lng)) && /^\d{6}$/.test(String(pincode || ''))) {
        const prefix = String(pincode).slice(0, 3);
        const fallback = PINCODE_PREFIX_FALLBACK[prefix];
        if (fallback) {
            lat = fallback.lat;
            lng = fallback.lng;
            city = city || fallback.city;
            state = state || fallback.state;
        }
    }

    // Final fallback to keep registration flowing (stores still save)
    if (!isValidCoord(lat) || !isValidCoord(lng)) {
        lat = 0;
        lng = 0;
        city = city || 'NA';
        state = state || 'NA';
    }
    if (!address?.line1 || !address?.city || !address?.state || !address?.pincode) {
        address = {
            line1: address?.line1 || storeName || 'Store Address',
            city: address?.city || city || 'NA',
            state: address?.state || state || 'NA',
            pincode: address?.pincode || pincode || '000000',
            line2: address?.line2 || '',
        };
    }

    const vendor = await Vendor.create({
        userId: req.user._id,
        storeName, storeDescription, phone, email, gstin,
        address,
        city, state,
        pincode,
        bankDetails: {
            accountName: bankDetails?.accountName || accountName || '',
            accountNumber: bankDetails?.accountNumber || bankAccountNumber || '',
            ifscCode: bankDetails?.ifscCode || ifsc || '',
            bankName: bankDetails?.bankName || '',
            upiId: bankDetails?.upiId || '',
        },
        location: { type: 'Point', coordinates: [parseFloat(lng), parseFloat(lat)] },
        approved: false,
    });

    // Update user role to vendor
    await User.findByIdAndUpdate(req.user._id, { role: 'vendor' });

    // Notify admin via db + io
    const io = req.app.get('io');
    const { notifyAdmin } = require('../utils/adminNotificationEngine');
    await notifyAdmin(io, {
        type: 'new_vendor',
        message: `New Vendor Application: ${storeName}`,
        link: '/admin/vendors',
        relatedId: vendor._id
    });

    res.status(201).json({
        success: true,
        message: 'Vendor registration submitted. Awaiting admin approval.',
        vendor,
    });
}));

// GET /api/vendors/me — Current vendor profile
router.get('/me', protect, authorize('vendor', 'admin'), asyncHandler(async (req, res) => {
    const vendor = await Vendor.findOne({ userId: req.user._id }).populate('userId', 'name email phone avatar createdAt');
    if (!vendor) return res.status(404).json({ success: false, message: 'Vendor profile not found' });
    res.json({ success: true, vendor });
}));

// PUT /api/vendors/me — Update vendor profile
router.put('/me', protect, authorize('vendor'), uploadVendor.fields([
    { name: 'storeLogo', maxCount: 1 },
    { name: 'storeBanner', maxCount: 1 },
]), asyncHandler(async (req, res) => {
    const vendor = await Vendor.findOne({ userId: req.user._id });
    if (!vendor) return res.status(404).json({ success: false, message: 'Vendor not found' });

    const updates = { ...req.body };
    if (req.files?.storeLogo) updates.storeLogo = toUploadUrl(req.files.storeLogo[0]);
    if (req.files?.storeBanner) updates.storeBanner = toUploadUrl(req.files.storeBanner[0]);

    // Re-geocode if pincode changed
    if (updates.pincode && updates.pincode !== vendor.pincode) {
        const geo = await geocodePincode(updates.pincode);
        if (geo) {
            updates.location = { type: 'Point', coordinates: [geo.lng, geo.lat] };
            updates.city = updates.city || geo.city;
            updates.state = updates.state || geo.state;
            // Update all products location
            await Product.updateMany(
                { vendorId: vendor._id },
                { location: updates.location, pincode: updates.pincode, city: updates.city }
            );
        }
    }

    if (updates.address && typeof updates.address === 'string') updates.address = JSON.parse(updates.address);
    if (updates.storeHours && typeof updates.storeHours === 'string') updates.storeHours = JSON.parse(updates.storeHours);
    if (updates.bankDetails && typeof updates.bankDetails === 'string') updates.bankDetails = JSON.parse(updates.bankDetails);

    const updated = await Vendor.findByIdAndUpdate(vendor._id, updates, { new: true, runValidators: true });
    res.json({ success: true, vendor: updated });
}));

// GET /api/vendors/:id — Public vendor profile
router.get('/:id', asyncHandler(async (req, res) => {
    const vendor = await Vendor.findById(req.params.id)
        .populate('userId', 'name avatar')
        .lean();
    if (!vendor || !vendor.approved) return res.status(404).json({ success: false, message: 'Vendor not found' });
    res.json({ success: true, vendor });
}));

// PUT /api/vendors/me/open — toggle store open/close
router.put('/me/open', protect, authorize('vendor'), asyncHandler(async (req, res) => {
    const { isOpen } = req.body;
    const vendor = await Vendor.findOneAndUpdate(
        { userId: req.user._id },
        { isOpen: !!isOpen },
        { new: true }
    );
    if (!vendor) return res.status(404).json({ success: false, message: 'Vendor not found' });
    res.json({ success: true, vendor });
}));

// GET /api/vendors/:id/products — Vendor's public products
router.get('/:id/products', asyncHandler(async (req, res) => {
    const { page = 1, limit = 20, category } = req.query;
    const query = { vendorId: req.params.id, isActive: true, isApproved: true };
    if (category) query.$or = [{ category }, { categories: category }];

    const vendor = await Vendor.findById(req.params.id).lean();
    if (!vendor || vendor.isOpen === false) {
        return res.json({ success: true, products: [], total: 0, page: 1, pages: 0 });
    }

    const total = await Product.countDocuments(query);
    const products = await Product.find(query)
        .skip((parseInt(page) - 1) * parseInt(limit))
        .limit(parseInt(limit))
        .populate('category', 'name slug icon')
        .lean();

    res.json({ success: true, products, total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)) });
}));

// GET /api/vendors/me/orders — Vendor's orders
router.get('/me/orders', protect, authorize('vendor'), asyncHandler(async (req, res) => {
    const vendor = await Vendor.findOne({ userId: req.user._id });
    if (!vendor) return res.status(404).json({ success: false, message: 'Vendor not found' });

    const { page = 1, limit = 20, status } = req.query;
    const query = { vendorIds: vendor._id, isPlaced: { $ne: false } };
    if (status) query.orderStatus = status;

    const total = await Order.countDocuments(query);
    const orders = await Order.find(query)
        .populate('customerId', 'name email phone')
        .sort({ createdAt: -1 })
        .skip((parseInt(page) - 1) * parseInt(limit))
        .limit(parseInt(limit))
        .lean();

    const enhancedOrders = orders.map((order) => {
        const vendorItems = (order.items || []).filter((item) => String(item.vendorId) === String(vendor._id));
        const vendorSubtotal = vendorItems.reduce((sum, item) => sum + ((item.price || 0) * (item.qty || 0)), 0);
        const fulfillment = (order.vendorFulfillments || []).find((f) => String(f.vendorId) === String(vendor._id));
        return {
            ...order,
            vendorItems,
            vendorSubtotal,
            vendorStatus: fulfillment?.status || 'pending',
            vendorTrackingCode: fulfillment?.trackingCode || null,
        };
    });

    res.json({ success: true, orders: enhancedOrders, total });
}));

// PUT /api/vendors/orders/:orderId/fulfill
router.put('/orders/:orderId/fulfill', protect, authorize('vendor'), asyncHandler(async (req, res) => {
    const vendor = await Vendor.findOne({ userId: req.user._id });
    if (!vendor) return res.status(404).json({ success: false, message: 'Vendor not found' });
    const { status, trackingCode } = req.body;
    if (!ALLOWED_VENDOR_FULFILL_STATUS.includes(status)) {
        return res.status(400).json({ success: false, message: 'Invalid fulfillment status' });
    }

    const order = await Order.findOne({ _id: req.params.orderId, isPlaced: { $ne: false } });
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    if (!order.vendorIds.some(id => id.toString() === vendor._id.toString())) {
        return res.status(403).json({ success: false, message: 'Not your order' });
    }

    // Update vendor-specific fulfillment
    const fulfillment = order.vendorFulfillments.find(f => f.vendorId.toString() === vendor._id.toString());
    if (fulfillment) {
        fulfillment.status = status;
        if (trackingCode) fulfillment.trackingCode = trackingCode;
        if (status === 'shipped') fulfillment.shippedAt = new Date();
        if (status === 'delivered') fulfillment.fulfilledAt = new Date();
    } else {
        order.vendorFulfillments.push({ vendorId: vendor._id, status, trackingCode });
    }

    // Derive overall order status from vendor fulfillments
    const overallStatus = deriveOverallStatus(order.vendorFulfillments);
    order.orderStatus = overallStatus;

    // Timestamps + accounting side-effects
    if (overallStatus === 'cancelled' && !order.cancelledAt) {
        order.cancelledAt = new Date();
        for (const item of order.items) {
            await Product.findByIdAndUpdate(item.productId, { $inc: { stock: item.qty } });
        }
    }
    if (overallStatus === 'confirmed' && !order.confirmedAt) {
        order.confirmedAt = new Date();
    }
    if (overallStatus === 'shipped' || overallStatus === 'out_for_delivery') {
        order.shippedAt = order.shippedAt || new Date();
    }
    if (overallStatus === 'delivered' && !order.deliveredAt) {
        order.deliveredAt = new Date();
        order.paymentStatus = 'paid';
        for (const [vendorId, amount] of order.vendorPayouts.entries()) {
            await Vendor.findByIdAndUpdate(vendorId, { $inc: { balance: amount, totalEarnings: amount } });
        }
    }

    await order.save();

    // Notify customer
    const io = req.app.get('io');
    if (io) {
        io.emitToUser(order.customerId?.toString(), 'orderUpdate', { orderId: order._id, status });
        io.emitOrderUpdate(order._id.toString(), { status, trackingCode });
    }

    res.json({ success: true, order });
}));

// GET /api/vendors/me/earnings — Vendor earnings
router.get('/me/earnings', protect, authorize('vendor'), asyncHandler(async (req, res) => {
    const vendor = await Vendor.findOne({ userId: req.user._id });
    if (!vendor) return res.status(404).json({ success: false, message: 'Vendor not found' });

    const { period = '30' } = req.query;
    const days = parseInt(period);
    const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const stats = await Order.aggregate([
        {
            $match: {
                isPlaced: { $ne: false },
                vendorIds: vendor._id,
                orderStatus: 'delivered',
                createdAt: { $gte: from },
            },
        },
        {
            $group: {
                _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
                earnings: { $sum: { $ifNull: [{ $arrayElemAt: [{ $objectToArray: '$vendorPayouts' }, 0] }, { v: 0 }] } },
                count: { $sum: 1 },
            },
        },
        { $sort: { _id: 1 } },
    ]);

    res.json({
        success: true,
        balance: vendor.balance,
        totalEarnings: vendor.totalEarnings,
        totalWithdrawn: vendor.totalWithdrawn,
        period: days,
        chart: stats,
    });
}));

// POST /api/vendors/me/withdrawal
router.post('/me/withdrawal', protect, authorize('vendor'), asyncHandler(async (req, res) => {
    const vendor = await Vendor.findOne({ userId: req.user._id });
    const { amount } = req.body;

    if (!amount || amount <= 0) return res.status(400).json({ success: false, message: 'Invalid amount' });
    if (vendor.balance < amount) return res.status(400).json({ success: false, message: 'Insufficient balance' });
    if (!vendor.bankDetails?.accountNumber && !vendor.bankDetails?.upiId) {
        return res.status(400).json({ success: false, message: 'Please add bank details first' });
    }

    await Vendor.findByIdAndUpdate(vendor._id, {
        $inc: { balance: -amount, totalWithdrawn: amount },
    });

    // TODO: trigger actual bank transfer via Razorpay/Stripe payout
    res.json({ success: true, message: `Withdrawal request of ₹${amount} submitted. Processing in 2-3 business days.` });
}));

// GET /api/vendors — public nearby vendor list
router.get('/', asyncHandler(async (req, res) => {
    const { lat, lng, radius = 100, page = 1, limit = 20 } = req.query;

    let vendors;
    if (lat && lng) {
        vendors = await Vendor.aggregate([
            {
                $geoNear: {
                    near: { type: 'Point', coordinates: [parseFloat(lng), parseFloat(lat)] },
                    distanceField: 'distance',
                    maxDistance: parseInt(radius) * 1000,
                    spherical: true,
                    query: { approved: true, isActive: true },
                },
            },
            { $skip: (parseInt(page) - 1) * parseInt(limit) },
            { $limit: parseInt(limit) },
            { $project: { storeName: 1, storeLogo: 1, address: 1, city: 1, ratings: 1, distance: 1, totalProducts: 1 } },
        ]);
    } else {
        vendors = await Vendor.find({ approved: true, isActive: true })
            .select('storeName storeLogo address city ratings totalProducts')
            .skip((parseInt(page) - 1) * parseInt(limit))
            .limit(parseInt(limit))
            .lean();
    }

    res.json({ success: true, vendors });
}));

module.exports = router;
