const express = require('express');
const router = express.Router();
const asyncHandler = require('express-async-handler');
const Product = require('../models/Product');
const Vendor = require('../models/Vendor');
const Category = require('../models/Category');
const TaxClass = require('../models/TaxClass');
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

const coerceNumber = (val) => {
    if (val === null || val === undefined) return undefined;
    const num = Number(val);
    return Number.isNaN(num) ? undefined : num;
};

const coerceBoolean = (val) => {
    if (val === null || val === undefined) return undefined;
    if (typeof val === 'boolean') return val;
    return ['true', '1', 'yes', 'on'].includes(String(val).toLowerCase());
};

const parseStringList = (val, splitPattern = /[,|]/) => {
    if (val === null || val === undefined) return [];
    if (Array.isArray(val)) {
        return val
            .flatMap((item) => String(item).split(splitPattern))
            .map((item) => clean(item))
            .filter(Boolean);
    }
    return String(val)
        .split(splitPattern)
        .map((item) => clean(item))
        .filter(Boolean);
};

const parseIdList = (val) => [...new Set(parseStringList(val, /,/))];

const buildCatalogSearch = (search) => {
    const term = clean(search);
    if (!term) return null;
    return {
        $or: [
            { title: { $regex: term, $options: 'i' } },
            { description: { $regex: term, $options: 'i' } },
            { sku: { $regex: term, $options: 'i' } },
            { categoryName: { $regex: term, $options: 'i' } },
            { tags: { $in: [new RegExp(term, 'i')] } },
        ],
    };
};

const getCanonicalSourceId = (product) => {
    if (!product) return null;
    return String(product.sourceProductId?._id || product.sourceProductId || product._id);
};

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
            { description: { $regex: q, $options: 'i' } },
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
                        { description: { $regex: q, $options: 'i' } },
                        { tags: { $in: [new RegExp(q, 'i')] } },
                        { categoryName: { $regex: q, $options: 'i' } },
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

// GET /api/products/library — reusable catalog for vendor/admin add-to-store flow
router.get('/library', protect, authorize('vendor', 'admin'), asyncHandler(async (req, res) => {
    const { page = 1, limit = 24, search, category, vendorId } = req.query;
    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limitNum = Math.min(Math.max(parseInt(limit, 10) || 24, 1), 100);
    const skip = (pageNum - 1) * limitNum;
    const query = req.user.role === 'admin'
        ? {}
        : { isActive: true, isApproved: true };

    let currentVendor = null;
    if (req.user.role === 'vendor') {
        currentVendor = await Vendor.findOne({ userId: req.user._id, approved: true }).select('_id');
        if (!currentVendor) {
            return res.status(403).json({ success: false, message: 'Vendor not approved or not found' });
        }
        query.vendorId = { $ne: currentVendor._id };
    }

    const searchQuery = buildCatalogSearch(search);
    if (searchQuery) Object.assign(query, searchQuery);
    if (vendorId) {
        if (req.user.role === 'vendor' && String(vendorId) === String(currentVendor?._id)) {
            query.vendorId = null;
        } else {
            query.vendorId = vendorId;
        }
    }
    if (category) {
        query.$and = [
            ...(query.$and || []),
            { $or: [{ category }, { categories: category }] },
        ];
    }

    const total = await Product.countDocuments(query);
    const products = await Product.find(query)
        .populate('vendorId', 'storeName storeLogo city state')
        .populate('category', 'name slug icon')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean();

    let alreadyOwnedSourceIds = new Set();
    if (currentVendor && products.length > 0) {
        const sourceIds = [...new Set(products.map((product) => getCanonicalSourceId(product)))];
        const ownedProducts = await Product.find({
            vendorId: currentVendor._id,
            $or: [
                { _id: { $in: sourceIds } },
                { sourceProductId: { $in: sourceIds } },
            ],
        }).select('_id sourceProductId').lean();
        alreadyOwnedSourceIds = new Set(ownedProducts.map((product) => getCanonicalSourceId(product)));
    }

    res.json({
        success: true,
        products: products.map((product) => {
            const canonicalSourceId = getCanonicalSourceId(product);
            return {
                ...product,
                canonicalSourceId,
                alreadyAdded: alreadyOwnedSourceIds.has(canonicalSourceId),
            };
        }),
        total,
        page: pageNum,
        pages: Math.ceil(total / limitNum),
    });
}));

// GET /api/products/library/:id — fetch source product without mutating stats
router.get('/library/:id', protect, authorize('vendor', 'admin'), asyncHandler(async (req, res) => {
    const product = await Product.findById(req.params.id)
        .populate('vendorId', 'storeName storeLogo city state')
        .populate('category', 'name slug icon')
        .populate('categories', 'name slug icon')
        .lean();

    if (!product) {
        return res.status(404).json({ success: false, message: 'Product not found' });
    }

    if (req.user.role === 'vendor') {
        const vendor = await Vendor.findOne({ userId: req.user._id, approved: true }).select('_id');
        if (!vendor) {
            return res.status(403).json({ success: false, message: 'Vendor not approved or not found' });
        }
        if (String(product.vendorId?._id || product.vendorId) === String(vendor._id)) {
            return res.status(403).json({ success: false, message: 'This product is already in your store' });
        }
        if (!product.isActive || !product.isApproved) {
            return res.status(404).json({ success: false, message: 'Product not found' });
        }
    }

    res.json({
        success: true,
        product: {
            ...product,
            canonicalSourceId: getCanonicalSourceId(product),
        },
    });
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
    let targetVendors = [];
    if (req.user.role === 'vendor') {
        const vendor = await Vendor.findOne({ userId: req.user._id, approved: true });
        if (!vendor) return res.status(403).json({ success: false, message: 'Vendor not approved or not found' });
        targetVendors = [vendor];
    } else {
        const requestedVendorIds = parseIdList(req.body.vendorIds);
        const fallbackVendorId = clean(req.body.vendorId || req.body.vendor);
        const vendorIds = requestedVendorIds.length > 0
            ? requestedVendorIds
            : (fallbackVendorId ? [fallbackVendorId] : []);

        if (vendorIds.length === 0) {
            return res.status(400).json({ success: false, message: 'Select at least one vendor for this product' });
        }

        targetVendors = await Vendor.find({ _id: { $in: vendorIds } });
        if (targetVendors.length !== vendorIds.length) {
            return res.status(404).json({ success: false, message: 'One or more vendors were not found' });
        }
    }

    const { title, description, price, discountPrice, category, subCategory, stock, pincode, tags, sku, unit, weight,
        manageStock, allowBackorders, soldIndividually, taxStatus, taxClass, commissionMode, commissionValue, attributes,
        productType, externalUrl, externalButtonText, variations } = req.body;
    const categoriesRaw = req.body.categories;
    const categoryList = parseIdList(categoriesRaw);
    const sourceProductId = clean(req.body.sourceProductId);
    let sourceProduct = null;

    if (sourceProductId) {
        sourceProduct = await Product.findById(sourceProductId).lean();
        if (!sourceProduct) {
            return res.status(404).json({ success: false, message: 'Source product not found' });
        }
    }

    const canonicalSourceId = sourceProduct ? getCanonicalSourceId(sourceProduct) : null;

    const variationUploads = req.files?.variationImages || [];
    let images = (req.files?.images || []).map((f) => toUploadUrl(f)).filter(Boolean) || [];
    if (images.length === 0 && variationUploads.length > 0) {
        images = variationUploads.map((f) => toUploadUrl(f)).filter(Boolean);
    }
    if (images.length === 0) {
        const rawImageUrls = req.body.imageUrls;
        images = parseStringList(rawImageUrls, /,/);
    }
    if (images.length === 0 && sourceProduct?.images?.length) {
        images = [...sourceProduct.images];
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

    const parsedAttributes = attributes
        ? (typeof attributes === 'string' ? JSON.parse(attributes) : attributes)
        : undefined;
    const parsedTags = parseStringList(tags, /,/);
    const priceValue = coerceNumber(price);
    const discountValue = coerceNumber(discountPrice);
    const stockValue = coerceNumber(stock);
    const weightValue = coerceNumber(weight);
    const commissionValueNum = coerceNumber(commissionValue);
    const normalizedVariations = parsedVariations.map((variation) => ({
        ...variation,
        price: coerceNumber(variation.price),
        discountPrice: coerceNumber(variation.discountPrice),
        stock: coerceNumber(variation.stock) ?? 0,
    }));
    const titleValue = title || sourceProduct?.title;
    const descriptionValue = description || sourceProduct?.description;
    const unitValue = unit || sourceProduct?.unit;
    const productTypeValue = productType || sourceProduct?.productType || 'simple';
    const externalUrlValue = externalUrl || sourceProduct?.externalUrl;
    const externalButtonTextValue = externalButtonText || sourceProduct?.externalButtonText;

    if (!titleValue || !descriptionValue || priceValue === undefined || stockValue === undefined || !(categoryList[0] || category)) {
        return res.status(400).json({ success: false, message: 'Title, description, price, stock, and category are required' });
    }

    const taxClassCode = (taxClass || 'standard').toString().toLowerCase();
    if (!['standard', 'zero'].includes(taxClassCode)) {
        const tax = await TaxClass.findOne({ code: taxClassCode, isActive: true });
        if (!tax) return res.status(400).json({ success: false, message: 'Invalid tax class selected' });
    }

    const duplicateVendors = new Set();
    if (canonicalSourceId) {
        const existingAssignments = await Product.find({
            vendorId: { $in: targetVendors.map((vendor) => vendor._id) },
            $or: [
                { _id: canonicalSourceId },
                { sourceProductId: canonicalSourceId },
            ],
        }).select('vendorId').lean();
        existingAssignments.forEach((product) => duplicateVendors.add(String(product.vendorId)));
    }

    const payloads = targetVendors
        .filter((vendor) => !duplicateVendors.has(String(vendor._id)))
        .map((vendor) => ({
            vendorId: vendor._id,
            sourceProductId: canonicalSourceId || undefined,
            title: titleValue,
            description: descriptionValue,
            price: priceValue,
            discountPrice: discountValue,
            images,
            category: categoryList[0] || category,
            categories: categoryList.length ? categoryList : undefined,
            subCategory,
            stock: stockValue,
            location: vendor.location,
            pincode: pincode || vendor.pincode,
            city: vendor.city || vendor.address?.city,
            state: vendor.state || vendor.address?.state,
            tags: parsedTags,
            sku,
            unit: unitValue,
            weight: weightValue,
            manageStock: manageStock !== undefined ? manageStock === 'true' || manageStock === true : true,
            allowBackorders: allowBackorders === 'true' || allowBackorders === true,
            soldIndividually: soldIndividually === 'true' || soldIndividually === true,
            taxStatus: taxStatus || 'taxable',
            taxClass: taxClassCode,
            commissionMode: commissionMode || undefined,
            commissionValue: commissionValueNum,
            attributes: parsedAttributes,
            productType: productTypeValue,
            externalUrl: externalUrlValue,
            externalButtonText: externalButtonTextValue,
            variations: normalizedVariations,
        }));

    if (payloads.length === 0) {
        return res.status(409).json({
            success: false,
            message: 'This product is already assigned to the selected vendor(s)',
        });
    }

    const createdProducts = await Product.create(payloads);
    const createdList = Array.isArray(createdProducts) ? createdProducts : [createdProducts];

    await Vendor.updateMany(
        { _id: { $in: createdList.map((product) => product.vendorId) } },
        { $inc: { totalProducts: 1 } },
    );

    const skippedVendorIds = targetVendors
        .filter((vendor) => duplicateVendors.has(String(vendor._id)))
        .map((vendor) => String(vendor._id));
    const skippedVendors = targetVendors
        .filter((vendor) => duplicateVendors.has(String(vendor._id)))
        .map((vendor) => ({ _id: vendor._id, storeName: vendor.storeName }));
    const assignedVendors = targetVendors
        .filter((vendor) => !duplicateVendors.has(String(vendor._id)))
        .map((vendor) => ({ _id: vendor._id, storeName: vendor.storeName }));

    res.status(201).json({
        success: true,
        product: createdList.length === 1 ? createdList[0] : undefined,
        products: createdList,
        createdCount: createdList.length,
        skippedVendorIds,
        skippedVendors,
        assignedVendors,
        message: skippedVendorIds.length > 0
            ? `${createdList.length} product(s) added. ${skippedVendorIds.length} vendor(s) already had this product.`
            : `${createdList.length} product(s) added successfully.`,
    });
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
    if (updates.taxClass) {
        updates.taxClass = String(updates.taxClass).trim().toLowerCase();
        if (!['standard', 'zero'].includes(updates.taxClass)) {
            const tax = await TaxClass.findOne({ code: updates.taxClass, isActive: true });
            if (!tax) return res.status(400).json({ success: false, message: 'Invalid tax class selected' });
        }
    }
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
    // Images: prefer uploaded files, else URLs (string or array)
    if (req.files?.images?.length > 0) {
        updates.images = req.files.images.map((f) => toUploadUrl(f)).filter(Boolean);
    } else if (variationUploads.length > 0 && !updates.imageUrls) {
        updates.images = variationUploads.map((f) => toUploadUrl(f)).filter(Boolean);
    } else if (updates.imageUrls) {
        const raw = updates.imageUrls;
        const urlList = Array.isArray(raw)
            ? raw.map((u) => String(u).trim()).filter(Boolean)
            : String(raw)
                .split(',')
                .map((u) => u.trim())
                .filter(Boolean);
        if (urlList.length > 0) updates.images = urlList;
    }
    delete updates.imageUrls;

    // Numeric + boolean coercions (allow zero/false)
    const priceNum = coerceNumber(updates.price);
    if (priceNum !== undefined) updates.price = priceNum;
    const discountNum = coerceNumber(updates.discountPrice);
    if (discountNum !== undefined) updates.discountPrice = discountNum;
    const stockNum = coerceNumber(updates.stock);
    if (stockNum !== undefined) updates.stock = stockNum;
    const weightNum = coerceNumber(updates.weight);
    if (weightNum !== undefined) updates.weight = weightNum;
    const commissionNum = coerceNumber(updates.commissionValue);
    if (commissionNum !== undefined) updates.commissionValue = commissionNum;

    const manageStockBool = coerceBoolean(updates.manageStock);
    if (manageStockBool !== undefined) updates.manageStock = manageStockBool;
    const allowBackordersBool = coerceBoolean(updates.allowBackorders);
    if (allowBackordersBool !== undefined) updates.allowBackorders = allowBackordersBool;
    const soldIndividuallyBool = coerceBoolean(updates.soldIndividually);
    if (soldIndividuallyBool !== undefined) updates.soldIndividually = soldIndividuallyBool;

    if (updates.attributes && typeof updates.attributes === 'string') updates.attributes = JSON.parse(updates.attributes);
    if (updates.productType) updates.productType = updates.productType;
    if (updates.variations && typeof updates.variations === 'string') updates.variations = JSON.parse(updates.variations);
    if (Array.isArray(updates.variations)) {
        updates.variations = updates.variations.map((v) => ({
            ...v,
            price: coerceNumber(v.price),
            discountPrice: coerceNumber(v.discountPrice),
            stock: coerceNumber(v.stock) ?? 0,
        }));
        if (variationUploads.length > 0) {
            variationUploads.forEach((file, idx) => {
                const url = toUploadUrl(file);
                if (updates.variations[idx]) updates.variations[idx].image = url;
            });
        }
    }

    // Business validation: discount must be below price (use existing price if not provided)
    const effectivePrice = updates.price !== undefined ? updates.price : product.price;
    const effectiveDiscount = updates.discountPrice !== undefined ? updates.discountPrice : product.discountPrice;
    if (effectiveDiscount !== undefined && effectivePrice !== undefined && effectiveDiscount >= effectivePrice) {
        return res.status(400).json({
            success: false,
            message: 'Discount price must be less than original price',
        });
    }

    const updated = await Product.findByIdAndUpdate(
        req.params.id,
        updates,
        { new: true, runValidators: true, context: 'query' },
    );
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
