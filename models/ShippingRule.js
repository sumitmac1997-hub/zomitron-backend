const mongoose = require('mongoose');
const { normalizeCity, parsePincodeRanges } = require('../utils/shippingRules');

const pincodeRangeSchema = new mongoose.Schema(
    {
        start: {
            type: String,
            required: true,
            match: [/^\d{6}$/, 'Pincode range start must be 6 digits'],
        },
        end: {
            type: String,
            required: true,
            match: [/^\d{6}$/, 'Pincode range end must be 6 digits'],
        },
    },
    { _id: false }
);

const shippingRuleSchema = new mongoose.Schema(
    {
        city: {
            type: String,
            required: [true, 'City is required'],
            trim: true,
        },
        cityNormalized: {
            type: String,
            required: true,
            index: true,
        },
        pincodeRanges: {
            type: [pincodeRangeSchema],
            default: [],
        },
        freeShippingThreshold: {
            type: Number,
            default: 0,
            min: [0, 'Free shipping threshold cannot be negative'],
        },
        shippingCharge: {
            type: Number,
            required: [true, 'Shipping charge is required'],
            min: [0, 'Shipping charge cannot be negative'],
        },
        isActive: {
            type: Boolean,
            default: true,
        },
        createdBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
        },
    },
    { timestamps: true }
);

shippingRuleSchema.pre('validate', function (next) {
    this.cityNormalized = normalizeCity(this.city);
    this.pincodeRanges = parsePincodeRanges(this.pincodeRanges);
    next();
});

shippingRuleSchema.index({ cityNormalized: 1, isActive: 1 });

module.exports = mongoose.model('ShippingRule', shippingRuleSchema);
