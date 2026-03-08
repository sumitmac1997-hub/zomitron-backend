const mongoose = require('mongoose');

const couponSchema = new mongoose.Schema(
    {
        code: {
            type: String,
            required: true,
            unique: true,
            uppercase: true,
            trim: true,
        },
        description: String,
        discountType: {
            type: String,
            enum: ['percentage', 'fixed'],
            required: true,
        },
        discountValue: {
            type: Number,
            required: true,
            min: 0,
        },
        maxDiscountAmount: Number, // Cap for percentage discounts
        minOrderAmount: { type: Number, default: 0 },
        vendorId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Vendor',
            default: null, // null = platform-wide coupon
        },
        usageLimit: { type: Number, default: null }, // null = unlimited
        usedCount: { type: Number, default: 0 },
        perUserLimit: { type: Number, default: 1 },
        usedBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
        expiresAt: { type: Date, required: true },
        isActive: { type: Boolean, default: true },
        applicableCategories: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Category' }],
    },
    { timestamps: true }
);

couponSchema.index({ code: 1 });
couponSchema.index({ expiresAt: 1 });
couponSchema.index({ vendorId: 1 });

// Validate coupon
couponSchema.methods.validate = function (userId, orderAmount) {
    if (!this.isActive) return { valid: false, message: 'Coupon is inactive' };
    if (new Date() > this.expiresAt) return { valid: false, message: 'Coupon has expired' };
    if (this.usageLimit && this.usedCount >= this.usageLimit) return { valid: false, message: 'Coupon usage limit reached' };
    if (orderAmount < this.minOrderAmount) return { valid: false, message: `Minimum order amount is ₹${this.minOrderAmount}` };
    const userUsed = this.usedBy.filter((id) => id.toString() === userId.toString()).length;
    if (userUsed >= this.perUserLimit) return { valid: false, message: 'You have already used this coupon' };
    return { valid: true };
};

// Calculate discount
couponSchema.methods.calculateDiscount = function (orderAmount) {
    let discount = 0;
    if (this.discountType === 'percentage') {
        discount = (orderAmount * this.discountValue) / 100;
        if (this.maxDiscountAmount) discount = Math.min(discount, this.maxDiscountAmount);
    } else {
        discount = this.discountValue;
    }
    return Math.min(discount, orderAmount);
};

module.exports = mongoose.model('Coupon', couponSchema);
