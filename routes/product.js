const express = require('express');
const router = express.Router();
const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const Product = require('../models/Product');
const Vendor = require('../models/Vendor');
const Category = require('../models/Category');
const TaxClass = require('../models/TaxClass');
const User = require('../models/User');
const { protect, authorize } = require('../middleware/auth');
const { parseProductImageUpload } = require('../middleware/productUpload');
const { haversineDistance } = require('../utils/haversine');
const { getDeliveryInfo } = require('../utils/deliveryETA');
const { buildCacheKey, clearCacheByPrefix, deleteCacheKey, getCacheEntry, setCacheEntry } = require('../utils/cache');
const { createSignedUploadSignature, uploadCSV } = require('../config/cloudinary');
const {
    MAX_PRODUCT_IMAGE_COUNT,
    assignVariationImageAssets,
    buildProductImageFolder,
    buildVariableProductGallery,
    cloneVariation,
    collectImageAssetsToDelete,
    collectProductImageAssets,
    deleteImageAssetBatch,
    orderProductAssets,
    resolveSubmittedAssetsFromUrls,
    uploadProductFileBatch,
} = require('../utils/productImages');
const csv = require('csv-parser');
const { Readable } = require('stream');

const PRODUCT_CACHE_PREFIX = 'products';
const PRODUCT_LIST_CACHE_PREFIX = PRODUCT_CACHE_PREFIX;
const PRODUCT_CACHE_TTL_SECONDS = Number(process.env.REDIS_CACHE_TTL_SECONDS) || 60;
const MAX_PUBLIC_PRODUCTS_LIMIT = Number(process.env.MAX_PUBLIC_PRODUCTS_LIMIT) || 40;
const EARTH_RADIUS_KM = 6371;
const PRODUCT_LIST_SELECT = [
    '_id',
    'title',
    'slug',
    'images',
    'price',
    'discountPrice',
    'stock',
    'city',
    'state',
    'pincode',
    'ratings',
    'isFeatured',
    'vendorId',
    'category',
    'categories',
    'subCategory',
    'categoryName',
    'tags',
    'attributes',
    'location',
    'createdAt',
    'orderCount',
].join(' ');
const PRODUCT_LIST_VENDOR_SELECT = '_id storeName storeLogo ratings address location isOpen approved';
const PRODUCT_LIST_CATEGORY_SELECT = '_id name slug icon';
const PRODUCT_SEARCH_SELECT = `${PRODUCT_LIST_SELECT} description shortDescription tags sku attributes variations`;

const clean = (val) => (val ?? '').toString().trim();
const normalizeNumber = (val) => {
    const cleaned = clean(val).replace(/[^0-9.\-]/g, '');
    return cleaned ? parseFloat(cleaned) : NaN;
};
const isAllCategorySlug = (value) => clean(value).toLowerCase() === 'all';

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

const slugifyProductTitle = (value) => {
    const base = clean(value)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '');
    return base || 'product';
};

const generateUniqueProductSlug = async (title, { reservedSlugs = new Set(), suffixSeed = '' } = {}) => {
    const base = slugifyProductTitle(title);

    for (let attempt = 0; attempt < 6; attempt += 1) {
        const suffix = [
            suffixSeed,
            Date.now().toString(36),
            new mongoose.Types.ObjectId().toString().slice(-6),
        ].filter(Boolean).join('-');
        const candidate = `${base}-${suffix}`.replace(/-+/g, '-');
        if (reservedSlugs.has(candidate)) continue;

        // eslint-disable-next-line no-await-in-loop
        const exists = await Product.exists({ slug: candidate });
        if (!exists) {
            reservedSlugs.add(candidate);
            return candidate;
        }
    }

    const fallback = `${base}-${new mongoose.Types.ObjectId().toString()}`;
    reservedSlugs.add(fallback);
    return fallback;
};

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

// Map a category ObjectId to its name (simple cache to avoid repeated queries)
const categoryNameCache = new Map();
const resolveCategoryName = async (categoryId) => {
    if (!categoryId) return undefined;
    const key = String(categoryId);
    if (categoryNameCache.has(key)) return categoryNameCache.get(key);
    const query = typeof Category.findById === 'function'
        ? Category.findById(categoryId)
        : (typeof Category.findOne === 'function' ? Category.findOne({ _id: categoryId }) : null);
    if (!query) return undefined;

    const selected = typeof query.select === 'function' ? query.select('name') : query;
    const doc = typeof selected?.lean === 'function' ? await selected.lean() : await selected;
    const name = doc?.name;
    if (name) categoryNameCache.set(key, name);
    return name;
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
const parseJsonArray = (value) => {
    if (value === null || value === undefined || value === '') return [];
    if (Array.isArray(value)) return value;
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
};
const applyPrimaryVariationSelection = (variations = []) => {
    let primaryAssigned = false;
    const normalized = variations.map((variation) => {
        const requestedPrimary = coerceBoolean(variation?.isPrimaryImage) === true;
        const hasImage = Boolean(variation?.image);
        const isPrimaryImage = requestedPrimary && hasImage && !primaryAssigned;
        if (isPrimaryImage) primaryAssigned = true;
        return {
            ...variation,
            isPrimaryImage,
        };
    });
    if (primaryAssigned) return normalized;

    const fallbackIndex = normalized.findIndex((variation) => Boolean(variation?.image));
    if (fallbackIndex === -1) return normalized;

    return normalized.map((variation, index) => ({
        ...variation,
        isPrimaryImage: index === fallbackIndex,
    }));
};

const buildProductMediaState = async ({
    vendorId,
    productType,
    galleryFiles = [],
    galleryUrls = [],
    imageOrder = [],
    baseImageAssets = [],
    variations = [],
    variationFiles = [],
    variationImageIndexes = [],
    existingVariationAssets = [],
    context = {},
}) => {
    if (productType !== 'variable' && galleryFiles.length + galleryUrls.length > MAX_PRODUCT_IMAGE_COUNT) {
        throw new Error(`You can upload up to ${MAX_PRODUCT_IMAGE_COUNT} product gallery images.`);
    }

    const galleryUploadedAssets = productType === 'variable'
        ? []
        : await uploadProductFileBatch({
            files: galleryFiles,
            vendorId,
            publicIdPrefix: 'gallery',
            context,
        });

    const variationUploadedAssets = variationFiles.length > 0
        ? await uploadProductFileBatch({
            files: variationFiles,
            vendorId,
            publicIdPrefix: 'variation',
            context,
        })
        : [];

    const nextVariations = assignVariationImageAssets({
        variations,
        uploadedAssets: variationUploadedAssets,
        variationImageIndexes,
        existingVariationAssets,
    });

    const imageAssets = productType === 'variable'
        ? buildVariableProductGallery(nextVariations)
        : orderProductAssets({
            uploadedAssets: galleryUploadedAssets,
            existingAssets: resolveSubmittedAssetsFromUrls(galleryUrls, baseImageAssets),
            imageOrder,
        });

    return {
        imageAssets,
        images: imageAssets.map((asset) => asset.url),
        variations: nextVariations,
        uploadedAssets: [...galleryUploadedAssets, ...variationUploadedAssets],
    };
};

const normalizeVariationPayloads = (variations = []) => applyPrimaryVariationSelection(
    (Array.isArray(variations) ? variations : []).map((variation) => ({
        ...cloneVariation(variation),
        price: coerceNumber(variation.price),
        discountPrice: coerceNumber(variation.discountPrice),
        stock: coerceNumber(variation.stock) ?? 0,
        isPrimaryImage: coerceBoolean(variation.isPrimaryImage) === true,
    })),
);

const resolveTargetVendors = async ({ user, body }) => {
    if (user.role === 'vendor') {
        const vendor = await Vendor.findOne({ userId: user._id, approved: true });
        if (!vendor) {
            throw createHttpError(403, 'Vendor not approved or not found');
        }
        return [vendor];
    }

    const requestedVendorIds = parseIdList(body.vendorIds);
    const fallbackVendorId = clean(body.vendorId || body.vendor);
    const vendorIds = requestedVendorIds.length > 0
        ? requestedVendorIds
        : (fallbackVendorId ? [fallbackVendorId] : []);

    if (vendorIds.length === 0) {
        throw createHttpError(400, 'Select at least one vendor for this product');
    }

    const vendors = await Vendor.find({ _id: { $in: vendorIds } });
    if (vendors.length !== vendorIds.length) {
        throw createHttpError(404, 'One or more vendors were not found');
    }

    return vendors;
};

const normalizeProductImages = (product) => {
    const imageAssets = collectProductImageAssets({
        imageAssets: product?.imageAssets,
        images: product?.images,
        variations: [],
    }).slice(0, MAX_PRODUCT_IMAGE_COUNT);

    return {
        imageAssets,
        images: imageAssets.map((asset) => asset.url),
    };
};

const createHttpError = (statusCode, message) => {
    const error = new Error(message);
    error.statusCode = statusCode;
    return error;
};

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const SEARCH_PHRASE_REPLACEMENTS = [
    [/t[\s-]*shirts?/g, 'tshirt'],
    [/tee[\s-]*shirts?/g, 'tshirt'],
    [/smart[\s-]*phones?/g, 'mobile'],
    [/cell[\s-]*phones?/g, 'mobile'],
    [/mens/g, 'men'],
    [/women'?s/g, 'women'],
];
const TOKEN_SYNONYMS = {
    men: ['men', 'man', 'male', 'boy', 'boys', 'mens'],
    women: ['women', 'woman', 'female', 'girl', 'girls', 'ladies', 'lady', 'womens'],
    tshirt: ['tshirt', 'tshirts', 't-shirt', 'tee', 'tees', 'teeshirt', 'teshit', 'teshirt', 'tshrit'],
    shirt: ['shirt', 'shirts', 'formalshirt', 'casualshirt'],
    mobile: ['mobile', 'mobiles', 'phone', 'phones', 'smartphone', 'smartphones', 'cellphone', 'cellphones'],
    laptop: ['laptop', 'laptops', 'notebook', 'notebooks'],
    earbud: ['earbud', 'earbuds', 'earphone', 'earphones', 'headphone', 'headphones'],
    shoe: ['shoe', 'shoes', 'sneaker', 'sneakers', 'footwear'],
    watch: ['watch', 'watches', 'smartwatch', 'smartwatches'],
};
const SEARCH_FIELD_BOOSTS = {
    title: 140,
    categoryName: 95,
    tags: 90,
    sku: 70,
    shortDescription: 45,
    description: 30,
    attributes: 55,
    variations: 45,
};
const SEARCH_STOP_WORDS = new Set(['for', 'and', 'the', 'with', 'near', 'you', 'from']);
const parsePositiveInt = (value, fallback, max = Number.MAX_SAFE_INTEGER) => {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return Math.min(parsed, max);
};
const parseObjectId = (value) => (mongoose.Types.ObjectId.isValid(value)
    ? mongoose.Types.ObjectId.createFromHexString(String(value))
    : null);
const normalizeCacheQuery = (query) => Object.entries(query)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .reduce((acc, [key, value]) => {
        acc[key] = Array.isArray(value) ? value.join(',') : value;
        return acc;
    }, {});
const getProductSort = (sort, hasLocation) => {
    switch (sort) {
        case 'price_asc': return { price: 1, _id: 1 };
        case 'price_desc': return { price: -1, _id: 1 };
        case 'newest': return { createdAt: -1, _id: -1 };
        case 'rating': return { 'ratings.average': -1, 'ratings.count': -1, _id: -1 };
        case 'popular': return { orderCount: -1, _id: -1 };
        default: return hasLocation ? null : { createdAt: -1, _id: -1 };
    }
};
const invalidateProductCache = async (productIds = []) => {
    await clearCacheByPrefix(PRODUCT_LIST_CACHE_PREFIX);

    const ids = [...new Set((Array.isArray(productIds) ? productIds : [productIds])
        .filter(Boolean)
        .map((productId) => String(productId)))];

    await Promise.all(ids.map((productId) => deleteCacheKey(`product:${productId}`)));
};

const loadCategoryFilterIds = async (category) => {
    const normalizedCategory = clean(category);
    if (!normalizedCategory || isAllCategorySlug(normalizedCategory)) return [];

    if (mongoose.Types.ObjectId.isValid(normalizedCategory)) {
        const categoryId = mongoose.Types.ObjectId.createFromHexString(String(normalizedCategory));
        const children = await Category.find({ parent: categoryId }).select('_id').lean();
        return [categoryId, ...children.map((child) => child._id)];
    }

    const currentCategory = await Category.findOne({ slug: normalizedCategory.toLowerCase() }).select('_id').lean();
    if (!currentCategory) return [];

    const children = await Category.find({ parent: currentCategory._id }).select('_id').lean();
    return [currentCategory._id, ...children.map((child) => child._id)];
};

const buildPublicProductsFilter = async (query) => {
    const {
        category,
        subCategory,
        minPrice,
        maxPrice,
        search,
        pincode,
        vendorId,
        featured,
        minRating,
    } = query;

    const filter = {
        isActive: true,
        isApproved: true,
        stock: { $gt: 0 },
    };

    if (category && !isAllCategorySlug(category)) {
        const categoryIds = await loadCategoryFilterIds(category);
        if (categoryIds.length > 0) {
            filter.$or = [
                { category: { $in: categoryIds } },
                { categories: { $in: categoryIds } },
            ];
        }
    }

    if (subCategory) {
        const subCategoryId = parseObjectId(subCategory);
        if (subCategoryId) filter.subCategory = subCategoryId;
    }

    if (vendorId) {
        const vendorObjectId = parseObjectId(vendorId);
        if (vendorObjectId) filter.vendorId = vendorObjectId;
    }

    if (pincode) filter.pincode = clean(pincode);
    if (featured === 'true') filter.isFeatured = true;

    if (minPrice || maxPrice) {
        filter.price = {};
        if (minPrice) filter.price.$gte = parseFloat(minPrice);
        if (maxPrice) filter.price.$lte = parseFloat(maxPrice);
    }

    if (minRating) filter['ratings.average'] = { $gte: parseFloat(minRating) };

    if (search) {
        const searchQuery = buildSearchQuery(search);
        if (searchQuery) {
            filter.$and = [
                ...(filter.$and || []),
                searchQuery,
            ];
        }
    }

    return filter;
};

const buildProductsListResponse = async ({
    products,
    total,
    pageNum,
    limitNum,
    radiusNum,
    customerLat,
    customerLng,
}) => {
    const vendorIds = [...new Set(products.map((product) => String(product.vendorId || '')).filter(Boolean))];
    const categoryIds = [...new Set(products.map((product) => String(product.category || '')).filter(Boolean))];

    const [vendors, categories] = await Promise.all([
        vendorIds.length > 0
            ? Vendor.find({ _id: { $in: vendorIds } }).select(PRODUCT_LIST_VENDOR_SELECT).lean()
            : Promise.resolve([]),
        categoryIds.length > 0
            ? Category.find({ _id: { $in: categoryIds } }).select(PRODUCT_LIST_CATEGORY_SELECT).lean()
            : Promise.resolve([]),
    ]);

    const vendorMap = new Map(
        vendors
            .filter((vendor) => vendor.approved !== false && vendor.isOpen !== false)
            .map((vendor) => [String(vendor._id), vendor]),
    );
    const categoryMap = new Map(categories.map((category) => [String(category._id), category]));

    const shapedProducts = products
        .map((product) => {
            const vendor = vendorMap.get(String(product.vendorId || ''));
            if (!vendor) return null;

            const coordinates = vendor.location?.coordinates?.length === 2
                ? vendor.location.coordinates
                : (product.location?.coordinates || []);
            const distanceKm = Number.isFinite(customerLat) && Number.isFinite(customerLng) && coordinates.length === 2
                ? haversineDistance(customerLat, customerLng, coordinates[1], coordinates[0])
                : undefined;

            return {
                _id: product._id,
                title: product.title,
                slug: product.slug,
                images: Array.isArray(product.images) ? product.images.slice(0, 1) : [],
                price: product.price,
                discountPrice: product.discountPrice,
                effectivePrice: product.discountPrice || product.price,
                discountPercent: product.discountPrice
                    ? Math.round(((product.price - product.discountPrice) / product.price) * 100)
                    : 0,
                stock: product.stock,
                city: product.city,
                state: product.state,
                pincode: product.pincode,
                ratings: product.ratings,
                isFeatured: product.isFeatured,
                vendorId: product.vendorId,
                vendor,
                category: product.category,
                categories: product.categories,
                subCategory: product.subCategory,
                categoryName: product.categoryName,
                categoryInfo: categoryMap.get(String(product.category || '')) || null,
                tags: Array.isArray(product.tags) ? product.tags : [],
                attributes: Array.isArray(product.attributes) ? product.attributes : [],
                distanceKm,
                deliveryInfo: Number.isFinite(distanceKm) ? getDeliveryInfo(distanceKm) : null,
                createdAt: product.createdAt,
                orderCount: product.orderCount,
            };
        })
        .filter(Boolean);

    return {
        success: true,
        count: shapedProducts.length,
        total,
        page: pageNum,
        pages: Math.ceil(total / limitNum),
        products: shapedProducts,
        meta: {
            radius: radiusNum,
            location: Number.isFinite(customerLat) && Number.isFinite(customerLng)
                ? { lat: customerLat, lng: customerLng }
                : null,
        },
    };
};

const buildCatalogSearch = (search) => {
    return buildSearchQuery(search);
};

const normalizeSearchInput = (value) => {
    let normalized = clean(value).toLowerCase();
    if (!normalized) return '';
    normalized = normalized.replace(/[^a-z0-9\s-]/g, ' ');
    SEARCH_PHRASE_REPLACEMENTS.forEach(([pattern, replacement]) => {
        normalized = normalized.replace(pattern, replacement);
    });
    return normalized.replace(/\s+/g, ' ').trim();
};

const singularizeToken = (token) => {
    if (token.length <= 3) return token;
    if (token.endsWith('ies') && token.length > 4) return `${token.slice(0, -3)}y`;
    if (token.endsWith('es') && token.length > 4) return token.slice(0, -2);
    if (token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1);
    return token;
};

const getTokenVariants = (token) => {
    const base = singularizeToken(clean(token).toLowerCase());
    if (!base || SEARCH_STOP_WORDS.has(base)) return [];

    const variants = new Set([base]);
    Object.entries(TOKEN_SYNONYMS).forEach(([canonical, values]) => {
        if (canonical === base || values.includes(base)) {
            variants.add(canonical);
            values.forEach((value) => variants.add(value));
        }
    });

    return [...variants]
        .map((value) => clean(value).toLowerCase())
        .filter(Boolean);
};

const createSearchRegex = (term) => new RegExp(escapeRegex(term).replace(/\s+/g, '\\s+'), 'i');

const buildSearchMetadata = (search) => {
    const normalized = normalizeSearchInput(search).slice(0, 80);
    if (!normalized) return null;

    const phraseRegex = createSearchRegex(normalized);
    const tokenGroups = normalized
        .split(' ')
        .map(getTokenVariants)
        .filter((group) => group.length > 0)
        .map((group) => [...new Set(group)].slice(0, 6))
        .slice(0, 6);

    if (tokenGroups.length === 0) {
        return { normalized, phraseRegex, tokenGroups: [[normalized]] };
    }

    return { normalized, phraseRegex, tokenGroups };
};

const buildSearchFieldMatch = (variants) => {
    const regexes = [...new Set(variants)].map(createSearchRegex);
    return {
        $or: [
            ...regexes.map((regex) => ({ title: regex })),
            ...regexes.map((regex) => ({ categoryName: regex })),
            ...regexes.map((regex) => ({ tags: regex })),
            ...regexes.map((regex) => ({ sku: regex })),
            ...regexes.map((regex) => ({ shortDescription: regex })),
            ...regexes.map((regex) => ({ description: regex })),
            ...regexes.map((regex) => ({ 'attributes.key': regex })),
            ...regexes.map((regex) => ({ 'attributes.value': regex })),
            ...regexes.map((regex) => ({ 'variations.title': regex })),
            ...regexes.map((regex) => ({ 'variations.sku': regex })),
        ],
    };
};

const buildSearchQuery = (search) => {
    const meta = buildSearchMetadata(search);
    if (!meta) return null;

    const tokenClauses = meta.tokenGroups.map((group) => buildSearchFieldMatch(group));
    return {
        $and: [
            ...tokenClauses,
            {
                $or: [
                    { title: meta.phraseRegex },
                    { categoryName: meta.phraseRegex },
                    { tags: meta.phraseRegex },
                    { shortDescription: meta.phraseRegex },
                    { description: meta.phraseRegex },
                    { 'attributes.value': meta.phraseRegex },
                    { 'variations.title': meta.phraseRegex },
                    { sku: meta.phraseRegex },
                    ...tokenClauses,
                ],
            },
        ],
    };
};

const normalizeHaystack = (value) => normalizeSearchInput(Array.isArray(value) ? value.join(' ') : value);

const scoreMatchText = (text, variants, baseBoost) => {
    const haystack = normalizeHaystack(text);
    if (!haystack) return 0;

    let score = 0;
    variants.forEach((variant) => {
        const normalizedVariant = normalizeSearchInput(variant);
        if (!normalizedVariant) return;
        if (haystack === normalizedVariant) score = Math.max(score, baseBoost + 70);
        else if (haystack.startsWith(normalizedVariant)) score = Math.max(score, baseBoost + 35);
        else if (haystack.includes(normalizedVariant)) score = Math.max(score, baseBoost);
    });
    return score;
};

const scoreProductSearchMatch = (product, meta) => {
    if (!product || !meta) return 0;

    const phrase = meta.normalized;
    const title = normalizeHaystack(product.title);
    const categoryName = normalizeHaystack(product.categoryName);
    const tags = Array.isArray(product.tags) ? product.tags : [];
    const attributes = Array.isArray(product.attributes)
        ? product.attributes.flatMap((attribute) => [attribute?.key, attribute?.value])
        : [];
    const variations = Array.isArray(product.variations)
        ? product.variations.flatMap((variation) => [variation?.title, variation?.sku])
        : [];

    let totalScore = 0;
    if (title === phrase) totalScore += 260;
    else if (title.includes(phrase)) totalScore += 180;
    if (categoryName && categoryName.includes(phrase)) totalScore += 120;
    if (normalizeHaystack(tags).includes(phrase)) totalScore += 110;

    meta.tokenGroups.forEach((variants) => {
        totalScore += scoreMatchText(product.title, variants, SEARCH_FIELD_BOOSTS.title);
        totalScore += scoreMatchText(product.categoryName, variants, SEARCH_FIELD_BOOSTS.categoryName);
        totalScore += scoreMatchText(product.tags, variants, SEARCH_FIELD_BOOSTS.tags);
        totalScore += scoreMatchText(product.sku, variants, SEARCH_FIELD_BOOSTS.sku);
        totalScore += scoreMatchText(product.shortDescription, variants, SEARCH_FIELD_BOOSTS.shortDescription);
        totalScore += scoreMatchText(product.description, variants, SEARCH_FIELD_BOOSTS.description);
        totalScore += scoreMatchText(attributes, variants, SEARCH_FIELD_BOOSTS.attributes);
        totalScore += scoreMatchText(variations, variants, SEARCH_FIELD_BOOSTS.variations);
    });

    return totalScore;
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

    const pageNum = parsePositiveInt(page, 1);
    const limitNum = parsePositiveInt(limit, 20, MAX_PUBLIC_PRODUCTS_LIMIT);
    const skip = (pageNum - 1) * limitNum;
    const radiusNum = Math.min(parsePositiveInt(radius, 100, 500), 500);
    const customerLat = Number.parseFloat(lat);
    const customerLng = Number.parseFloat(lng);
    const hasLocation = Number.isFinite(customerLat) && Number.isFinite(customerLng);
    const cacheKey = buildCacheKey(PRODUCT_LIST_CACHE_PREFIX, normalizeCacheQuery({
        lat,
        lng,
        radius: radiusNum,
        category,
        subCategory,
        minPrice,
        maxPrice,
        sort,
        page: pageNum,
        limit: limitNum,
        search,
        pincode,
        vendorId,
        featured,
        minRating,
    }));

    const cachedResponse = await getCacheEntry(cacheKey);
    if (cachedResponse) {
        console.log(`⚡ Cache HIT ${cacheKey}`);
        res.set('X-Cache', 'HIT');
        return res.json(cachedResponse);
    }

    console.log(`❌ Cache MISS (DB hit) ${cacheKey}`);

    const baseFilter = await buildPublicProductsFilter(req.query);
    const countFilter = { ...baseFilter };
    const listFilter = { ...baseFilter };

    if (hasLocation) {
        const center = [customerLng, customerLat];
        const geoWithin = {
            $geoWithin: {
                $centerSphere: [center, radiusNum / EARTH_RADIUS_KM],
            },
        };

        countFilter.location = geoWithin;

        if (sort === 'nearest') {
            listFilter.location = {
                $nearSphere: {
                    $geometry: { type: 'Point', coordinates: center },
                    $maxDistance: radiusNum * 1000,
                },
            };
        } else {
            listFilter.location = geoWithin;
        }
    }

    const sortStage = getProductSort(sort, hasLocation);
    const listQuery = Product.find(listFilter)
        .select(PRODUCT_LIST_SELECT)
        .skip(skip)
        .limit(limitNum)
        .lean();

    if (sortStage) listQuery.sort(sortStage);

    const [products, total] = await Promise.all([
        listQuery,
        Product.countDocuments(countFilter),
    ]);

    const responseBody = await buildProductsListResponse({
        products,
        total,
        pageNum,
        limitNum,
        radiusNum,
        customerLat,
        customerLng,
    });

    await setCacheEntry(cacheKey, responseBody, PRODUCT_CACHE_TTL_SECONDS);
    res.set('X-Cache', 'MISS');
    res.json(responseBody);
}));

// GET /api/products/featured
router.get('/featured', asyncHandler(async (req, res) => {
    const { lat, lng, limit = 8 } = req.query;
    const limitNum = parsePositiveInt(limit, 8, 24);
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
            { $limit: limitNum },
            { $lookup: { from: 'vendors', localField: 'vendorId', foreignField: '_id', as: 'vendor' } },
            { $unwind: { path: '$vendor', preserveNullAndEmptyArrays: true } },
        ]);
    } else {
        products = await Product.find(query)
            .limit(limitNum)
            .populate('vendorId', 'storeName storeLogo')
            .lean();
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
    const limitNum = parsePositiveInt(limit, 10, 50);
    const searchMeta = buildSearchMetadata(q);
    if (!searchMeta) return res.json({ success: true, products: [] });
    const searchFilter = buildSearchQuery(q);
    const baseQuery = { isActive: true, isApproved: true, stock: { $gt: 0 } };

    let products;
    if (lat && lng) {
        products = await Product.aggregate([
            {
                $geoNear: {
                    near: { type: 'Point', coordinates: [parseFloat(lng), parseFloat(lat)] },
                    distanceField: 'distance',
                    maxDistance: 100000,
                    spherical: true,
                    query: baseQuery,
                },
            },
            { $match: searchFilter },
            { $limit: Math.min(limitNum * 8, 120) },
        ]);
    } else {
        products = await Product.find({ ...baseQuery, ...searchFilter })
            .select(PRODUCT_SEARCH_SELECT)
            .sort({ createdAt: -1, _id: -1 })
            .limit(Math.min(limitNum * 8, 120))
            .lean();
    }

    const rankedProducts = products
        .map((product) => ({
            ...product,
            _searchScore: scoreProductSearchMatch(product, searchMeta),
        }))
        .filter((product) => product._searchScore > 0)
        .sort((a, b) => {
            if (b._searchScore !== a._searchScore) return b._searchScore - a._searchScore;
            if (Number.isFinite(a.distance) && Number.isFinite(b.distance) && a.distance !== b.distance) {
                return a.distance - b.distance;
            }
            return new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime();
        })
        .slice(0, limitNum)
        .map(({ _searchScore, ...product }) => product);

    res.json({ success: true, products: rankedProducts });
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

// POST /api/products/uploads/signature — future direct signed Cloudinary uploads
router.post('/uploads/signature', protect, authorize('vendor', 'admin'), asyncHandler(async (req, res) => {
    let targetVendor = null;

    if (req.user.role === 'vendor') {
        targetVendor = await Vendor.findOne({ userId: req.user._id, approved: true }).select('_id');
        if (!targetVendor) {
            return res.status(403).json({ success: false, message: 'Vendor not approved or not found' });
        }
    } else {
        const vendorId = clean(req.body.vendorId || req.body.vendor);
        if (!vendorId) {
            return res.status(400).json({ success: false, message: 'vendorId is required for signed uploads' });
        }
        targetVendor = await Vendor.findById(vendorId).select('_id');
        if (!targetVendor) {
            return res.status(404).json({ success: false, message: 'Vendor not found' });
        }
    }

    const folder = buildProductImageFolder(targetVendor._id);
    const timestamp = Math.floor(Date.now() / 1000);
    const transformation = 'c_limit,h_1600,q_auto:good,w_1600';
    let signaturePayload = null;
    try {
        signaturePayload = createSignedUploadSignature({
            folder,
            timestamp,
            transformation,
        });
    } catch (error) {
        return res.status(503).json({ success: false, message: error.message });
    }

    res.json({
        success: true,
        upload: {
            ...signaturePayload,
            folder,
            transformation,
            maxFileSizeBytes: 2 * 1024 * 1024,
            allowedFormats: ['jpg', 'jpeg', 'png', 'webp'],
        },
    });
}));

// GET /api/products/:id
router.get('/:id', asyncHandler(async (req, res) => {
    const cacheKey = `product:${req.params.id}`;
    const cachedProduct = await getCacheEntry(cacheKey);
    if (cachedProduct) {
        console.log(`⚡ Cache HIT ${cacheKey}`);
        res.set('X-Cache', 'HIT');
        Product.findByIdAndUpdate(req.params.id, { $inc: { viewCount: 1 } }).catch(() => {});
        return res.json(cachedProduct);
    }

    console.log(`❌ Cache MISS (DB hit) ${cacheKey}`);

    const product = await Product.findById(req.params.id)
        .populate('vendorId', 'storeName storeLogo address city ratings storeHours onVacation location isOpen')
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

    // View count should not slow down the primary read path.
    Product.findByIdAndUpdate(req.params.id, { $inc: { viewCount: 1 } }).catch(() => {});

    const responseBody = { success: true, product };
    await setCacheEntry(cacheKey, responseBody, PRODUCT_CACHE_TTL_SECONDS);

    res.set('X-Cache', 'MISS');
    res.json(responseBody);
}));

// POST /api/products — vendor or admin creates product
router.post('/', protect, authorize('vendor', 'admin'), parseProductImageUpload, asyncHandler(async (req, res) => {
    let targetVendors = [];
    try {
        targetVendors = await resolveTargetVendors({ user: req.user, body: req.body });
    } catch (error) {
        return res.status(error.statusCode || 400).json({ success: false, message: error.message });
    }

    const {
        title,
        description,
        price,
        discountPrice,
        category,
        subCategory,
        stock,
        pincode,
        tags,
        sku,
        unit,
        weight,
        manageStock,
        allowBackorders,
        soldIndividually,
        taxStatus,
        taxClass,
        commissionMode,
        commissionValue,
        attributes,
        productType,
        externalUrl,
        externalButtonText,
        variations,
    } = req.body;

    const categoryList = parseIdList(req.body.categories);
    const sourceProductId = clean(req.body.sourceProductId);
    let sourceProduct = null;

    if (sourceProductId) {
        sourceProduct = await Product.findById(sourceProductId).lean();
        if (!sourceProduct) {
            return res.status(404).json({ success: false, message: 'Source product not found' });
        }
    }

    const sourceGallery = normalizeProductImages(sourceProduct);
    const sourceVariations = Array.isArray(sourceProduct?.variations)
        ? sourceProduct.variations.map((variation) => cloneVariation(variation))
        : [];
    const canonicalSourceId = sourceProduct ? getCanonicalSourceId(sourceProduct) : null;

    const galleryFiles = req.files?.images || [];
    const variationFiles = req.files?.variationImages || [];
    const variationImageIndexes = parseJsonArray(req.body.variationImageIndexes);
    const galleryUrls = parseStringList(req.body.imageUrls, /,/);
    const imageOrder = parseJsonArray(req.body.imageOrder);

    let parsedVariations = variations
        ? (typeof variations === 'string' ? JSON.parse(variations) : variations)
        : sourceVariations;
    let normalizedVariations = normalizeVariationPayloads(parsedVariations);

    const parsedAttributes = attributes
        ? (typeof attributes === 'string' ? JSON.parse(attributes) : attributes)
        : sourceProduct?.attributes;
    const parsedTags = tags !== undefined
        ? parseStringList(tags, /,/)
        : (Array.isArray(sourceProduct?.tags) ? sourceProduct.tags : []);

    const titleValue = title || sourceProduct?.title;
    const descriptionValue = description || sourceProduct?.description;
    const priceValue = coerceNumber(price ?? sourceProduct?.price);
    const discountValue = coerceNumber(discountPrice ?? sourceProduct?.discountPrice);
    const stockValue = coerceNumber(stock ?? sourceProduct?.stock);
    const weightValue = coerceNumber(weight ?? sourceProduct?.weight);
    const commissionValueNum = coerceNumber(commissionValue ?? sourceProduct?.commissionValue);
    const unitValue = unit || sourceProduct?.unit || 'piece';
    const productTypeValue = productType || sourceProduct?.productType || 'simple';
    const externalUrlValue = externalUrl || sourceProduct?.externalUrl;
    const externalButtonTextValue = externalButtonText || sourceProduct?.externalButtonText;
    const primaryCategoryId = categoryList[0] || category || sourceProduct?.category;

    if (!titleValue || !descriptionValue || priceValue === undefined || stockValue === undefined || !primaryCategoryId) {
        return res.status(400).json({
            success: false,
            message: 'Title, description, price, stock, and category are required',
        });
    }

    if (discountValue !== undefined && priceValue !== undefined && discountValue >= priceValue) {
        return res.status(400).json({
            success: false,
            message: 'Discount price must be less than original price',
        });
    }

    const taxClassCode = (taxClass || sourceProduct?.taxClass || 'standard').toString().toLowerCase();
    if (!['standard', 'zero'].includes(taxClassCode)) {
        const tax = await TaxClass.findOne({ code: taxClassCode, isActive: true });
        if (!tax) {
            return res.status(400).json({ success: false, message: 'Invalid tax class selected' });
        }
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
        existingAssignments.forEach((productDoc) => duplicateVendors.add(String(productDoc.vendorId)));
    }

    const vendorsToCreate = targetVendors.filter((vendor) => !duplicateVendors.has(String(vendor._id)));
    if (vendorsToCreate.length === 0) {
        return res.status(409).json({
            success: false,
            message: 'This product is already assigned to the selected vendor(s)',
        });
    }

    const primaryCategoryName = await resolveCategoryName(primaryCategoryId);
    const reservedSlugs = new Set();
    const uploadedAssetsToCleanup = [];

    let payloadsWithSlugs = [];
    try {
        payloadsWithSlugs = await Promise.all(vendorsToCreate.map(async (vendor, index) => {
            const mediaState = await buildProductMediaState({
                vendorId: vendor._id,
                productType: productTypeValue,
                galleryFiles,
                galleryUrls: galleryUrls.length > 0 ? galleryUrls : sourceGallery.images,
                imageOrder,
                baseImageAssets: sourceGallery.imageAssets,
                variations: normalizedVariations,
                variationFiles,
                variationImageIndexes,
                existingVariationAssets: sourceVariations,
                context: {
                    vendorId: String(vendor._id),
                    source: 'product-create',
                },
            });

            uploadedAssetsToCleanup.push(...mediaState.uploadedAssets);

            let finalImageAssets = mediaState.imageAssets;
            if (productTypeValue !== 'variable' && finalImageAssets.length === 0) {
                finalImageAssets = sourceGallery.imageAssets;
            }
            if (productTypeValue === 'variable' && finalImageAssets.length === 0) {
                finalImageAssets = buildVariableProductGallery(mediaState.variations);
                if (finalImageAssets.length === 0) {
                    finalImageAssets = sourceGallery.imageAssets;
                }
            }

            if (finalImageAssets.length === 0) {
                throw createHttpError(400, 'Add at least one image (upload file or paste image URL).');
            }

            const effectiveStock = productTypeValue === 'variable'
                ? mediaState.variations.reduce((sum, variation) => sum + (variation.stock || 0), 0)
                : stockValue;

            return {
                vendorId: vendor._id,
                sourceProductId: canonicalSourceId || undefined,
                title: titleValue,
                description: descriptionValue,
                price: priceValue,
                discountPrice: discountValue,
                images: finalImageAssets.map((asset) => asset.url),
                imageAssets: finalImageAssets,
                category: primaryCategoryId,
                categories: categoryList.length ? categoryList : undefined,
                categoryName: primaryCategoryName,
                subCategory,
                stock: effectiveStock,
                location: vendor.location,
                pincode: pincode || sourceProduct?.pincode || vendor.pincode,
                city: vendor.city || vendor.address?.city,
                state: vendor.state || vendor.address?.state,
                tags: parsedTags,
                sku: sku || sourceProduct?.sku,
                unit: unitValue,
                weight: weightValue,
                manageStock: manageStock !== undefined
                    ? coerceBoolean(manageStock)
                    : (sourceProduct?.manageStock ?? true),
                allowBackorders: allowBackorders !== undefined
                    ? coerceBoolean(allowBackorders)
                    : (sourceProduct?.allowBackorders ?? false),
                soldIndividually: soldIndividually !== undefined
                    ? coerceBoolean(soldIndividually)
                    : (sourceProduct?.soldIndividually ?? false),
                taxStatus: taxStatus || sourceProduct?.taxStatus || 'taxable',
                taxClass: taxClassCode,
                commissionMode: commissionMode || sourceProduct?.commissionMode || undefined,
                commissionValue: commissionValueNum,
                attributes: parsedAttributes,
                productType: productTypeValue,
                externalUrl: externalUrlValue,
                externalButtonText: externalButtonTextValue,
                variations: mediaState.variations,
                slug: await generateUniqueProductSlug(titleValue, {
                    reservedSlugs,
                    suffixSeed: `${String(vendor._id).slice(-6)}-${index}`,
                }),
            };
        }));
    } catch (error) {
        await deleteImageAssetBatch(uploadedAssetsToCleanup);
        return res.status(error.statusCode || 400).json({ success: false, message: error.message });
    }

    let createdProducts = [];
    try {
        createdProducts = await Product.create(payloadsWithSlugs);
    } catch (error) {
        await deleteImageAssetBatch(uploadedAssetsToCleanup);
        throw error;
    }
    const createdList = Array.isArray(createdProducts) ? createdProducts : [createdProducts];

    await Vendor.updateMany(
        { _id: { $in: createdList.map((productDoc) => productDoc.vendorId) } },
        { $inc: { totalProducts: 1 } },
    );

    const skippedVendorIds = targetVendors
        .filter((vendor) => duplicateVendors.has(String(vendor._id)))
        .map((vendor) => String(vendor._id));
    const skippedVendors = targetVendors
        .filter((vendor) => duplicateVendors.has(String(vendor._id)))
        .map((vendor) => ({ _id: vendor._id, storeName: vendor.storeName }));
    const assignedVendors = vendorsToCreate.map((vendor) => ({
        _id: vendor._id,
        storeName: vendor.storeName,
    }));

    await invalidateProductCache(createdList.map((productDoc) => productDoc._id));

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
router.put('/:id', protect, authorize('vendor', 'admin'), parseProductImageUpload, asyncHandler(async (req, res) => {
    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ success: false, message: 'Product not found' });

    if (req.user.role === 'vendor') {
        const vendor = await Vendor.findOne({ userId: req.user._id });
        if (!vendor || product.vendorId.toString() !== vendor._id.toString()) {
            return res.status(403).json({ success: false, message: 'Not authorized to edit this product' });
        }
    }

    const previousProductSnapshot = product.toObject();
    const updates = { ...req.body };
    const sourceGallery = normalizeProductImages(product);
    const existingVariations = Array.isArray(product.variations)
        ? product.variations.map((variation) => cloneVariation(variation.toObject ? variation.toObject() : variation))
        : [];

    if (updates.taxClass) {
        updates.taxClass = String(updates.taxClass).trim().toLowerCase();
        if (!['standard', 'zero'].includes(updates.taxClass)) {
            const tax = await TaxClass.findOne({ code: updates.taxClass, isActive: true });
            if (!tax) {
                return res.status(400).json({ success: false, message: 'Invalid tax class selected' });
            }
        }
    }

    const categoriesRaw = updates.categories;
    if (categoriesRaw !== undefined) {
        const categoryList = Array.isArray(categoriesRaw)
            ? categoriesRaw.filter(Boolean)
            : String(categoriesRaw || '')
                .split(',')
                .map((item) => item.trim())
                .filter(Boolean);
        updates.categories = categoryList;
        if (categoryList.length > 0) {
            updates.category = categoryList[0];
            const primaryName = await resolveCategoryName(categoryList[0]);
            if (primaryName) updates.categoryName = primaryName;
        }
    }
    if (updates.category && !updates.categoryName) {
        const primaryName = await resolveCategoryName(updates.category);
        if (primaryName) updates.categoryName = primaryName;
    }

    let targetVendor = null;
    if (req.user.role === 'admin' && updates.vendorId && updates.vendorId.toString() !== product.vendorId.toString()) {
        targetVendor = await Vendor.findById(updates.vendorId);
        if (!targetVendor) {
            return res.status(404).json({ success: false, message: 'New vendor not found' });
        }
        updates.location = targetVendor.location;
        updates.pincode = targetVendor.pincode;
        updates.city = targetVendor.city;
        updates.state = targetVendor.state;
    } else {
        delete updates.vendorId;
    }

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

    if (updates.attributes && typeof updates.attributes === 'string') {
        updates.attributes = JSON.parse(updates.attributes);
    }
    if (updates.tags !== undefined) {
        updates.tags = parseStringList(updates.tags, /,/);
    }
    if (updates.variations && typeof updates.variations === 'string') {
        updates.variations = JSON.parse(updates.variations);
    }

    const effectiveProductType = updates.productType || product.productType || 'simple';
    let normalizedVariationUpdates = updates.variations !== undefined
        ? normalizeVariationPayloads(updates.variations)
        : normalizeVariationPayloads(existingVariations);
    if (effectiveProductType !== 'variable' && updates.productType && updates.productType !== 'variable') {
        normalizedVariationUpdates = [];
    }

    const galleryFiles = req.files?.images || [];
    const variationFiles = req.files?.variationImages || [];
    const variationImageIndexes = parseJsonArray(req.body.variationImageIndexes);
    const imageOrder = parseJsonArray(updates.imageOrder);
    const submittedGalleryUrls = updates.imageUrls !== undefined
        ? parseStringList(updates.imageUrls, /,/)
        : sourceGallery.images;
    const shouldRebuildMedia = galleryFiles.length > 0
        || variationFiles.length > 0
        || updates.imageUrls !== undefined
        || updates.imageOrder !== undefined
        || updates.variations !== undefined
        || updates.productType !== undefined;

    const uploadedAssetsToCleanup = [];

    try {
        if (shouldRebuildMedia) {
            const mediaState = await buildProductMediaState({
                vendorId: targetVendor?._id || product.vendorId,
                productType: effectiveProductType,
                galleryFiles,
                galleryUrls: submittedGalleryUrls,
                imageOrder,
                baseImageAssets: sourceGallery.imageAssets,
                variations: normalizedVariationUpdates,
                variationFiles,
                variationImageIndexes,
                existingVariationAssets: existingVariations,
                context: {
                    vendorId: String(targetVendor?._id || product.vendorId),
                    productId: String(product._id),
                    source: 'product-update',
                },
            });

            uploadedAssetsToCleanup.push(...mediaState.uploadedAssets);

            let finalImageAssets = mediaState.imageAssets;
            if (effectiveProductType === 'variable' && finalImageAssets.length === 0) {
                finalImageAssets = buildVariableProductGallery(mediaState.variations);
                if (finalImageAssets.length === 0) {
                    finalImageAssets = sourceGallery.imageAssets;
                }
            }

            if (finalImageAssets.length === 0) {
                throw createHttpError(400, 'Add at least one image (upload file or paste image URL).');
            }

            updates.imageAssets = finalImageAssets;
            updates.images = finalImageAssets.map((asset) => asset.url);
            updates.variations = mediaState.variations;
        } else if (updates.variations !== undefined) {
            updates.variations = normalizedVariationUpdates;
        }
    } catch (error) {
        await deleteImageAssetBatch(uploadedAssetsToCleanup);
        return res.status(error.statusCode || 400).json({ success: false, message: error.message });
    }

    delete updates.imageUrls;
    delete updates.imageOrder;

    if (effectiveProductType === 'variable') {
        const effectiveVariations = Array.isArray(updates.variations) ? updates.variations : existingVariations;
        updates.stock = effectiveVariations.reduce((sum, variation) => sum + (variation.stock || 0), 0);
    }

    const effectivePrice = updates.price !== undefined ? updates.price : product.price;
    const effectiveDiscount = updates.discountPrice !== undefined ? updates.discountPrice : product.discountPrice;
    if (effectiveDiscount !== undefined && effectivePrice !== undefined && effectiveDiscount >= effectivePrice) {
        await deleteImageAssetBatch(uploadedAssetsToCleanup);
        return res.status(400).json({
            success: false,
            message: 'Discount price must be less than original price',
        });
    }

    let updated = null;
    try {
        updated = await Product.findByIdAndUpdate(
            req.params.id,
            updates,
            { new: true, runValidators: true, context: 'query' },
        );
    } catch (error) {
        await deleteImageAssetBatch(uploadedAssetsToCleanup);
        throw error;
    }

    if (targetVendor) {
        await Vendor.findByIdAndUpdate(product.vendorId, { $inc: { totalProducts: -1 } });
        await Vendor.findByIdAndUpdate(targetVendor._id, { $inc: { totalProducts: 1 } });
    }

    const cleanupFailures = await deleteImageAssetBatch(collectImageAssetsToDelete({
        previousProduct: previousProductSnapshot,
        nextProduct: updated,
    }));
    if (cleanupFailures.length > 0) {
        console.error('Failed to clean up some product images after update', cleanupFailures);
    }

    await invalidateProductCache(req.params.id);
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

    const cleanupFailures = await deleteImageAssetBatch(collectProductImageAssets(product));
    if (cleanupFailures.length > 0) {
        console.error('Failed to clean up some product images after delete', cleanupFailures);
    }

    await invalidateProductCache(req.params.id);
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

    await invalidateProductCache([...inserted, ...updated]);
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
    const productId = req.params.id;
    const user = await User.findById(req.user._id).select('wishlist');
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const wishlistIds = (user.wishlist || []).map((id) => String(id));
    const inWishlist = wishlistIds.includes(String(productId));

    const update = inWishlist
        ? { $pull: { wishlist: productId } }
        : { $addToSet: { wishlist: productId } };

    const updatedUser = await User.findByIdAndUpdate(req.user._id, update, { new: true }).select('wishlist');
    res.json({
        success: true,
        inWishlist: !inWishlist,
        wishlist: (updatedUser?.wishlist || []).map((id) => String(id)),
        message: inWishlist ? 'Removed from wishlist' : 'Added to wishlist',
    });
}));

module.exports = router;
