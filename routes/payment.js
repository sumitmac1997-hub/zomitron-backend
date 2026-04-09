const express = require('express');
const router = express.Router();
const asyncHandler = require('express-async-handler');
const Stripe = require('stripe');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const Order = require('../models/Order');
const { protect, optionalAuth } = require('../middleware/auth');
const {
    finalizeOrderPlacement,
    abortOrderDraft,
} = require('../utils/orderPlacement');

const normalizeRazorpayCredential = (value) => (value ?? '').toString().trim();
const createHttpError = (statusCode, message) => {
    const error = new Error(message);
    error.statusCode = statusCode;
    return error;
};
const razorpayKeyId = normalizeRazorpayCredential(process.env.RAZORPAY_KEY_ID);
const razorpayKeySecret = normalizeRazorpayCredential(process.env.RAZORPAY_KEY_SECRET);
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const isRazorpayConfigured = Boolean(razorpayKeyId && razorpayKeySecret);
const razorpay = isRazorpayConfigured
    ? new Razorpay({ key_id: razorpayKeyId, key_secret: razorpayKeySecret })
    : null;

const extractRazorpayErrorMessage = (error) => {
    const candidates = [
        error?.error?.description,
        error?.response?.body?.error?.description,
        error?.response?.data?.error?.description,
        error?.response?.body?.description,
        error?.description,
        error?.message,
    ]
        .map((value) => (typeof value === 'string' ? value.trim() : ''))
        .filter(Boolean);

    const message = candidates.find((value) => !/^internal server error$/i.test(value));
    return message || 'Unable to start Razorpay checkout right now. Please verify the Razorpay key ID, key secret, and account mode configured on the backend.';
};

const getRazorpayStatusCode = (error, fallback = 502) => {
    const statusCode = [
        error?.statusCode,
        error?.response?.statusCode,
        error?.response?.status,
    ]
        .map((value) => Number(value))
        .find((value) => Number.isInteger(value) && value >= 400 && value < 600);

    return statusCode || fallback;
};

// POST /api/payments/stripe/intent — Create Stripe Payment Intent
router.post('/stripe/intent', optionalAuth, asyncHandler(async (req, res) => {
    if (!stripe) return res.status(503).json({ success: false, message: 'Stripe not configured' });

    const { orderId } = req.body;
    const order = await Order.findById(orderId);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

    const paymentIntent = await stripe.paymentIntents.create({
        amount: Math.round(order.total * 100), // convert to paise/cents
        currency: 'inr',
        metadata: { orderId: order._id.toString(), orderNumber: order.orderNumber },
        description: `Zomitron Order ${order.orderNumber}`,
    });

    order.paymentIntentId = paymentIntent.id;
    await order.save();

    res.json({
        success: true,
        clientSecret: paymentIntent.client_secret,
        paymentIntentId: paymentIntent.id,
        amount: order.total,
    });
}));

// POST /api/payments/stripe/webhook — Stripe webhook
router.post('/stripe/webhook', express.raw({ type: 'application/json' }), asyncHandler(async (req, res) => {
    if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) {
        return res.status(200).end();
    }
    const sig = req.headers['stripe-signature'];
    let event;
    try {
        event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
        return res.status(400).json({ error: `Webhook Error: ${err.message}` });
    }

    if (event.type === 'payment_intent.succeeded') {
        const pi = event.data.object;
        const order = await Order.findOne({ paymentIntentId: pi.id });
        if (order) {
            order.paymentStatus = 'paid';
            order.orderStatus = 'confirmed';
            order.confirmedAt = new Date();
            await order.save();
            const io = req.app.get('io');
            if (io) io.emitToUser(order.customerId?.toString(), 'paymentSuccess', { orderId: order._id });
        }
    }
    res.json({ received: true });
}));

// POST /api/payments/razorpay/order — Create Razorpay Order
router.post('/razorpay/order', optionalAuth, asyncHandler(async (req, res) => {
    if (!razorpay) return res.status(503).json({ success: false, message: 'Razorpay not configured' });

    const { orderId } = req.body;
    const order = await Order.findById(orderId);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    if (order.paymentMethod !== 'razorpay') {
        return res.status(400).json({ success: false, message: 'Order is not using Razorpay' });
    }
    if (order.isPlaced !== false) {
        return res.status(400).json({ success: false, message: 'Order has already been finalized' });
    }
    if (!order.stockReserved || order.paymentStatus === 'failed' || order.orderStatus === 'cancelled') {
        return res.status(409).json({ success: false, message: 'This Razorpay checkout session has expired. Please try again.' });
    }

    let rzpOrder;
    try {
        rzpOrder = await razorpay.orders.create({
            amount: Math.round(order.total * 100), // paise
            currency: 'INR',
            receipt: String(order.orderNumber || order._id).slice(0, 40),
            notes: {
                orderId: order._id.toString(),
                orderNumber: order.orderNumber,
            },
        });
    } catch (error) {
        throw createHttpError(getRazorpayStatusCode(error), extractRazorpayErrorMessage(error));
    }

    order.razorpayOrderId = rzpOrder.id;
    await order.save();

    res.json({
        success: true,
        razorpayOrderId: rzpOrder.id,
        amount: order.total,
        currency: 'INR',
        keyId: razorpayKeyId,
        orderNumber: order.orderNumber,
    });
}));

// POST /api/payments/razorpay/verify — Verify Razorpay payment
router.post('/razorpay/verify', optionalAuth, asyncHandler(async (req, res) => {
    const { razorpayOrderId, razorpayPaymentId, razorpaySignature, orderId } = req.body;

    if (!isRazorpayConfigured) {
        return res.status(503).json({ success: false, message: 'Razorpay not configured' });
    }

    const expectedSig = crypto
        .createHmac('sha256', razorpayKeySecret)
        .update(`${razorpayOrderId}|${razorpayPaymentId}`)
        .digest('hex');

    if (expectedSig !== razorpaySignature) {
        return res.status(400).json({ success: false, message: 'Invalid payment signature' });
    }

    const order = await Order.findById(orderId);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    if (order.paymentMethod !== 'razorpay') {
        return res.status(400).json({ success: false, message: 'Order is not using Razorpay' });
    }
    if (!order.stockReserved || order.paymentStatus === 'failed' || order.orderStatus === 'cancelled') {
        return res.status(409).json({ success: false, message: 'This Razorpay checkout session has expired. Please try again.' });
    }
    if (order.razorpayOrderId && order.razorpayOrderId !== razorpayOrderId) {
        return res.status(400).json({ success: false, message: 'Razorpay order mismatch' });
    }
    if (order.isPlaced !== false && order.paymentStatus === 'paid') {
        return res.json({
            success: true,
            message: 'Payment already verified',
            order: { _id: order._id, orderNumber: order.orderNumber, orderStatus: order.orderStatus },
        });
    }

    const finalized = await finalizeOrderPlacement({
        orderId: order._id,
        app: req.app,
        markPaid: true,
        razorpayPaymentId,
    });

    res.json({
        success: true,
        message: 'Payment verified',
        order: {
            _id: finalized.order._id,
            orderNumber: finalized.order.orderNumber,
            orderStatus: finalized.order.orderStatus,
        },
        user: finalized.updatedUser,
    });
}));

// POST /api/payments/razorpay/abort — Abort pending Razorpay checkout
router.post('/razorpay/abort', optionalAuth, asyncHandler(async (req, res) => {
    const { orderId, reason } = req.body;
    if (!orderId) {
        return res.status(400).json({ success: false, message: 'orderId is required' });
    }

    const order = await Order.findById(orderId);
    if (!order) {
        return res.json({ success: true, message: 'Draft order already removed' });
    }
    if (order.paymentMethod !== 'razorpay') {
        return res.status(400).json({ success: false, message: 'Order is not using Razorpay' });
    }

    const abortedOrder = await abortOrderDraft({
        orderId,
        reason: reason || 'Razorpay checkout aborted before payment completion',
    });

    if (abortedOrder?.isPlaced !== false) {
        return res.status(409).json({ success: false, message: 'Order has already been placed' });
    }

    res.json({ success: true, message: 'Pending Razorpay checkout cancelled' });
}));

// POST /api/payments/cod/confirm — COD order confirmation
router.post('/cod/confirm', protect, asyncHandler(async (req, res) => {
    const { orderId } = req.body;
    const order = await Order.findById(orderId);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    order.orderStatus = 'confirmed';
    order.confirmedAt = new Date();
    await order.save();
    res.json({ success: true, order });
}));

// GET /api/payments/config — Return public payment keys
router.get('/config', (req, res) => {
    res.json({
        success: true,
        stripe: { publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || null },
        razorpay: { keyId: isRazorpayConfigured ? razorpayKeyId : null },
        paypal: { clientId: process.env.PAYPAL_CLIENT_ID || null },
        available: {
            stripe: !!process.env.STRIPE_SECRET_KEY,
            razorpay: isRazorpayConfigured,
            cod: true,
        },
    });
}),

    module.exports = router;
