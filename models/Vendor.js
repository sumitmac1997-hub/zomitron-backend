const mongoose = require('mongoose');

const vendorSchema = new mongoose.Schema(
    {
        userId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true,
            unique: true,
        },
        storeName: {
            type: String,
            required: [true, 'Store name is required'],
            trim: true,
            maxlength: [100, 'Store name cannot exceed 100 characters'],
        },
        storeDescription: {
            type: String,
            maxlength: [500, 'Description cannot exceed 500 characters'],
        },
        storeLogo: String,
        storeBanner: String,
        address: {
            line1: { type: String, required: true },
            line2: String,
            city: { type: String, required: true },
            state: { type: String, required: true },
            pincode: {
                type: String,
                required: true,
                match: [/^\d{6}$/, 'Pincode must be 6 digits'],
            },
        },
        // GeoJSON Point for MongoDB 2dsphere queries
        location: {
            type: {
                type: String,
                enum: ['Point'],
                default: 'Point',
            },
            coordinates: {
                type: [Number], // [longitude, latitude]
                required: true,
                validate: {
                    validator: (v) => v.length === 2 && v[0] >= -180 && v[0] <= 180 && v[1] >= -90 && v[1] <= 90,
                    message: 'Invalid coordinates [lng, lat]',
                },
            },
        },
        city: String,
        state: String,
        pincode: {
            type: String,
            match: [/^\d{6}$/, 'Pincode must be 6 digits'],
        },
        phone: String,
        email: String,
        gstin: String,
        bankDetails: {
            accountName: String,
            accountNumber: String,
            ifscCode: String,
            bankName: String,
            upiId: String,
        },
        storeHours: {
            monday: { open: String, close: String, isClosed: { type: Boolean, default: false } },
            tuesday: { open: String, close: String, isClosed: { type: Boolean, default: false } },
            wednesday: { open: String, close: String, isClosed: { type: Boolean, default: false } },
            thursday: { open: String, close: String, isClosed: { type: Boolean, default: false } },
            friday: { open: String, close: String, isClosed: { type: Boolean, default: false } },
            saturday: { open: String, close: String, isClosed: { type: Boolean, default: false } },
            sunday: { open: String, close: String, isClosed: { type: Boolean, default: true } },
        },
        onVacation: { type: Boolean, default: false },
        vacationMessage: String,
        isOpen: { type: Boolean, default: true }, // Store availability toggle
        approved: { type: Boolean, default: false },
        approvedAt: Date,
        approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        rejectionReason: String,
        // Financials
        balance: { type: Number, default: 0 },
        totalEarnings: { type: Number, default: 0 },
        totalWithdrawn: { type: Number, default: 0 },
        commissionRate: { type: Number, default: 0.1 }, // 10% platform cut
        // Stats
        totalOrders: { type: Number, default: 0 },
        totalProducts: { type: Number, default: 0 },
        ratings: {
            average: { type: Number, default: 0 },
            count: { type: Number, default: 0 },
        },
        isActive: { type: Boolean, default: true },
        stripeAccountId: String, // For Stripe Connect
        razorpayAccountId: String,
    },
    { timestamps: true }
);

// Geospatial index
vendorSchema.index({ location: '2dsphere' });
vendorSchema.index({ pincode: 1 });
vendorSchema.index({ approved: 1, isActive: 1 });

module.exports = mongoose.model('Vendor', vendorSchema);
