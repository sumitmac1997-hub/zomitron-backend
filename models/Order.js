const mongoose = require('mongoose');

const orderItemSchema = new mongoose.Schema({
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    vendorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Vendor', required: true },
    title: String,
    image: String,
    price: { type: Number, required: true },
    qty: { type: Number, required: true, min: 1 },
    subtotal: Number,
});

const orderSchema = new mongoose.Schema(
    {
        customerId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            default: null,
        },
        orderNumber: { type: String, unique: true },
        items: [orderItemSchema],
        vendorIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Vendor' }],
        // Financials
        subtotal: { type: Number, required: true },
        platformFee: { type: Number, default: 0 },
        deliveryCharge: { type: Number, default: 0 },
        discount: { type: Number, default: 0 },
        total: { type: Number, required: true },
        // Vendor payout map: { vendorId: amount }
        vendorPayouts: { type: Map, of: Number },
        couponCode: String,
        // Payment
        paymentMethod: {
            type: String,
            enum: ['stripe', 'razorpay', 'paypal', 'cod'],
            required: true,
        },
        paymentStatus: {
            type: String,
            enum: ['pending', 'paid', 'failed', 'refunded', 'partial_refund'],
            default: 'pending',
        },
        paymentIntentId: String, // Stripe
        razorpayOrderId: String,
        razorpayPaymentId: String,
        paypalOrderId: String,
        isPlaced: { type: Boolean, default: false },
        stockReserved: { type: Boolean, default: false },
        placedAt: Date,
        // Delivery
        deliveryAddress: {
            name: String,
            email: String,
            phone: String,
            line1: String,
            line2: String,
            city: String,
            state: String,
            pincode: String,
            lat: Number,
            lng: Number,
        },
        deliveryETA: { type: String }, // e.g. "2 hours", "1 day"
        estimatedDelivery: Date,
        deliveryDistance: Number, // km from vendor
        shippingRule: {
            ruleId: { type: mongoose.Schema.Types.ObjectId, ref: 'ShippingRule', default: null },
            city: String,
            freeShippingThreshold: Number,
            baseShippingCharge: Number,
            appliedCharge: Number,
            matchingMode: String,
            pincodeRangesText: String,
        },
        // Order Status
        orderStatus: {
            type: String,
            enum: ['pending', 'confirmed', 'processing', 'shipped', 'out_for_delivery', 'delivered', 'cancelled', 'returned'],
            default: 'pending',
        },
        // Tracking
        trackingCode: String,
        trackingUrl: String,
        // Timestamps for status
        confirmedAt: Date,
        shippedAt: Date,
        deliveredAt: Date,
        cancelledAt: Date,
        cancellationReason: String,
        // Refunds
        refundStatus: {
            type: String,
            enum: ['none', 'requested', 'approved', 'rejected', 'processed'],
            default: 'none',
        },
        refundRequestedAt: Date,
        refundProcessedAt: Date,
        refundReason: String,
        refundResponse: String,
        refundWindowDays: { type: Number, default: 5 },
        // Item-level refund requests
        refundRequests: [
            {
                itemId: { type: mongoose.Schema.Types.ObjectId },
                productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
                vendorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Vendor' },
                title: String,
                image: String,
                qty: Number,
                price: Number,
                amount: Number,
                status: {
                    type: String,
                    enum: ['requested', 'approved', 'rejected', 'processed'],
                    default: 'requested',
                },
                reason: String,
                responseNote: String,
                requestedAt: { type: Date, default: Date.now },
                processedAt: Date,
            },
        ],
        // Fulfillment per vendor
        vendorFulfillments: [
            {
                vendorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Vendor' },
                status: {
                    type: String,
                    enum: ['pending', 'confirmed', 'processing', 'shipped', 'out_for_delivery', 'delivered', 'cancelled'],
                    default: 'pending',
                },
                trackingCode: String,
                shippedAt: Date,
                fulfilledAt: Date,
            },
        ],
        // Notes
        customerNote: String,
        adminNote: String,
        isReviewed: { type: Boolean, default: false },
        // Guest order
        guestEmail: String,
        guestPhone: String,
    },
    { timestamps: true }
);

// Indexes
orderSchema.index({ customerId: 1, createdAt: -1 });
orderSchema.index({ vendorIds: 1, createdAt: -1 });
orderSchema.index({ isPlaced: 1, createdAt: -1 });
orderSchema.index({ orderStatus: 1, createdAt: -1 });
orderSchema.index({ paymentStatus: 1, createdAt: -1 });
orderSchema.index({ refundStatus: 1, createdAt: -1 });
orderSchema.index({ 'vendorFulfillments.vendorId': 1, createdAt: -1 });

// Auto-generate order number
orderSchema.pre('save', function (next) {
    if (!this.orderNumber) {
        this.orderNumber = 'ZOM' + Date.now() + Math.random().toString(36).substr(2, 4).toUpperCase();
    }
    // Calculate item subtotals
    this.items = this.items.map((item) => ({
        ...item.toObject ? item.toObject() : item,
        subtotal: item.price * item.qty,
    }));
    next();
});

module.exports = mongoose.model('Order', orderSchema);
