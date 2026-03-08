const mongoose = require('mongoose');

const reviewSchema = new mongoose.Schema(
    {
        productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
        vendorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Vendor', required: true },
        customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true },
        rating: { type: Number, required: true, min: 1, max: 5 },
        title: { type: String, maxlength: 100 },
        comment: { type: String, maxlength: 1000 },
        images: [String],
        isVerifiedPurchase: { type: Boolean, default: true },
        isApproved: { type: Boolean, default: true },
        helpfulCount: { type: Number, default: 0 },
        vendorReply: {
            comment: String,
            repliedAt: Date,
        },
    },
    { timestamps: true }
);

// Unique review per customer per product per order
reviewSchema.index({ productId: 1, customerId: 1, orderId: 1 }, { unique: true });
reviewSchema.index({ vendorId: 1 });

// Update product rating after review save
reviewSchema.post('save', async function () {
    const Product = mongoose.model('Product');
    const stats = await mongoose.model('Review').aggregate([
        { $match: { productId: this.productId } },
        { $group: { _id: null, avgRating: { $avg: '$rating' }, count: { $sum: 1 } } },
    ]);
    if (stats.length > 0) {
        await Product.findByIdAndUpdate(this.productId, {
            'ratings.average': Math.round(stats[0].avgRating * 10) / 10,
            'ratings.count': stats[0].count,
        });
    }
});

module.exports = mongoose.model('Review', reviewSchema);
