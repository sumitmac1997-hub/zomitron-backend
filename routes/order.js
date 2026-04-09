const express = require('express');
const router = express.Router();
const asyncHandler = require('express-async-handler');
const Order = require('../models/Order');
const Product = require('../models/Product');
const Vendor = require('../models/Vendor');
const { protect, optionalAuth, authorize } = require('../middleware/auth');
const { getDeliveryInfo } = require('../utils/deliveryETA');
const { getSettingValue } = require('../utils/settings');
const {
    prepareOrderDraft,
    createOrderDraft,
    finalizeOrderPlacement,
} = require('../utils/orderPlacement');

// POST /api/orders — Create order
router.post('/', optionalAuth, asyncHandler(async (req, res) => {
    const { orderPayload, paymentMethodValue, deliveryInfo, shippingQuote } = await prepareOrderDraft({
        user: req.user,
        body: req.body,
    });

    const reserveStockForDraft = paymentMethodValue === 'razorpay';
    const draftOrder = await createOrderDraft({
        orderPayload,
        reserveStock: reserveStockForDraft,
    });

    let finalizedOrder = draftOrder;
    let updatedUser = null;

    if (paymentMethodValue !== 'razorpay') {
        const finalized = await finalizeOrderPlacement({
            orderId: draftOrder._id,
            app: req.app,
            markPaid: false,
        });
        finalizedOrder = finalized.order;
        updatedUser = finalized.updatedUser;
    }

    res.status(201).json({
        success: true,
        order: {
            ...finalizedOrder.toObject(),
            deliveryInfo: { ...deliveryInfo, deliveryCharge: shippingQuote.shippingCharge },
            shippingQuote,
        },
        requiresPayment: paymentMethodValue === 'razorpay',
        user: updatedUser,
    });
}));

// GET /api/orders/my — Customer order history
router.get('/my', protect, asyncHandler(async (req, res) => {
    const { page = 1, limit = 10, status } = req.query;
    const query = { customerId: req.user._id, isPlaced: { $ne: false } };
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

    const order = await Order.findOne({ _id: req.params.id, isPlaced: { $ne: false } })
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
    const order = await Order.findOne({ _id: req.params.id, isPlaced: { $ne: false } });
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
    const order = await Order.findOne({ _id: req.params.id, customerId: req.user._id, isPlaced: { $ne: false } });
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
    const order = await Order.findOne({ _id: req.params.id, customerId: req.user._id, isPlaced: { $ne: false } });
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
    const order = await Order.findOne({ _id: req.params.id, customerId: req.user._id, isPlaced: { $ne: false } });
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
    const order = await Order.findOne({ _id: req.params.id, isPlaced: { $ne: false } })
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
