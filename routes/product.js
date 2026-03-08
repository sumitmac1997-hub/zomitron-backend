const express = require('express');
const router = express.Router();
const asyncHandler = require('express-async-handler');
const Product = require('../models/Product');
const Vendor = require('../models/Vendor');
const Category = require('../models/Category');
const { protect, authorize } = require('../middleware/auth');
const { haversineDistance } = require('../utils/haversine');
const { getDeliveryInfo } = require('../utils/deliveryETA');
const { uploadProduct, uploadCSV, toUploadUrl } = require('../config/cloudinary');
const csv = require('csv-parser');
const { Readable } = require('stream');

const clean = (val) => (val ?? '').toString().trim();
const normalizeNumber = (val) => {
    const cleaned = clean(val).replace(/[^0-9.\-]/g, '');
    return cleaned ? parseFloat(cleaned) : NaN;
};

// Build/find category from a free-text name (first value of CSV categories)
const categoryCache = new Map();
const ensureCategory = async (rawName) => {
    const name = clean(rawName);
    if (!name) return null;
    const key = name.toLowerCase();
    if (categoryCache.has(key)) return categoryCache.get(key);
    let category = await Category.findOne({ name: new RegExp(`^${name}$`, 'i') });
    if (!category) {
        category = await Category.create({ name, icon: '📦' });
    }
    categoryCache.set(key, category._id);
    return category._id;
};

const parseImages = (val) => clean(val)
    .split(/[,|]/)
    .map((s) => clean(s))
    .filter(Boolean);

const mapCsvRowToProduct = async (row, vendor) => {
    const title = clean(row.title || row.Title || row.Name);
    const description = clean(row.description || row.Description || row['Short description'] || row['Short Description']);
    const price = normalizeNumber(row.price || row.Price || row['Regular price'] || row['Regular Price']);
    const discountPrice = normalizeNumber(row.discountPrice || row['Sale price'] || row['Sale Price']);
    const stockRaw = row.stock || row.Stock || row['Stock'] || row['Quantity'];
    const stockNum = normalizeNumber(stockRaw);
    const stock = Number.isNaN(stockNum) ? 0 : parseInt(stockNum);
    const tags = clean(row.tags || row.Tags).split(',').map((t) => clean(t)).filter(Boolean);
    const sku = clean(row.sku || row.SKU);
    const categoryRaw = clean(row.category || row.Category || row.Categories?.split(',')?.[0]);
    const category = await ensureCategory(categoryRaw || 'General');
    const images = parseImages(row.Images || row.images || row.image || row.Image);
    const pincode = clean(row.pincode || row.Pincode || row['Postal Code']) || vendor.pincode;
    const city = clean(row.city || row.City) || vendor.city;
    const state = clean(row.state || row.State) || vendor.state;
    const productId = clean(row.productId || row.id || row.ID || row._id || row['﻿ID']);

    if (!title || Number.isNaN(price)) {
        return { error: 'Missing required fields (title/price)' };
    }

    const fallbackImage = vendor.storeLogo || vendor.storeBanner || 'https://via.placeholder.com/400x300?text=Product';

    return {
        payload: {
            vendorId: vendor._id,
            title,
            description: description || 'No description provided.',
            price,
            discountPrice: Number.isNaN(discountPrice) ? undefined : discountPrice,
            images: images.length ? images : [fallbackImage],
            category,
            categoryName: categoryRaw || 'General',
            stock,
            location: vendor.location,
            pincode,
            city,
            state,
            tags,
            sku,
            unit: clean(row.unit || row.Unit || row['Weight unit']) || 'piece',
            weight: normalizeNumber(row.weight || row.Weight),
            isApproved: true,
        },
        productId,
        sku,
    };
};

/**
 * GET /api/products
 * Geo-filtered product listing — THE CORE ROUTE
 * Query: lat, lng, radius (km, default 100), category, minPrice, maxPrice,
 *        sort (nearest|price_asc|price_desc|newest|rating), page, limit, search, pincode
 */
router.get('/', asyncHandler(async (req, res) => {
    const {
        lat, lng, radius = 100, category, subCategory, minPrice, maxPrice,
        sort = 'nearest', page = 1, limit = 20, search, pincode, vendorId,
        featured, minRating,
    } = req.query;

    const pageNum = parseInt(page);
    const limitNum = Math.min(parseInt(limit), 100);
    const skip = (pageNum - 1) * limitNum;
    const radiusNum = Math.min(parseInt(radius), 500); // Max 500km

    let pipeline = [];

    // ─── GEOSPATIAL FILTER (Primary method: $geoNear) ─────────────────────
    if (lat && lng) {
        const customerLat = parseFloat(lat);
        const customerLng = parseFloat(lng);

        pipeline.push({
            $geoNear: {
                near: { type: 'Point', coordinates: [customerLng, customerLat] },
                distanceField: 'distance', // distance in meters
                maxDistance: radiusNum * 1000, // convert km to meters
                spherical: true,
                query: { isActive: true, isApproved: true, stock: { $gt: 0 } },
            },
        });

        // Convert distance to km
        pipeline.push({
            $addFields: { distanceKm: { $divide: ['$distance', 1000] } },
        });
    } else {
        // No location — show all active products
        pipeline.push({ $match: { isActive: true, isApproved: true, stock: { $gt: 0 } } });
    }

    // ─── FILTERS ──────────────────────────────────────────────────────────
    const matchStage = {};

    if (category) {
        // Allow category name or ID; include subcategories for parent filters
        const categoryIds = [];
        if (category.match(/^[0-9a-fA-F]{24}$/)) {
            const categoryId = require('mongoose').Types.ObjectId.createFromHexString(category);
            categoryIds.push(categoryId);
            const children = await Category.find({ parent: categoryId }).select('_id').lean();
            categoryIds.push(...children.map((c) => c._id));
        } else {
            // Look up by slug
            const cat = await Category.findOne({ slug: category.toLowerCase() });
            if (cat) {
                categoryIds.push(cat._id);
                const children = await Category.find({ parent: cat._id }).select('_id').lean();
                categoryIds.push(...children.map((c) => c._id));
            }
        }
        if (categoryIds.length > 0) {
            matchStage.$or = [
                { category: { $in: categoryIds } },
                { categories: { $in: categoryIds } },
            ];
        }
    }
    if (subCategory) matchStage.subCategory = require('mongoose').Types.ObjectId.createFromHexString(subCategory);
    if (vendorId) matchStage.vendorId = require('mongoose').Types.ObjectId.createFromHexString(vendorId);
    if (pincode) matchStage.pincode = pincode;
    if (featured === 'true') matchStage.isFeatured = true;
    if (minPrice || maxPrice) {
        matchStage.price = {};
        if (minPrice) matchStage.price.$gte = parseFloat(minPrice);
        if (maxPrice) matchStage.price.$lte = parseFloat(maxPrice);
    }
    if (minRating) matchStage['ratings.average'] = { $gte: parseFloat(minRating) };

    if (Object.keys(matchStage).length > 0) pipeline.push({ $match: matchStage });

    // ─── TEXT SEARCH ──────────────────────────────────────────────────────
    if (search) {
        pipeline.push({
            $match: {
                $or: [
                    { title: { $regex: search, $options: 'i' } },
                    { description: { $regex: search, $options: 'i' } },
                    { tags: { $in: [new RegExp(search, 'i')] } },
                    { categoryName: { $regex: search, $options: 'i' } },
                ],
            },
        });
    }

    // ─── SORT ─────────────────────────────────────────────────────────────
    let sortStage = {};
    switch (sort) {
        case 'price_asc': sortStage = { price: 1 }; break;
        case 'price_desc': sortStage = { price: -1 }; break;
        case 'newest': sortStage = { createdAt: -1 }; break;
        case 'rating': sortStage = { 'ratings.average': -1, 'ratings.count': -1 }; break;
        case 'popular': sortStage = { orderCount: -1 }; break;
        default: sortStage = lat && lng ? { distanceKm: 1 } : { createdAt: -1 }; // nearest first if location known
    }
    pipeline.push({ $sort: sortStage });

    // ─── PAGINATION (facet for count + data in one query) ─────────────────
    pipeline.push({
        $facet: {
            metadata: [{ $count: 'total' }],
            data: [
                { $skip: skip },
                { $limit: limitNum },
                // Populate vendor
                {
                    $lookup: {
                        from: 'vendors',
                        localField: 'vendorId',
                        foreignField: '_id',
                        as: 'vendor',
                        pipeline: [{ $project: { storeName: 1, storeLogo: 1, ratings: 1, address: 1, isOpen: 1, approved: 1 } }],
                    },
                },
                { $unwind: { path: '$vendor', preserveNullAndEmptyArrays: true } },
                { $match: { 'vendor.isOpen': { $ne: false }, 'vendor.approved': { $ne: false } } },
                // Populate category
                {
                    $lookup: {
                        from: 'categories',
                        localField: 'category',
                        foreignField: '_id',
                        as: 'categoryInfo',
                        pipeline: [{ $project: { name: 1, slug: 1, icon: 1 } }],
                    },
                },
                { $unwind: { path: '$categoryInfo', preserveNullAndEmptyArrays: true } },
                // Add delivery info
                {
                    $addFields: {
                        deliveryInfo: {
                            $cond: {
                                if: { $ifNull: ['$distanceKm', false] },
                                then: '$distanceKm', // Will be processed in JS below
                                else: null,
                            },
                        },
                    },
                },
            ],
        },
    });

    const [result] = await Product.aggregate(pipeline);
    const total = result.metadata[0]?.total || 0;

    // Add delivery info to each product (post-aggregation)
    const products = result.data.map((p) => ({
        ...p,
        deliveryInfo: p.distanceKm !== undefined ? getDeliveryInfo(p.distanceKm) : null,
        discountPercent: p.discountPrice ? Math.round(((p.price - p.discountPrice) / p.price) * 100) : 0,
        effectivePrice: p.discountPrice || p.price,
    }));

    res.json({
        success: true,
        count: products.length,
        total,
        page: pageNum,
        pages: Math.ceil(total / limitNum),
        products,
        meta: {
            radius: radiusNum,
            location: lat && lng ? { lat: parseFloat(lat), lng: parseFloat(lng) } : null,
        },
    });
}));

// GET /api/products/featured
router.get('/featured', asyncHandler(async (req, res) => {
    const { lat, lng, limit = 8 } = req.query;
    const query = { isActive: true, isApproved: true, isFeatured: true, stock: { $gt: 0 } };

    let products;
    if (lat && lng) {
        products = await Product.aggregate([
            {
                $geoNear: {
                    near: { type: 'Point', coordinates: [parseFloat(lng), parseFloat(lat)] },
                    distanceField: 'distance',
                    maxDistance: 100000, // 100km
                    spherical: true,
                    query,
                },
            },
            { $limit: parseInt(limit) },
            { $lookup: { from: 'vendors', localField: 'vendorId', foreignField: '_id', as: 'vendor' } },
            { $unwind: { path: '$vendor', preserveNullAndEmptyArrays: true } },
        ]);
    } else {
        products = await Product.find(query).limit(parseInt(limit)).populate('vendorId', 'storeName storeLogo').lean();
    }

    res.json({
        success: true, products: products.map(p => ({
            ...p,
            deliveryInfo: p.distance ? getDeliveryInfo(p.distance / 1000) : null,
        }))
    });
}));

// GET /api/products/search
router.get('/search', asyncHandler(async (req, res) => {
    const { q, lat, lng, limit = 10 } = req.query;
    if (!q) return res.json({ success: true, products: [] });

    const searchQuery = {
        isActive: true, isApproved: true, stock: { $gt: 0 },
        $or: [
            { title: { $regex: q, $options: 'i' } },
            { tags: { $in: [new RegExp(q, 'i')] } },
            { categoryName: { $regex: q, $options: 'i' } },
        ],
    };

    let products;
    if (lat && lng) {
        products = await Product.aggregate([
            {
                $geoNear: {
                    near: { type: 'Point', coordinates: [parseFloat(lng), parseFloat(lat)] },
                    distanceField: 'distance',
                    maxDistance: 100000,
                    spherical: true,
                    query: { isActive: true, isApproved: true, stock: { $gt: 0 } },
                },
            },
            {
                $match: {
                    $or: [
                        { title: { $regex: q, $options: 'i' } },
                        { tags: { $in: [new RegExp(q, 'i')] } },
                    ],
                },
            },
            { $limit: parseInt(limit) },
        ]);
    } else {
        products = await Product.find(searchQuery).limit(parseInt(limit)).lean();
    }

    res.json({ success: true, products });
}));

// GET /api/products/:id
router.get('/:id', asyncHandler(async (req, res) => {
    const product = await Product.findById(req.params.id)
        .populate('vendorId', 'storeName storeLogo address city ratings storeHours onVacation')
        .populate('category', 'name slug icon')
        .populate('categories', 'name slug icon')
        .lean();

    if (!product || !product.isActive) {
        return res.status(404).json({ success: false, message: 'Product not found' });
    }
    // Hide products from closed stores
    const vendor = product.vendorId;
    if (vendor && vendor.isOpen === false) {
        return res.status(403).json({ success: false, message: 'Store is currently closed' });
    }

    // Increment view count
    await Product.findByIdAndUpdate(req.params.id, { $inc: { viewCount: 1 } });

    res.json({ success: true, product });
}));

// POST /api/products — vendor or admin creates product
router.post('/', protect, authorize('vendor', 'admin'), uploadProduct.fields([
    { name: 'images', maxCount: 10 },
    { name: 'variationImages', maxCount: 30 },
]), asyncHandler(async (req, res) => {
    let vendor;
    if (req.user.role === 'vendor') {
        vendor = await Vendor.findOne({ userId: req.user._id, approved: true });
        if (!vendor) return res.status(403).json({ success: false, message: 'Vendor not approved or not found' });
    } else {
        const vendorId = req.body.vendorId || req.body.vendor;
        if (!vendorId) return res.status(400).json({ success: false, message: 'vendorId is required for admin product creation' });
        vendor = await Vendor.findById(vendorId);
        if (!vendor) return res.status(404).json({ success: false, message: 'Vendor not found' });
    }

    const { title, description, price, discountPrice, category, subCategory, stock, pincode, tags, sku, unit, weight,
        manageStock, allowBackorders, soldIndividually, taxStatus, taxClass, commissionMode, commissionValue, attributes,
        productType, externalUrl, externalButtonText, variations } = req.body;
    const categoriesRaw = req.body.categories;
    const categoryList = Array.isArray(categoriesRaw)
        ? categoriesRaw.filter(Boolean)
        : categoriesRaw
            ? String(categoriesRaw).split(',').map((c) => c.trim()).filter(Boolean)
            : [];

    const variationUploads = req.files?.variationImages || [];
    let images = (req.files?.images || []).map((f) => toUploadUrl(f)).filter(Boolean) || [];
    if (images.length === 0 && variationUploads.length > 0) {
        images = variationUploads.map((f) => toUploadUrl(f)).filter(Boolean);
    }
    if (images.length === 0) {
        const rawImageUrls = req.body.imageUrls;
        if (Array.isArray(rawImageUrls)) {
            images = rawImageUrls.map((u) => String(u).trim()).filter(Boolean);
        } else if (typeof rawImageUrls === 'string') {
            images = rawImageUrls.split(',').map((u) => u.trim()).filter(Boolean);
        }
    }

    if (images.length === 0) {
        return res.status(400).json({ success: false, message: 'Add at least one image (upload file or paste image URL).' });
    }

    const parsedVariations = variations ? (typeof variations === 'string' ? JSON.parse(variations) : variations) : [];
    if (Array.isArray(parsedVariations) && variationUploads.length > 0) {
        variationUploads.forEach((file, idx) => {
            const url = toUploadUrl(file);
            if (parsedVariations[idx]) parsedVariations[idx].image = url;
        });
    }

    const product = await Product.create({
        vendorId: vendor._id,
        title, description, price: parseFloat(price),
        discountPrice: discountPrice ? parseFloat(discountPrice) : undefined,
        images,
        category: categoryList[0] || category,
        categories: categoryList.length ? categoryList : undefined,
        subCategory,
        stock: parseInt(stock),
        location: vendor.location,
        pincode: pincode || vendor.pincode,
        city: vendor.city || vendor.address?.city,
        state: vendor.state || vendor.address?.state,
        tags: tags ? (Array.isArray(tags) ? tags : tags.split(',').map(t => t.trim())) : [],
        sku, unit, weight: weight ? parseFloat(weight) : undefined,
        manageStock: manageStock !== undefined ? manageStock === 'true' || manageStock === true : true,
        allowBackorders: allowBackorders === 'true' || allowBackorders === true,
        soldIndividually: soldIndividually === 'true' || soldIndividually === true,
        taxStatus: taxStatus || 'taxable',
        taxClass: taxClass || 'standard',
        commissionMode: commissionMode || undefined,
        commissionValue: commissionValue ? parseFloat(commissionValue) : undefined,
        attributes: attributes ? (typeof attributes === 'string' ? JSON.parse(attributes) : attributes) : undefined,
        productType: productType || 'simple',
        externalUrl,
        externalButtonText,
        variations: parsedVariations.map(v => ({
            ...v,
            price: v.price ? parseFloat(v.price) : undefined,
            discountPrice: v.discountPrice ? parseFloat(v.discountPrice) : undefined,
            stock: v.stock ? parseInt(v.stock) : 0,
        })),
    });

    await Vendor.findByIdAndUpdate(vendor._id, { $inc: { totalProducts: 1 } });

    res.status(201).json({ success: true, product });
}));

// PUT /api/products/:id — vendor edits product
router.put('/:id', protect, authorize('vendor', 'admin'), uploadProduct.fields([
    { name: 'images', maxCount: 10 },
    { name: 'variationImages', maxCount: 30 },
]), asyncHandler(async (req, res) => {
    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ success: false, message: 'Product not found' });

    if (req.user.role === 'vendor') {
        const vendor = await Vendor.findOne({ userId: req.user._id });
        if (!vendor || product.vendorId.toString() !== vendor._id.toString()) {
            return res.status(403).json({ success: false, message: 'Not authorized to edit this product' });
        }
    }

    const updates = { ...req.body };
    const categoriesRaw = updates.categories;
    if (categoriesRaw !== undefined) {
        const categoryList = Array.isArray(categoriesRaw)
            ? categoriesRaw.filter(Boolean)
            : String(categoriesRaw || '')
                .split(',')
                .map((c) => c.trim())
                .filter(Boolean);
        updates.categories = categoryList;
        if (categoryList.length > 0) updates.category = categoryList[0];
    }
    const variationUploads = req.files?.variationImages || [];
    let targetVendor = null;
    if (req.user.role === 'admin' && updates.vendorId && updates.vendorId.toString() !== product.vendorId.toString()) {
        targetVendor = await Vendor.findById(updates.vendorId);
        if (!targetVendor) return res.status(404).json({ success: false, message: 'New vendor not found' });
        updates.location = targetVendor.location;
        updates.pincode = targetVendor.pincode;
        updates.city = targetVendor.city;
        updates.state = targetVendor.state;
    } else {
        delete updates.vendorId; // vendors cannot reassign product owner
    }
    if (req.files?.images?.length > 0) updates.images = req.files.images.map((f) => toUploadUrl(f)).filter(Boolean);
    else if (variationUploads.length > 0 && !updates.imageUrls) updates.images = variationUploads.map((f) => toUploadUrl(f)).filter(Boolean);
    if (updates.price) updates.price = parseFloat(updates.price);
    if (updates.discountPrice) updates.discountPrice = parseFloat(updates.discountPrice);
    if (updates.stock) updates.stock = parseInt(updates.stock);
    if (updates.weight) updates.weight = parseFloat(updates.weight);
    if (updates.manageStock !== undefined) updates.manageStock = updates.manageStock === 'true' || updates.manageStock === true;
    if (updates.allowBackorders !== undefined) updates.allowBackorders = updates.allowBackorders === 'true' || updates.allowBackorders === true;
    if (updates.soldIndividually !== undefined) updates.soldIndividually = updates.soldIndividually === 'true' || updates.soldIndividually === true;
    if (updates.commissionValue) updates.commissionValue = parseFloat(updates.commissionValue);
    if (updates.attributes && typeof updates.attributes === 'string') updates.attributes = JSON.parse(updates.attributes);
    if (updates.productType) updates.productType = updates.productType;
    if (updates.variations && typeof updates.variations === 'string') updates.variations = JSON.parse(updates.variations);
    if (Array.isArray(updates.variations)) {
        updates.variations = updates.variations.map((v) => ({
            ...v,
            price: v.price ? parseFloat(v.price) : undefined,
            discountPrice: v.discountPrice ? parseFloat(v.discountPrice) : undefined,
            stock: v.stock ? parseInt(v.stock) : 0,
        }));
        if (variationUploads.length > 0) {
            variationUploads.forEach((file, idx) => {
                const url = toUploadUrl(file);
                if (updates.variations[idx]) updates.variations[idx].image = url;
            });
        }
    }

    const updated = await Product.findByIdAndUpdate(req.params.id, updates, { new: true, runValidators: true });
    if (targetVendor) {
        await Vendor.findByIdAndUpdate(product.vendorId, { $inc: { totalProducts: -1 } });
        await Vendor.findByIdAndUpdate(targetVendor._id, { $inc: { totalProducts: 1 } });
    }
    res.json({ success: true, product: updated });
}));

// DELETE /api/products/:id
router.delete('/:id', protect, authorize('vendor', 'admin'), asyncHandler(async (req, res) => {
    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ success: false, message: 'Product not found' });

    if (req.user.role === 'vendor') {
        const vendor = await Vendor.findOne({ userId: req.user._id });
        if (!vendor || product.vendorId.toString() !== vendor._id.toString()) {
            return res.status(403).json({ success: false, message: 'Not authorized' });
        }
    }

    await product.deleteOne();
    await Vendor.findByIdAndUpdate(product.vendorId, { $inc: { totalProducts: -1 } });
    res.json({ success: true, message: 'Product deleted' });
}));

// POST /api/products/bulk-upload — CSV upsert (vendor or admin)
router.post('/bulk-upload', protect, authorize('vendor', 'admin'), uploadCSV.single('csv'), asyncHandler(async (req, res) => {
    if (!req.file) return res.status(400).json({ success: false, message: 'CSV file required' });

    // Determine scope vendor (for vendor role) or accept vendorId from admin/query
    const scopeVendor = req.user.role === 'vendor'
        ? await Vendor.findOne({ userId: req.user._id })
        : (req.body.vendorId || req.query.vendorId ? await Vendor.findById(req.body.vendorId || req.query.vendorId) : null);

    if (req.user.role === 'vendor' && !scopeVendor) {
        return res.status(403).json({ success: false, message: 'Vendor not approved' });
    }

    const mode = (req.query.mode || req.body.mode || 'upsert').toLowerCase(); // create | update | upsert
    const rows = [];
    const errors = [];
    const inserted = [];
    const updated = [];

    const stream = Readable.from(req.file.buffer.toString());
    await new Promise((resolve, reject) => {
        stream.pipe(csv())
            .on('data', (row) => rows.push(row))
            .on('end', resolve)
            .on('error', reject);
    });

    for (const row of rows) {
        try {
            let vendor = scopeVendor;
            if (!vendor) {
                const byId = row.vendorId || row.VendorId || row.vendor_id;
                const byEmail = row.vendorEmail || row.VendorEmail;
                const byName = row.vendor || row.Vendor || row['Vendor Name'];
                if (byId) vendor = await Vendor.findById(byId);
                if (!vendor && byEmail) vendor = await Vendor.findOne({ email: byEmail });
                if (!vendor && byName) vendor = await Vendor.findOne({ storeName: new RegExp(`^${clean(byName)}$`, 'i') });
            }
            if (!vendor) {
                errors.push('Vendor not found for row: ' + JSON.stringify(row));
                continue;
            }

            const mapped = await mapCsvRowToProduct(row, vendor);
            if (mapped.error) {
                errors.push(mapped.error + ' — ' + JSON.stringify(row));
                continue;
            }

            // Identify existing product for update by productId or SKU scoped to vendor
            let existing = null;
            if (mode !== 'create') {
                if (mapped.productId) existing = await Product.findOne({ _id: mapped.productId, vendorId: vendor._id });
                if (!existing && mapped.sku) existing = await Product.findOne({ sku: mapped.sku, vendorId: vendor._id });
            }

            if (existing && mode !== 'create') {
                Object.assign(existing, mapped.payload);
                await existing.save();
                updated.push(existing._id);
            } else if (mode !== 'update') {
                const created = await Product.create(mapped.payload);
                inserted.push(created._id);
                await Vendor.findByIdAndUpdate(vendor._id, { $inc: { totalProducts: 1 } });
            } else {
                errors.push(`Update mode: product not found for SKU/ID in row ${mapped.sku || mapped.productId || '(missing)'}`);
            }
        } catch (e) {
            errors.push(e.message);
        }
    }

    res.json({
        success: true,
        inserted: inserted.length,
        updated: updated.length,
        errors,
        message: `${inserted.length} added, ${updated.length} updated`,
    });
}));

// POST /api/products/:id/wishlist — toggle wishlist
router.post('/:id/wishlist', protect, asyncHandler(async (req, res) => {
    const user = req.user;
    const productId = req.params.id;
    const inWishlist = user.wishlist?.includes(productId);

    const update = inWishlist
        ? { $pull: { wishlist: productId } }
        : { $addToSet: { wishlist: productId } };

    await require('../models/User').findByIdAndUpdate(user._id, update);
    res.json({ success: true, inWishlist: !inWishlist, message: inWishlist ? 'Removed from wishlist' : 'Added to wishlist' });
}));

module.exports = router;
