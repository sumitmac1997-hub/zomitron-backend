const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const vehicleDetailsSchema = new mongoose.Schema({
    vehicleType: {
        type: String,
        enum: ['bike', 'scooter', 'bicycle', 'car'],
        required: true,
    },
    regNumber: { type: String, required: true, trim: true },
    ownerName: { type: String, required: true, trim: true },
    insuranceValidTill: { type: Date, required: true },
    numberPlate: { type: String, required: true, trim: true },
}, { _id: false });

const riderSchema = new mongoose.Schema(
    {
        userId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true,
            unique: true,
        },
        city: {
            type: String,
            required: [true, 'City is required'],
            trim: true,
        },
        vehicleDetails: {
            type: vehicleDetailsSchema,
            required: true,
        },
        status: {
            type: String,
            enum: ['PENDING', 'ACTIVE', 'REJECTED'],
            default: 'PENDING',
        },
        rejectionReason: { type: String },
        approvedAt: { type: Date },
        approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

        // Live location (plain lat/lng — updated via REST/socket every 10s)
        location: {
            lat: { type: Number, default: null },
            lng: { type: Number, default: null },
            updatedAt: { type: Date, default: null },
        },

        // GeoJSON for $near queries (kept in sync with location)
        currentLocation: {
            type: {
                type: String,
                enum: ['Point'],
                default: 'Point',
            },
            coordinates: {
                type: [Number], // [lng, lat]
                default: [0, 0],
            },
        },

        isOnline: { type: Boolean, default: false },

        // Delivery stats
        totalDeliveries: { type: Number, default: 0 },
        completedDeliveries: { type: Number, default: 0 },
        totalEarnings: { type: Number, default: 0 },

        // Current active order reference (null if free)
        activeOrderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', default: null },

        isActive: { type: Boolean, default: true },
    },
    { timestamps: true }
);

// 2dsphere index for geospatial nearest-rider queries
riderSchema.index({ currentLocation: '2dsphere' });
riderSchema.index({ status: 1, isOnline: 1, isActive: 1 });
riderSchema.index({ userId: 1 });

module.exports = mongoose.model('Rider', riderSchema);
