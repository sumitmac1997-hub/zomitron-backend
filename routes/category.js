const express = require('express');
const router = express.Router();
const asyncHandler = require('express-async-handler');
const Category = require('../models/Category');
const Product = require('../models/Product');
const { protect, authorize } = require('../middleware/auth');
const { uploadVendor, toUploadUrl } = require('../config/cloudinary');
const { syncDefaultCategories } = require('../utils/syncDefaultCategories');

// GET /api/categories — All categories (tree structure)
router.get('/', asyncHandler(async (req, res) => {
    await syncDefaultCategories();

    const all = await Category.find({ isActive: true }).sort({ sortOrder: 1, name: 1 }).lean();

    const byId = new Map();
    all.forEach((cat) => byId.set(String(cat._id), { ...cat, subcategories: [] }));

    const roots = [];
    byId.forEach((cat) => {
        if (cat.parent) {
            const parent = byId.get(String(cat.parent));
            if (parent) parent.subcategories.push(cat);
        } else {
            roots.push(cat);
        }
    });

    res.json({ success: true, categories: roots });
}));

// GET /api/categories/flat — All categories flat list
router.get('/flat', asyncHandler(async (req, res) => {
    await syncDefaultCategories();
    const categories = await Category.find({ isActive: true }).sort({ sortOrder: 1, name: 1 }).lean();
    res.json({ success: true, categories });
}));

// GET /api/categories/:slug — Category by slug
router.get('/:slug', asyncHandler(async (req, res) => {
    await syncDefaultCategories();
    const category = await Category.findOne({ slug: req.params.slug }).lean();
    if (!category) return res.status(404).json({ success: false, message: 'Category not found' });

    const subcategories = await Category.find({ parent: category._id, isActive: true }).lean();
    res.json({ success: true, category: { ...category, subcategories } });
}));

// POST /api/categories — Admin create category
router.post('/', protect, authorize('admin'), uploadVendor.single('image'), asyncHandler(async (req, res) => {
    const { name, slug, description, icon, themeColor, parent, sortOrder } = req.body;
    const image = req.file ? toUploadUrl(req.file) : undefined;

    const category = await Category.create({
        name,
        slug,
        description,
        icon,
        themeColor,
        image,
        parent: parent || null,
        sortOrder: sortOrder || 0,
    });
    res.status(201).json({ success: true, category });
}));

// PUT /api/categories/:id — Admin update category
router.put('/:id', protect, authorize('admin'), uploadVendor.single('image'), asyncHandler(async (req, res) => {
    const updates = { ...req.body };
    if (req.file) updates.image = toUploadUrl(req.file);
    if (updates.parent === '') updates.parent = null;
    const category = await Category.findByIdAndUpdate(req.params.id, updates, { new: true, runValidators: true });
    res.json({ success: true, category });
}));

// DELETE /api/categories/:id
router.delete('/:id', protect, authorize('admin'), asyncHandler(async (req, res) => {
    const hasProducts = await Product.exists({ category: req.params.id });
    if (hasProducts) return res.status(400).json({ success: false, message: 'Cannot delete category with existing products' });
    await Category.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: 'Category deleted' });
}));

module.exports = router;
