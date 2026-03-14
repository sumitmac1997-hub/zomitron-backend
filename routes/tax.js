const express = require('express');
const router = express.Router();
const asyncHandler = require('express-async-handler');
const TaxClass = require('../models/TaxClass');
const { protect, authorize } = require('../middleware/auth');

const ensureDefaults = async () => {
    const count = await TaxClass.countDocuments();
    if (count > 0) return;
    await TaxClass.insertMany([
        { name: 'Standard', code: 'standard', rate: 0, priority: 1, taxName: 'Standard' },
        { name: '5% GST Uttar Pradesh', code: 'gst_5', rate: 5, priority: 1, taxName: 'GST' },
        { name: '12% GST Uttar Pradesh', code: 'gst_12', rate: 12, priority: 1, taxName: 'GST' },
        { name: '18% GST Uttar Pradesh', code: 'gst_18', rate: 18, priority: 1, taxName: 'GST' },
        { name: 'Zero rate', code: 'zero', rate: 0, priority: 2, taxName: 'Zero' },
    ]);
};

// Public — active tax classes
router.get('/', asyncHandler(async (_req, res) => {
    await ensureDefaults();
    const taxes = await TaxClass.find({ isActive: true }).sort({ priority: 1, createdAt: -1 }).lean();
    res.json({ success: true, taxes });
}));

// Admin — list all (including inactive)
router.get('/all', protect, authorize('admin'), asyncHandler(async (_req, res) => {
    const taxes = await TaxClass.find({}).sort({ createdAt: -1 }).lean();
    res.json({ success: true, taxes });
}));

// Admin — create tax class
router.post('/', protect, authorize('admin'), asyncHandler(async (req, res) => {
    const { name, code, rate, priority = 1, appliesToShipping = false, isCompound = false, description, countryCode, stateCode, city, postcode, taxName } = req.body;

    if (!name || !code || rate === undefined) {
        return res.status(400).json({ success: false, message: 'Name, code and rate are required' });
    }

    const tax = await TaxClass.create({
        name: String(name).trim(),
        code: String(code).trim().toLowerCase(),
        rate: Number(rate),
        priority: Number(priority) || 1,
        appliesToShipping: appliesToShipping === true || appliesToShipping === 'true',
        isCompound: isCompound === true || isCompound === 'true',
        description,
        countryCode: countryCode || 'IN',
        stateCode: stateCode || 'UP',
        city: city || '*',
        postcode: postcode || '*',
        taxName: taxName || '',
        createdBy: req.user._id,
        updatedBy: req.user._id,
    });

    res.status(201).json({ success: true, tax });
}));

// Admin — update tax class
router.put('/:id', protect, authorize('admin'), asyncHandler(async (req, res) => {
    const updates = { ...req.body, updatedBy: req.user._id };
    if (updates.code) updates.code = String(updates.code).toLowerCase();
    if (updates.rate !== undefined) updates.rate = Number(updates.rate);
    if (updates.priority !== undefined) updates.priority = Number(updates.priority);
    if (updates.appliesToShipping !== undefined) updates.appliesToShipping = updates.appliesToShipping === true || updates.appliesToShipping === 'true';
    if (updates.isCompound !== undefined) updates.isCompound = updates.isCompound === true || updates.isCompound === 'true';

    const tax = await TaxClass.findByIdAndUpdate(req.params.id, updates, { new: true, runValidators: true });
    if (!tax) return res.status(404).json({ success: false, message: 'Tax class not found' });
    res.json({ success: true, tax });
}));

// Admin — delete (soft deactivate)
router.delete('/:id', protect, authorize('admin'), asyncHandler(async (req, res) => {
    const tax = await TaxClass.findByIdAndUpdate(req.params.id, { isActive: false, updatedBy: req.user._id }, { new: true });
    if (!tax) return res.status(404).json({ success: false, message: 'Tax class not found' });
    res.json({ success: true, message: 'Tax class deactivated', tax });
}));

module.exports = router;
