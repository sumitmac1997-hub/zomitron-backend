const express = require('express');
const asyncHandler = require('express-async-handler');
const { protect } = require('../middleware/auth');
const Rider = require('../models/Rider');
const Order = require('../models/Order');
const User = require('../models/User');
const Vendor = require('../models/Vendor');
const { autoAssignRider } = require('../config/socket');
const { notifyAdmin } = require('../utils/adminNotificationEngine');

const router = express.Router();

// ─────────────────────────────────────────
// POST /api/riders/register
// Submit rider profile (first-time setup after user registration)
// ─────────────────────────────────────────
router.post('/register', protect, asyncHandler(async (req, res) => {
    const userId = req.user._id;

    const existing = await Rider.findOne({ userId });
    if (existing) {
        return res.status(400).json({ success: false, message: 'Rider profile already exists', rider: existing });
    }

    const {
        city,
        vehicleType,
        regNumber,
        ownerName,
        insuranceValidTill,
        numberPlate,
    } = req.body;

    if (!city || !vehicleType || !regNumber || !ownerName || !insuranceValidTill || !numberPlate) {
        return res.status(400).json({ success: false, message: 'All vehicle details are required' });
    }

    const rider = await Rider.create({
        userId,
        city: String(city).trim(),
        vehicleDetails: {
            vehicleType,
            regNumber: String(regNumber).trim(),
            ownerName: String(ownerName).trim(),
            insuranceValidTill: new Date(insuranceValidTill),
            numberPlate: String(numberPlate).trim().toUpperCase(),
        },
        status: 'PENDING',
    });

    // Notify admin
    void notifyAdmin(req.app.get('io'), {
        type: 'new_rider',
        message: `New rider registered: ${req.user.name}`,
        link: '/admin/riders',
        relatedId: rider._id,
    });

    res.status(201).json({ success: true, message: 'Rider profile submitted. Awaiting admin approval.', rider });
}));

// ─────────────────────────────────────────
// GET /api/riders/me
// Get my rider profile
// ─────────────────────────────────────────
router.get('/me', protect, asyncHandler(async (req, res) => {
    const rider = await Rider.findOne({ userId: req.user._id }).populate('userId', 'name email mobileNumber phone avatar');
    if (!rider) {
        return res.status(404).json({ success: false, message: 'Rider profile not found' });
    }
    res.json({ success: true, rider });
}));

// ─────────────────────────────────────────
// PUT /api/riders/me
// Update rider profile (vehicle info / city)
// ─────────────────────────────────────────
router.put('/me', protect, asyncHandler(async (req, res) => {
    const rider = await Rider.findOne({ userId: req.user._id });
    if (!rider) {
        return res.status(404).json({ success: false, message: 'Rider profile not found' });
    }

    const { city, vehicleType, regNumber, ownerName, insuranceValidTill, numberPlate } = req.body;

    if (city) rider.city = String(city).trim();
    if (vehicleType) rider.vehicleDetails.vehicleType = vehicleType;
    if (regNumber) rider.vehicleDetails.regNumber = String(regNumber).trim();
    if (ownerName) rider.vehicleDetails.ownerName = String(ownerName).trim();
    if (insuranceValidTill) rider.vehicleDetails.insuranceValidTill = new Date(insuranceValidTill);
    if (numberPlate) rider.vehicleDetails.numberPlate = String(numberPlate).trim().toUpperCase();

    await rider.save();
    res.json({ success: true, message: 'Profile updated', rider });
}));

// ─────────────────────────────────────────
// PUT /api/riders/me/online
// Toggle online / offline
// ─────────────────────────────────────────
router.put('/me/online', protect, asyncHandler(async (req, res) => {
    const rider = await Rider.findOne({ userId: req.user._id });
    if (!rider) {
        return res.status(404).json({ success: false, message: 'Rider profile not found' });
    }
    if (rider.status !== 'ACTIVE') {
        return res.status(403).json({ success: false, message: 'Only approved riders can go online' });
    }

    const { isOnline } = req.body;
    rider.isOnline = Boolean(isOnline);
    await rider.save();
    res.json({ success: true, isOnline: rider.isOnline });
}));

// ─────────────────────────────────────────
// PUT /api/riders/me/location
// Update live location via REST (backup for non-socket clients)
// ─────────────────────────────────────────
router.put('/me/location', protect, asyncHandler(async (req, res) => {
    const { lat, lng } = req.body;
    if (typeof lat !== 'number' || typeof lng !== 'number') {
        return res.status(400).json({ success: false, message: 'lat and lng (numbers) are required' });
    }
    const rider = await Rider.findOneAndUpdate(
        { userId: req.user._id },
        {
            'location.lat': lat,
            'location.lng': lng,
            'location.updatedAt': new Date(),
            'currentLocation.coordinates': [lng, lat],
        },
        { new: true }
    );
    if (!rider) return res.status(404).json({ success: false, message: 'Rider not found' });

    // Also broadcast to admin via socket
    const io = req.app.get('io');
    if (io?.emitToAdmin) {
        io.emitToAdmin('riderLocation', { riderId: rider._id, lat, lng, ts: Date.now() });
    }

    res.json({ success: true });
}));

// ─────────────────────────────────────────
// GET /api/riders/me/orders
// Delivery history for the rider
// ─────────────────────────────────────────
router.get('/me/orders', protect, asyncHandler(async (req, res) => {
    const rider = await Rider.findOne({ userId: req.user._id });
    if (!rider) return res.status(404).json({ success: false, message: 'Rider not found' });

    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, parseInt(req.query.limit) || 20);
    const skip = (page - 1) * limit;

    const filter = { assignedRiderId: rider._id };
    if (req.query.status) filter.deliveryStatus = req.query.status;

    const [orders, total] = await Promise.all([
        Order.find(filter)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .select('orderNumber deliveryAddress items total deliveryStatus riderAssignedAt pickedAt outForDeliveryAt deliveredByRiderAt createdAt')
            .lean(),
        Order.countDocuments(filter),
    ]);

    res.json({ success: true, orders, total, page, pages: Math.ceil(total / limit) });
}));

// ─────────────────────────────────────────
// PUT /api/riders/orders/:orderId/accept
// Rider accepts a delivery request
// ─────────────────────────────────────────
router.put('/orders/:orderId/accept', protect, asyncHandler(async (req, res) => {
    const rider = await Rider.findOne({ userId: req.user._id });
    if (!rider || rider.status !== 'ACTIVE') {
        return res.status(403).json({ success: false, message: 'Not authorized' });
    }

    const order = await Order.findById(req.params.orderId);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    if (order.assignedRiderId) {
        return res.status(409).json({ success: false, message: 'Order already assigned to another rider' });
    }

    order.assignedRiderId = rider._id;
    order.deliveryStatus = 'assigned';
    order.riderAssignedAt = new Date();
    await order.save();

    // Mark rider as busy
    rider.activeOrderId = order._id;
    await rider.save();

    // Clear the pending assignment timer for this order+rider
    const io = req.app.get('io');
    if (io?._riderTimers) {
        const key = `${order._id}_${rider._id}`;
        if (io._riderTimers.has(key)) {
            clearTimeout(io._riderTimers.get(key));
            io._riderTimers.delete(key);
        }
    }

    // Notify customer & admin
    if (io) {
        io.emitOrderUpdate(order._id.toString(), {
            deliveryStatus: 'assigned',
            rider: { id: rider._id, name: req.user.name, phone: req.user.mobileNumber },
        });
        io.emitToAdmin('deliveryAccepted', {
            orderId: order._id,
            orderNumber: order.orderNumber,
            riderId: rider._id,
            riderName: req.user.name,
        });
    }

    res.json({ success: true, message: 'Order accepted', order });
}));

// ─────────────────────────────────────────
// PUT /api/riders/orders/:orderId/reject
// Rider explicitly rejects (optional — frontend can just let timer expire)
// ─────────────────────────────────────────
router.put('/orders/:orderId/reject', protect, asyncHandler(async (req, res) => {
    const rider = await Rider.findOne({ userId: req.user._id });
    if (!rider) return res.status(404).json({ success: false, message: 'Rider not found' });

    const io = req.app.get('io');
    // Emit rejection expired so auto-assign tries next
    if (io) {
        io.emitToRider(rider._id.toString(), 'deliveryRequestExpired', { orderId: req.params.orderId });
    }

    res.json({ success: true, message: 'Order rejected' });
}));

// ─────────────────────────────────────────
// PUT /api/riders/orders/:orderId/status
// Rider updates delivery status: picked | out_for_delivery | delivered
// ─────────────────────────────────────────
router.put('/orders/:orderId/status', protect, asyncHandler(async (req, res) => {
    const rider = await Rider.findOne({ userId: req.user._id });
    if (!rider || rider.status !== 'ACTIVE') {
        return res.status(403).json({ success: false, message: 'Not authorized' });
    }

    const order = await Order.findById(req.params.orderId);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    if (!order.assignedRiderId?.equals(rider._id)) {
        return res.status(403).json({ success: false, message: 'This order is not assigned to you' });
    }

    const { status } = req.body;
    const allowed = ['picked', 'out_for_delivery', 'delivered'];
    if (!allowed.includes(status)) {
        return res.status(400).json({ success: false, message: `Status must be one of: ${allowed.join(', ')}` });
    }

    order.deliveryStatus = status;
    if (status === 'picked') {
        order.pickedAt = new Date();
        order.orderStatus = 'processing';
    } else if (status === 'out_for_delivery') {
        order.outForDeliveryAt = new Date();
        order.orderStatus = 'out_for_delivery';
    } else if (status === 'delivered') {
        order.deliveredByRiderAt = new Date();
        order.deliveredAt = new Date();
        order.orderStatus = 'delivered';
        // Free the rider
        rider.activeOrderId = null;
        rider.completedDeliveries = (rider.completedDeliveries || 0) + 1;
        rider.totalDeliveries = (rider.totalDeliveries || 0) + 1;
        await rider.save();
    }

    await order.save();

    const io = req.app.get('io');
    if (io) {
        io.emitOrderUpdate(order._id.toString(), { deliveryStatus: status, orderStatus: order.orderStatus });
        io.emitToAdmin('deliveryStatusUpdate', {
            orderId: order._id,
            orderNumber: order.orderNumber,
            deliveryStatus: status,
            riderId: rider._id,
        });
        if (order.customerId) {
            io.emitToUser(order.customerId.toString(), 'orderUpdate', {
                orderId: order._id,
                deliveryStatus: status,
                orderStatus: order.orderStatus,
            });
        }
    }

    res.json({ success: true, message: `Delivery status updated to ${status}`, order });
}));

module.exports = router;
