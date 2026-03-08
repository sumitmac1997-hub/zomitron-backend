const express = require('express');
const router = express.Router();
const asyncHandler = require('express-async-handler');
const Coupon = require('../models/Coupon');
const { protect, authorize } = require('../middleware/auth');

// GET /api/coupons/validate/:code
router.get('/validate/:code', protect, asyncHandler(async (req, res) => {
    const { orderAmount } = req.query;
    const coupon = await Coupon.findOne({ code: req.params.code.toUpperCase() });
    if (!coupon) return res.status(404).json({ success: false, message: 'Invalid coupon code' });

    const validation = coupon.validate(req.user._id, parseFloat(orderAmount) || 0);
    if (!validation.valid) return res.status(400).json({ success: false, message: validation.message });

    const discount = coupon.calculateDiscount(parseFloat(orderAmount) || 0);
    res.json({ success: true, coupon: { code: coupon.code, discountType: coupon.discountType, discountValue: coupon.discountValue }, discount });
}));

// GET /api/coupons — Admin list all
router.get('/', protect, authorize('admin', 'vendor'), asyncHandler(async (req, res) => {
    const query = req.user.role === 'admin' ? {} : { vendorId: req.query.vendorId };
    const coupons = await Coupon.find(query).sort({ createdAt: -1 }).lean();
    res.json({ success: true, coupons });
}));

// POST /api/coupons — Admin/Vendor create
router.post('/', protect, authorize('admin', 'vendor'), asyncHandler(async (req, res) => {
    const coupon = await Coupon.create(req.body);
    res.status(201).json({ success: true, coupon });
}));

// PUT /api/coupons/:id
router.put('/:id', protect, authorize('admin', 'vendor'), asyncHandler(async (req, res) => {
    const coupon = await Coupon.findByIdAndUpdate(req.params.id, req.body, { new: true });
    res.json({ success: true, coupon });
}));

// DELETE /api/coupons/:id
router.delete('/:id', protect, authorize('admin'), asyncHandler(async (req, res) => {
    await Coupon.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: 'Coupon deleted' });
}));

module.exports = router;
