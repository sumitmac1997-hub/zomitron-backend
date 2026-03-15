const express = require('express');
const router = express.Router();
const asyncHandler = require('express-async-handler');
const Order = require('../models/Order');
const Product = require('../models/Product');
const Vendor = require('../models/Vendor');
const Coupon = require('../models/Coupon');
const User = require('../models/User');
const ShippingRule = require('../models/ShippingRule');
const { protect, optionalAuth, authorize } = require('../middleware/auth');
const { haversineDistance } = require('../utils/haversine');
const { getDeliveryInfo, getEstimatedDeliveryDate } = require('../utils/deliveryETA');
const { calculateMultiVendorPayouts } = require('../utils/commission');
const { normalizeCity, calculateShippingQuote } = require('../utils/shippingRules');
const { getSettingValue } = require('../utils/settings');

// (Removed ensureDefaultShippingRule)

// POST /api/orders — Create order
router.post('/', optionalAuth, asyncHandler(async (req, res) => {
    const { items, deliveryAddress, paymentMethod, couponCode, guestEmail, guestPhone } = req.body;
    const orderEmail = guestEmail || req.user?.email;

    if (!items || items.length === 0) return res.status(400).json({ success: false, message: 'No items in order' });
    if (!deliveryAddress) return res.status(400).json({ success: false, message: 'Delivery address required' });
    if (!req.user && !orderEmail) return res.status(400).json({ success: false, message: 'Login or provide guest email' });

    // Validate products and build order items
    const orderItems = [];
    const vendorIds = new Set();
    let subtotal = 0;

    for (const item of items) {
        const product = await Product.findById(item.productId);
        if (!product || !product.isActive || product.stock < item.qty) {
            return res.status(400).json({ success: false, message: `Product ${item.productId} unavailable or insufficient stock` });
        }
        const price = product.discountPrice || product.price;
        orderItems.push({
            productId: product._id,
            vendorId: product.vendorId,
            title: product.title,
            image: product.images[0],
            price,
            qty: item.qty,
            subtotal: price * item.qty,
        });
        vendorIds.add(product.vendorId.toString());
        subtotal += price * item.qty;
    }

    // Get vendor commission rates
    const vendorIdArray = Array.from(vendorIds);
    const vendors = await Vendor.find({ _id: { $in: vendorIdArray } }).select('_id commissionRate city location');
    const commissionRates = {};
    vendors.forEach(v => { commissionRates[v._id.toString()] = v.commissionRate; });

    // Calculate delivery info (use first vendor location vs delivery address)
    let deliveryDistance = 0;
    let deliveryInfo = { eta: '3-5 days', etaLabel: 'Standard Delivery', deliveryCharge: 0 };
    if (deliveryAddress.lat && deliveryAddress.lng && vendors[0]?.location?.coordinates) {
        const [vendorLng, vendorLat] = vendors[0].location.coordinates;
        deliveryDistance = haversineDistance(deliveryAddress.lat, deliveryAddress.lng, vendorLat, vendorLng);
        deliveryInfo = getDeliveryInfo(deliveryDistance);
    }

    // Apply coupon
    let discount = 0;
    let appliedCoupon = null;
    if (couponCode) {
        const coupon = await Coupon.findOne({ code: couponCode.toUpperCase() });
        if (coupon) {
            const validation = coupon.validate(req.user?._id, subtotal);
            if (validation.valid) {
                discount = coupon.calculateDiscount(subtotal);
                appliedCoupon = coupon;
            }
        }
    }

    const { platformTotal, vendorPayouts } = calculateMultiVendorPayouts(orderItems, commissionRates);

    // Fetch all active rules and let matcher decide
    const ruleList = await ShippingRule.find({ isActive: true }).sort({ updatedAt: -1 }).lean();

    const shippingQuote = calculateShippingQuote({
        city: deliveryAddress.city,
        pincode: deliveryAddress.pincode,
        subtotal,
        discount,
    }, ruleList);

    // Block order if delivery is not available at the customer's location
    if (!shippingQuote.serviceAvailable) {
        return res.status(422).json({
            success: false,
            message: shippingQuote.message || 'Delivery is not available at your location. Please use a supported city and pincode.',
        });
    }

    const total = Math.max(0, subtotal - discount + shippingQuote.shippingCharge);
    const refundWindowDays = await getSettingValue('refundWindowDays', 5);

    // Create order
    const order = await Order.create({
        customerId: req.user?._id,
        guestEmail: orderEmail,
        guestPhone,
        items: orderItems,
        vendorIds: vendorIdArray,
        subtotal,
        platformFee: platformTotal,
        deliveryCharge: shippingQuote.shippingCharge,
        discount,
        total,
        vendorPayouts,
        couponCode,
        paymentMethod: paymentMethod || 'cod',
        paymentStatus: paymentMethod === 'cod' ? 'pending' : 'pending',
        deliveryAddress,
        deliveryETA: deliveryInfo.eta,
        estimatedDelivery: getEstimatedDeliveryDate(deliveryDistance),
        deliveryDistance,
        shippingRule: {
            ruleId: shippingQuote.ruleId,
            city: shippingQuote.city || deliveryAddress.city,
            freeShippingThreshold: shippingQuote.freeShippingThreshold,
            baseShippingCharge: shippingQuote.baseShippingCharge,
            appliedCharge: shippingQuote.shippingCharge,
            matchingMode: shippingQuote.matchingMode,
            pincodeRangesText: shippingQuote.pincodeRangesText,
        },
        vendorFulfillments: vendorIdArray.map(vid => ({ vendorId: vid, status: 'pending' })),
        refundWindowDays: Number(refundWindowDays) || 5,
    });

    // Reduce stock
    for (const item of orderItems) {
        await Product.findByIdAndUpdate(item.productId, { $inc: { stock: -item.qty, orderCount: 1 } });
    }

    // Save new address to user profile
    let updatedUser = null;
    if (req.user) {
        try {
            const user = await User.findById(req.user._id);
            if (user) {
                const addressExists = user.addresses.some(
                    (addr) =>
                        addr.line1.toLowerCase().trim() === deliveryAddress.line1.toLowerCase().trim() &&
                        addr.city.toLowerCase().trim() === deliveryAddress.city.toLowerCase().trim() &&
                        addr.pincode === deliveryAddress.pincode
                );
                
                if (!addressExists) {
                    const newAddress = {
                        label: 'Saved Address',
                        line1: deliveryAddress.line1,
                        line2: deliveryAddress.line2 || '',
                        city: deliveryAddress.city,
                        state: deliveryAddress.state,
                        pincode: deliveryAddress.pincode,
                        lat: deliveryAddress.lat,
                        lng: deliveryAddress.lng,
                        isDefault: user.addresses.length === 0, // Make default if it's their first address
                    };
                    user.addresses.push(newAddress);
                    updatedUser = await user.save();
                }
            }
        } catch (err) {
            console.error('Error auto-saving address to user profile:', err);
            // Non-fatal error, do not block order success
        }
    }

    // Update coupon usage
    if (appliedCoupon) {
        appliedCoupon.usedCount += 1;
        if (req.user) appliedCoupon.usedBy.push(req.user._id);
        await appliedCoupon.save();
    }

    // Update vendor stats
    await Vendor.updateMany({ _id: { $in: vendorIdArray } }, { $inc: { totalOrders: 1 } });

    // Real-time notifications
    const io = req.app.get('io');
    if (io) {
        vendors.forEach(v => io.emitToVendor(v._id.toString(), 'newOrder', { orderId: order._id, orderNumber: order.orderNumber }));
    }
    
    // Notify admin
    const { notifyAdmin } = require('../utils/adminNotificationEngine');
    await notifyAdmin(io, {
        type: 'order_placed',
        message: `New Order Placed: #${order.orderNumber} (₹${total})`,
        link: `/admin/dashboard`,
        relatedId: order._id
    });

    res.status(201).json({
        success: true,
        order: {
            ...order.toObject(),
            deliveryInfo: { ...deliveryInfo, deliveryCharge: shippingQuote.shippingCharge },
            shippingQuote,
        },
        user: updatedUser
    });
}));

// GET /api/orders/my — Customer order history
router.get('/my', protect, asyncHandler(async (req, res) => {
    const { page = 1, limit = 10, status } = req.query;
    const query = { customerId: req.user._id };
    if (status) query.orderStatus = status;

    const total = await Order.countDocuments(query);
    const orders = await Order.find(query)
        .populate('items.productId', 'title images price')
        .populate('vendorIds', 'storeName storeLogo')
        .sort({ createdAt: -1 })
        .skip((parseInt(page) - 1) * parseInt(limit))
        .limit(parseInt(limit))
        .lean();

    res.json({ success: true, orders, total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)) });
}));

// GET /api/orders/:id — Order detail
router.get('/:id', optionalAuth, asyncHandler(async (req, res) => {
    const isAdmin = req.user?.role === 'admin';
    const vendorFields = isAdmin
        ? 'storeName storeLogo phone email address city state pincode'
        : 'storeName storeLogo phone';

    const order = await Order.findById(req.params.id)
        .populate('customerId', 'name email phone')
        .populate('items.productId', 'title images price')
        .populate('vendorIds', vendorFields)
        .populate('refundRequests.vendorId', 'storeName address city state pincode phone')
        .lean();

    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

    // Auth check
    if (req.user) {
        const isOwner = order.customerId?._id?.toString() === req.user._id.toString();
        const isVendor = req.user.role === 'vendor'; // TODO: check vendor ownership
        if (!isOwner && !isAdmin && !isVendor) {
            return res.status(403).json({ success: false, message: 'Not authorized' });
        }
    }

    const refundWindowDays = order.refundWindowDays || await getSettingValue('refundWindowDays', 5);
    const refundEndsOn = order.deliveredAt
        ? new Date(new Date(order.deliveredAt).getTime() + Number(refundWindowDays || 0) * 24 * 60 * 60 * 1000)
        : null;
    const now = new Date();
    const canCancel = !['delivered', 'cancelled'].includes(order.orderStatus);
    const canRefund = order.orderStatus === 'delivered'
        && order.refundStatus === 'none'
        && order.deliveredAt
        && refundEndsOn
        && now <= refundEndsOn;

    res.json({
        success: true,
        order: {
            ...order,
            refundWindowDays: Number(refundWindowDays) || 5,
            refundEndsOn,
            canCancel,
            canRefund,
            deliveryInfo: {
                ...getDeliveryInfo(order.deliveryDistance || 0),
                deliveryCharge: order.deliveryCharge || 0,
            },
        },
    });
}));

// PUT /api/orders/:id/status — Admin update order status
router.put('/:id/status', protect, authorize('admin'), asyncHandler(async (req, res) => {
    const { status, trackingCode, trackingUrl } = req.body;
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

    const allowedStatuses = ['pending', 'confirmed', 'processing', 'shipped', 'out_for_delivery', 'delivered', 'cancelled'];
    if (!allowedStatuses.includes(status)) {
        return res.status(400).json({ success: false, message: 'Invalid status' });
    }

    // Sync vendor fulfillments so vendors see admin changes instantly
    order.vendorIds.forEach((vid) => {
        const existing = order.vendorFulfillments.find((f) => f.vendorId.toString() === vid.toString());
        if (existing) {
            existing.status = status;
            if (trackingCode) existing.trackingCode = trackingCode;
        } else {
            order.vendorFulfillments.push({ vendorId: vid, status, trackingCode });
        }
    });

    order.orderStatus = status;
    if (trackingCode) order.trackingCode = trackingCode;
    if (trackingUrl) order.trackingUrl = trackingUrl;
    if (status === 'confirmed') order.confirmedAt = order.confirmedAt || new Date();
    if (status === 'shipped' || status === 'out_for_delivery') order.shippedAt = order.shippedAt || new Date();
    if (status === 'delivered') {
        if (!order.deliveredAt) {
            order.deliveredAt = new Date();
            order.paymentStatus = 'paid';
            // Credit vendor payouts (once)
            for (const [vendorId, amount] of order.vendorPayouts.entries()) {
                await Vendor.findByIdAndUpdate(vendorId, {
                    $inc: { balance: amount, totalEarnings: amount },
                });
            }
        }
        // Ensure all vendor fulfillments marked delivered
        order.vendorFulfillments = order.vendorFulfillments.map((f) => ({ ...f, status: 'delivered' }));
    }
    if (status === 'cancelled' && !order.cancelledAt) {
        order.cancelledAt = new Date();
        // Restore stock
        for (const item of order.items) {
            await Product.findByIdAndUpdate(item.productId, { $inc: { stock: item.qty } });
        }
        order.vendorFulfillments = order.vendorFulfillments.map((f) => ({ ...f, status: 'cancelled' }));
    }

    await order.save();

    const io = req.app.get('io');
    if (io) {
        io.emitToUser(order.customerId?.toString(), 'orderUpdate', { orderId: order._id, status });
        io.emitOrderUpdate(order._id.toString(), { status, trackingCode });
    }

    res.json({ success: true, order });
}));

// POST /api/orders/:id/cancel — Customer cancels order
router.post('/:id/cancel', protect, asyncHandler(async (req, res) => {
    const { reason } = req.body;
    const order = await Order.findOne({ _id: req.params.id, customerId: req.user._id });
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    if (['delivered', 'cancelled', 'returned'].includes(order.orderStatus)) {
        return res.status(400).json({ success: false, message: 'Order cannot be cancelled at this stage' });
    }
    order.orderStatus = 'cancelled';
    order.cancelledAt = new Date();
    order.cancellationReason = reason;
    for (const item of order.items) {
        await Product.findByIdAndUpdate(item.productId, { $inc: { stock: item.qty } });
    }
    await order.save();

    const { notifyAdmin } = require('../utils/adminNotificationEngine');
    await notifyAdmin(req.app.get('io'), {
        type: 'order_cancelled',
        message: `Order Cancelled: #${order.orderNumber}`,
        link: `/admin/dashboard`,
        relatedId: order._id
    });

    res.json({ success: true, message: 'Order cancelled', order });
}));

// POST /api/orders/:id/refund — Customer requests refund (within window)
router.post('/:id/refund', protect, asyncHandler(async (req, res) => {
    const { reason } = req.body;
    const order = await Order.findOne({ _id: req.params.id, customerId: req.user._id });
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    if (order.orderStatus !== 'delivered') {
        return res.status(400).json({ success: false, message: 'Refunds are available only after delivery' });
    }
    if (order.refundStatus && order.refundStatus !== 'none') {
        return res.status(400).json({ success: false, message: 'Refund already requested' });
    }
    if (!order.deliveredAt) {
        return res.status(400).json({ success: false, message: 'Delivered timestamp missing, contact support' });
    }

    const refundWindowDays = order.refundWindowDays || await getSettingValue('refundWindowDays', 5);
    const lastRefundDate = new Date(order.deliveredAt.getTime() + Number(refundWindowDays || 0) * 24 * 60 * 60 * 1000);
    if (new Date() > lastRefundDate) {
        return res.status(400).json({ success: false, message: 'Refund window has expired' });
    }

    order.refundStatus = 'requested';
    order.refundReason = reason;
    order.refundRequestedAt = new Date();
    await order.save();

    const { notifyAdmin } = require('../utils/adminNotificationEngine');
    await notifyAdmin(req.app.get('io'), {
        type: 'refund_requested',
        message: `Refund Requested: #${order.orderNumber}`,
        link: `/admin/refunds`,
        relatedId: order._id
    });

    res.json({ success: true, message: 'Refund requested', order });
}));

// POST /api/orders/:id/refund-item — Customer requests refund for specific item
router.post('/:id/refund-item', protect, asyncHandler(async (req, res) => {
    const { reason, itemId } = req.body;
    if (!itemId) return res.status(400).json({ success: false, message: 'itemId is required' });
    const order = await Order.findOne({ _id: req.params.id, customerId: req.user._id });
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    if (order.orderStatus !== 'delivered') return res.status(400).json({ success: false, message: 'Refunds available only after delivery' });
    if (!order.deliveredAt) return res.status(400).json({ success: false, message: 'Delivered timestamp missing, contact support' });

    const refundWindowDays = order.refundWindowDays || await getSettingValue('refundWindowDays', 5);
    const lastRefundDate = new Date(order.deliveredAt.getTime() + Number(refundWindowDays || 0) * 24 * 60 * 60 * 1000);
    if (new Date() > lastRefundDate) return res.status(400).json({ success: false, message: 'Refund window has expired' });

    const targetItem = order.items.id(itemId) || order.items.find((i) => i._id?.toString() === itemId);
    if (!targetItem) return res.status(404).json({ success: false, message: 'Item not found in order' });

    const existing = order.refundRequests.find((r) => r.itemId?.toString() === targetItem._id.toString() && r.status !== 'rejected' && r.status !== 'processed');
    if (existing) return res.status(400).json({ success: false, message: 'Refund already requested for this item' });

    order.refundRequests.push({
        itemId: targetItem._id,
        productId: targetItem.productId,
        vendorId: targetItem.vendorId,
        title: targetItem.title,
        image: targetItem.image,
        qty: targetItem.qty,
        price: targetItem.price,
        amount: targetItem.price * targetItem.qty,
        status: 'requested',
        reason,
        requestedAt: new Date(),
    });

    await order.save();

    const { notifyAdmin } = require('../utils/adminNotificationEngine');
    await notifyAdmin(req.app.get('io'), {
        type: 'refund_requested',
        message: `Refund Requested: #${order.orderNumber} (item)`,
        link: `/admin/refunds`,
        relatedId: order._id,
    });

    res.json({ success: true, message: 'Refund requested for item', order });
}));

// GET /api/orders/:id/track — Real-time tracking info
router.get('/:id/track', asyncHandler(async (req, res) => {
    const order = await Order.findById(req.params.id)
        .select('orderStatus trackingCode trackingUrl deliveryETA estimatedDelivery vendorFulfillments deliveryAddress deliveryDistance')
        .lean();
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    res.json({
        success: true,
        tracking: {
            ...order,
            deliveryInfo: {
                ...getDeliveryInfo(order.deliveryDistance || 0),
                deliveryCharge: order.deliveryCharge || 0,
            },
        },
    });
}));

module.exports = router;
