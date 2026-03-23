const express = require('express');
const router = express.Router();
const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
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
const { calculateShippingQuote } = require('../utils/shippingRules');
const { getSettingValue } = require('../utils/settings');

const MAX_ORDER_ITEMS = Number(process.env.MAX_ORDER_ITEMS) || 25;
const VALID_PAYMENT_METHODS = new Set(['stripe', 'razorpay', 'paypal', 'cod']);

const clean = (value) => (value ?? '').toString().trim();
const normalizeEmail = (value) => clean(value).toLowerCase();
const isValidEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || ''));
const isValidIndianPhone = (value) => {
    const digits = String(value || '').replace(/\D/g, '');
    return digits.length === 10 || (digits.length === 12 && digits.startsWith('91'));
};
const isValidPincode = (value) => /^\d{6}$/.test(String(value || ''));

const createHttpError = (statusCode, message) => {
    const error = new Error(message);
    error.statusCode = statusCode;
    return error;
};

const normalizeOrderItems = (items) => {
    if (!Array.isArray(items) || items.length === 0) {
        throw createHttpError(400, 'No items in order');
    }

    if (items.length > MAX_ORDER_ITEMS) {
        throw createHttpError(400, `Order cannot contain more than ${MAX_ORDER_ITEMS} distinct line items`);
    }

    const mergedItems = new Map();

    for (const rawItem of items) {
        const productId = clean(rawItem?.productId);
        const qty = Number.parseInt(rawItem?.qty, 10);

        if (!productId || !Number.isInteger(qty) || qty <= 0) {
            throw createHttpError(400, 'Each order item must include a valid productId and positive qty');
        }

        mergedItems.set(productId, (mergedItems.get(productId) || 0) + qty);
    }

    return Array.from(mergedItems.entries()).map(([productId, qty]) => ({ productId, qty }));
};

const normalizeDeliveryAddress = (deliveryAddress, orderEmail, fallbackPhone) => {
    if (!deliveryAddress || typeof deliveryAddress !== 'object') {
        throw createHttpError(400, 'Delivery address required');
    }

    const normalizedAddress = {
        name: clean(deliveryAddress.name),
        email: normalizeEmail(deliveryAddress.email || orderEmail),
        phone: clean(deliveryAddress.phone || fallbackPhone),
        line1: clean(deliveryAddress.line1),
        line2: clean(deliveryAddress.line2),
        city: clean(deliveryAddress.city),
        state: clean(deliveryAddress.state),
        pincode: clean(deliveryAddress.pincode),
        lat: deliveryAddress.lat === undefined || deliveryAddress.lat === '' ? undefined : Number(deliveryAddress.lat),
        lng: deliveryAddress.lng === undefined || deliveryAddress.lng === '' ? undefined : Number(deliveryAddress.lng),
    };

    if (!normalizedAddress.line1 || !normalizedAddress.city || !normalizedAddress.state || !isValidPincode(normalizedAddress.pincode)) {
        throw createHttpError(400, 'Delivery address must include line1, city, state, and a valid 6-digit pincode');
    }

    if (!normalizedAddress.email || !isValidEmail(normalizedAddress.email)) {
        throw createHttpError(400, 'A valid order email is required');
    }

    if (!normalizedAddress.phone || !isValidIndianPhone(normalizedAddress.phone)) {
        throw createHttpError(400, 'A valid phone number is required for delivery');
    }

    if ((normalizedAddress.lat !== undefined && !Number.isFinite(normalizedAddress.lat))
        || (normalizedAddress.lng !== undefined && !Number.isFinite(normalizedAddress.lng))) {
        throw createHttpError(400, 'Latitude and longitude must be valid numbers');
    }

    return normalizedAddress;
};

const buildOrderItems = (normalizedItems, productsById) => {
    const orderItems = [];
    let subtotal = 0;

    for (const item of normalizedItems) {
        const product = productsById.get(item.productId);
        if (!product || !product.isActive) {
            throw createHttpError(404, `Product ${item.productId} not found`);
        }

        if (product.stock < item.qty) {
            throw createHttpError(409, `Product ${item.productId} has insufficient stock`);
        }

        const price = product.discountPrice || product.price;
        orderItems.push({
            productId: product._id,
            vendorId: product.vendorId,
            title: product.title,
            image: product.images?.[0],
            price,
            qty: item.qty,
            subtotal: price * item.qty,
        });
        subtotal += price * item.qty;
    }

    return { orderItems, subtotal };
};

const isTransactionUnsupportedError = (error) => /Transaction numbers are only allowed on a replica set member or mongos|does not support transactions|replica set/i.test(error?.message || '');

const reserveStockWithoutTransaction = async (orderItems) => {
    const reserved = [];

    const rollback = async () => {
        if (reserved.length === 0) return;
        await Product.bulkWrite(
            reserved.map((item) => ({
                updateOne: {
                    filter: { _id: item.productId },
                    update: { $inc: { stock: item.qty, orderCount: -item.qty } },
                },
            })),
            { ordered: false },
        );
    };

    for (const item of orderItems) {
        const updatedProduct = await Product.findOneAndUpdate(
            {
                _id: item.productId,
                isActive: true,
                stock: { $gte: item.qty },
            },
            {
                $inc: { stock: -item.qty, orderCount: item.qty },
            },
            { new: true },
        );

        if (!updatedProduct) {
            await rollback();
            throw createHttpError(409, `Product ${item.productId} became unavailable during checkout`);
        }

        reserved.push({ productId: item.productId, qty: item.qty });
    }

    return rollback;
};

const syncAddressToUser = async (userId, deliveryAddress, session) => {
    if (!userId) return null;

    const user = session
        ? await User.findById(userId).session(session)
        : await User.findById(userId);

    if (!user) return null;

    const addresses = Array.isArray(user.addresses) ? user.addresses : [];
    const addressExists = addresses.some((addr) => (
        clean(addr.line1).toLowerCase() === deliveryAddress.line1.toLowerCase()
        && clean(addr.city).toLowerCase() === deliveryAddress.city.toLowerCase()
        && clean(addr.pincode) === deliveryAddress.pincode
    ));

    if (addressExists) {
        return user.toObject();
    }

    user.addresses.push({
        label: 'Saved Address',
        line1: deliveryAddress.line1,
        line2: deliveryAddress.line2 || '',
        city: deliveryAddress.city,
        state: deliveryAddress.state,
        pincode: deliveryAddress.pincode,
        lat: deliveryAddress.lat,
        lng: deliveryAddress.lng,
        isDefault: addresses.length === 0,
    });

    await user.save({ session, validateBeforeSave: false });
    return user.toObject();
};

// POST /api/orders — Create order
router.post('/', optionalAuth, asyncHandler(async (req, res) => {
    const { items, deliveryAddress, paymentMethod, couponCode, guestEmail, guestPhone } = req.body;
    const normalizedItems = normalizeOrderItems(items);
    const orderEmail = normalizeEmail(guestEmail || req.user?.email);
    if (!req.user && !orderEmail) return res.status(400).json({ success: false, message: 'Login or provide guest email' });

    const paymentMethodValue = clean(paymentMethod || 'cod').toLowerCase();
    if (!VALID_PAYMENT_METHODS.has(paymentMethodValue)) {
        return res.status(400).json({ success: false, message: 'Invalid payment method' });
    }

    const normalizedAddress = normalizeDeliveryAddress(deliveryAddress, orderEmail, guestPhone);
    const productIds = normalizedItems.map((item) => item.productId);
    const products = await Product.find({ _id: { $in: productIds } })
        .select('_id vendorId title images price discountPrice stock isActive')
        .lean();

    if (products.length !== productIds.length) {
        return res.status(404).json({ success: false, message: 'One or more products were not found' });
    }

    const productsById = new Map(products.map((product) => [String(product._id), product]));
    const { orderItems, subtotal } = buildOrderItems(normalizedItems, productsById);
    const vendorIdArray = [...new Set(orderItems.map((item) => String(item.vendorId)))];

    const [vendors, coupon, ruleList, refundWindowDays] = await Promise.all([
        Vendor.find({ _id: { $in: vendorIdArray } }).select('_id commissionRate city location').lean(),
        couponCode ? Coupon.findOne({ code: clean(couponCode).toUpperCase(), isActive: true }) : Promise.resolve(null),
        ShippingRule.find({ isActive: true }).sort({ updatedAt: -1 }).lean(),
        getSettingValue('refundWindowDays', 5),
    ]);

    if (vendors.length !== vendorIdArray.length) {
        return res.status(400).json({ success: false, message: 'One or more vendors for this order are unavailable' });
    }

    const commissionRates = Object.fromEntries(vendors.map((vendor) => [String(vendor._id), vendor.commissionRate]));

    let deliveryDistance = 0;
    let deliveryInfo = { eta: '3-5 days', etaLabel: 'Standard Delivery', deliveryCharge: 0 };
    if (normalizedAddress.lat !== undefined && normalizedAddress.lng !== undefined && vendors[0]?.location?.coordinates) {
        const [vendorLng, vendorLat] = vendors[0].location.coordinates;
        deliveryDistance = haversineDistance(normalizedAddress.lat, normalizedAddress.lng, vendorLat, vendorLng);
        deliveryInfo = getDeliveryInfo(deliveryDistance);
    }

    let discount = 0;
    let appliedCoupon = null;
    if (coupon) {
        const validation = coupon.validateCoupon(req.user?._id, subtotal);
        if (validation.valid) {
            discount = coupon.calculateDiscount(subtotal);
            appliedCoupon = coupon;
        }
    }

    const { platformTotal, vendorPayouts } = calculateMultiVendorPayouts(orderItems, commissionRates);

    const shippingQuote = calculateShippingQuote({
        city: normalizedAddress.city,
        pincode: normalizedAddress.pincode,
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
    const orderPayload = {
        customerId: req.user?._id || null,
        guestEmail: orderEmail,
        guestPhone: normalizedAddress.phone,
        items: orderItems,
        vendorIds: vendorIdArray,
        subtotal,
        platformFee: platformTotal,
        deliveryCharge: shippingQuote.shippingCharge,
        discount,
        total,
        vendorPayouts,
        couponCode: clean(couponCode).toUpperCase() || undefined,
        paymentMethod: paymentMethodValue,
        paymentStatus: 'pending',
        deliveryAddress: normalizedAddress,
        deliveryETA: deliveryInfo.eta,
        estimatedDelivery: getEstimatedDeliveryDate(deliveryDistance),
        deliveryDistance,
        shippingRule: {
            ruleId: shippingQuote.ruleId,
            city: shippingQuote.city || normalizedAddress.city,
            freeShippingThreshold: shippingQuote.freeShippingThreshold,
            baseShippingCharge: shippingQuote.baseShippingCharge,
            appliedCharge: shippingQuote.shippingCharge,
            matchingMode: shippingQuote.matchingMode,
            pincodeRangesText: shippingQuote.pincodeRangesText,
        },
        vendorFulfillments: vendorIdArray.map(vid => ({ vendorId: vid, status: 'pending' })),
        refundWindowDays: Number(refundWindowDays) || 5,
    };

    let updatedUser = null;
    const stockOperations = orderItems.map((item) => ({
        updateOne: {
            filter: {
                _id: item.productId,
                isActive: true,
                stock: { $gte: item.qty },
            },
            update: { $inc: { stock: -item.qty, orderCount: item.qty } },
        },
    }));

    let order;
    const session = await mongoose.startSession();
    try {
        let transactionSupported = true;

        try {
            await session.withTransaction(async () => {
                const stockResult = await Product.bulkWrite(stockOperations, { session, ordered: true });
                if (stockResult.modifiedCount !== orderItems.length) {
                    throw createHttpError(409, 'One or more items became unavailable during checkout');
                }

                [order] = await Order.create([orderPayload], { session });
                updatedUser = await syncAddressToUser(req.user?._id, normalizedAddress, session);

                if (appliedCoupon) {
                    await Coupon.updateOne(
                        { _id: appliedCoupon._id },
                        {
                            $inc: { usedCount: 1 },
                            ...(req.user ? { $addToSet: { usedBy: req.user._id } } : {}),
                        },
                        { session },
                    );
                }

                await Vendor.updateMany(
                    { _id: { $in: vendorIdArray } },
                    { $inc: { totalOrders: 1 } },
                    { session },
                );
            });
        } catch (error) {
            if (!isTransactionUnsupportedError(error)) {
                throw error;
            }

            transactionSupported = false;
        }

        if (!transactionSupported) {
            const rollbackStock = await reserveStockWithoutTransaction(orderItems);
            try {
                order = await Order.create(orderPayload);
                updatedUser = await syncAddressToUser(req.user?._id, normalizedAddress);

                await Promise.all([
                    appliedCoupon
                        ? Coupon.updateOne(
                            { _id: appliedCoupon._id },
                            {
                                $inc: { usedCount: 1 },
                                ...(req.user ? { $addToSet: { usedBy: req.user._id } } : {}),
                            },
                        )
                        : Promise.resolve(),
                    Vendor.updateMany({ _id: { $in: vendorIdArray } }, { $inc: { totalOrders: 1 } }),
                ]);
            } catch (error) {
                await rollbackStock();
                throw error;
            }
        }
    } finally {
        await session.endSession();
    }

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
        ? 'storeName storeLogo phone email address city state pincode location'
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
