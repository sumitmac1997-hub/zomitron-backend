const express = require('express');
const router = express.Router();
const asyncHandler = require('express-async-handler');
const Review = require('../models/Review');
const Order = require('../models/Order');
const Product = require('../models/Product');
const Vendor = require('../models/Vendor');
const { protect } = require('../middleware/auth');
const { uploadProduct, toUploadUrl } = require('../config/cloudinary');

// GET /api/reviews/product/:productId
router.get('/product/:productId', asyncHandler(async (req, res) => {
    const { page = 1, limit = 10, sort = 'newest' } = req.query;
    const sortMap = { newest: { createdAt: -1 }, rating_high: { rating: -1 }, rating_low: { rating: 1 } };

    const reviews = await Review.find({ productId: req.params.productId, isApproved: true })
        .populate('customerId', 'name avatar')
        .sort(sortMap[sort] || { createdAt: -1 })
        .skip((parseInt(page) - 1) * parseInt(limit))
        .limit(parseInt(limit))
        .lean();

    const total = await Review.countDocuments({ productId: req.params.productId, isApproved: true });
    const stats = await Review.aggregate([
        { $match: { productId: require('mongoose').Types.ObjectId.createFromHexString(req.params.productId) } },
        { $group: { _id: '$rating', count: { $sum: 1 } } },
    ]);

    res.json({ success: true, reviews, total, stats });
}));

// GET /api/reviews/vendor/:vendorId
router.get('/vendor/:vendorId', asyncHandler(async (req, res) => {
    const reviews = await Review.find({ vendorId: req.params.vendorId, isApproved: true })
        .populate('customerId', 'name avatar')
        .populate('productId', 'title images')
        .sort({ createdAt: -1 })
        .limit(20)
        .lean();
    res.json({ success: true, reviews });
}));

// POST /api/reviews — Create review
router.post('/', protect, uploadProduct.array('images', 3), asyncHandler(async (req, res) => {
    const { productId, orderId, rating, title, comment } = req.body;

    // Verify order belongs to user and product is in it
    const order = await Order.findOne({
        _id: orderId,
        customerId: req.user._id,
        'items.productId': productId,
        orderStatus: 'delivered',
    });
    if (!order) return res.status(403).json({ success: false, message: 'Can only review products from delivered orders' });

    const existing = await Review.findOne({ productId, customerId: req.user._id, orderId });
    if (existing) return res.status(400).json({ success: false, message: 'Already reviewed this product' });

    const product = await Product.findById(productId);
    const images = req.files?.map((f) => toUploadUrl(f)).filter(Boolean) || [];

    const review = await Review.create({
        productId, vendorId: product.vendorId, customerId: req.user._id,
        orderId, rating: parseInt(rating), title, comment, images,
        isVerifiedPurchase: true,
    });

    res.status(201).json({ success: true, review });
}));

// PUT /api/reviews/:id/reply — Vendor reply to review
router.put('/:id/reply', protect, asyncHandler(async (req, res) => {
    const review = await Review.findById(req.params.id).populate('vendorId');
    if (!review) return res.status(404).json({ success: false, message: 'Review not found' });
    const vendor = await Vendor.findOne({ userId: req.user._id });
    if (!vendor || review.vendorId._id.toString() !== vendor._id.toString()) {
        return res.status(403).json({ success: false, message: 'Not your product review' });
    }
    review.vendorReply = { comment: req.body.comment, repliedAt: new Date() };
    await review.save();
    res.json({ success: true, review });
}));

// POST /api/reviews/:id/helpful — Mark helpful
router.post('/:id/helpful', protect, asyncHandler(async (req, res) => {
    await Review.findByIdAndUpdate(req.params.id, { $inc: { helpfulCount: 1 } });
    res.json({ success: true });
}));

module.exports = router;
