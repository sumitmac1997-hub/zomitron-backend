jest.mock('../models/Product', () => ({
    countDocuments: jest.fn(),
    find: jest.fn(),
    findById: jest.fn(),
    create: jest.fn(),
    findByIdAndUpdate: jest.fn(),
    exists: jest.fn(),
}));

jest.mock('../models/Vendor', () => ({
    findOne: jest.fn(),
    find: jest.fn(),
    updateMany: jest.fn(),
    findByIdAndUpdate: jest.fn(),
    findById: jest.fn(),
}));

jest.mock('../models/Category', () => ({
    findOne: jest.fn(),
    create: jest.fn(),
    find: jest.fn(),
}));

jest.mock('../middleware/auth', () => ({
    protect: (req, res, next) => {
        req.user = {
            _id: req.headers['x-user-id'] || 'user-1',
            role: req.headers['x-role'] || 'vendor',
        };
        next();
    },
    authorize: (...roles) => (req, res, next) => {
        if (!roles.includes(req.user.role)) {
            return res.status(403).json({ success: false, message: 'Forbidden' });
        }
        next();
    },
}));

jest.mock('../middleware/productUpload', () => ({
    MAX_PRODUCT_IMAGE_COUNT: 5,
    parseProductImageUpload: (req, res, next) => next(),
}));

jest.mock('../config/cloudinary', () => ({
    createImageAsset: (source) => {
        if (!source) return null;
        if (typeof source === 'string') {
            return { url: source, publicId: '', provider: 'external', resourceType: 'image' };
        }
        const url = source.deliveryUrl || source.url || source.secure_url || source.path || source.originalname || 'upload-url';
        return {
            url,
            publicId: source.public_id || source.publicId || '',
            provider: source.public_id ? 'cloudinary' : 'external',
            resourceType: source.resource_type || 'image',
        };
    },
    createSignedUploadSignature: () => ({
        timestamp: 1712490000,
        signature: 'signed-payload',
        apiKey: 'cloud-key',
        cloudName: 'cloud-name',
    }),
    deleteStoredImageAsset: jest.fn().mockResolvedValue(null),
    uploadBufferImage: jest.fn(async ({ publicIdPrefix }) => ({
        public_id: `products/mock/${publicIdPrefix}`,
        secure_url: `https://cdn.example/${publicIdPrefix}.jpg`,
        deliveryUrl: `https://cdn.example/${publicIdPrefix}.jpg`,
        resource_type: 'image',
        bytes: 1024,
        format: 'jpg',
    })),
    uploadCSV: {
        single: () => (req, res, next) => next(),
    },
    toUploadUrl: (file) => file?.path || file?.originalname || 'upload-url',
}));

const Product = require('../models/Product');
const Vendor = require('../models/Vendor');
const Category = require('../models/Category');
const productRouter = require('../routes/product');

const makeLeanChain = (result) => {
    const chain = {
        populate: jest.fn().mockReturnThis(),
        sort: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        lean: jest.fn().mockReturnThis(),
        then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
        catch: (reject) => Promise.resolve(result).catch(reject),
    };
    return chain;
};

const makeSelectChain = (result) => ({
    select: jest.fn().mockResolvedValue(result),
});

const getRouteHandlers = (path, method) => {
    const layer = productRouter.stack.find((entry) => entry.route?.path === path && entry.route?.methods?.[method]);
    if (!layer) throw new Error(`Route ${method.toUpperCase()} ${path} not found`);
    return layer.route.stack.map((entry) => entry.handle);
};

const invokeRoute = async ({ path, method, headers = {}, query = {}, body = {}, params = {} }) => {
    const handlers = getRouteHandlers(path, method);

    return new Promise((resolve, reject) => {
        const req = {
            method: method.toUpperCase(),
            headers,
            query,
            body,
            params,
            files: undefined,
            app: { get: jest.fn() },
        };

        const res = {
            statusCode: 200,
            body: undefined,
            headers: {},
            status(code) {
                this.statusCode = code;
                return this;
            },
            json(payload) {
                this.body = payload;
                resolve(this);
                return this;
            },
            send(payload) {
                this.body = payload;
                resolve(this);
                return this;
            },
            setHeader(name, value) {
                this.headers[name] = value;
            },
            set(name, value) {
                this.headers[name] = value;
                return this;
            },
        };

        const run = (index) => {
            if (index >= handlers.length) {
                resolve(res);
                return;
            }

            try {
                const maybePromise = handlers[index](req, res, (error) => {
                    if (error) {
                        reject(error);
                        return;
                    }
                    run(index + 1);
                });

                if (maybePromise && typeof maybePromise.then === 'function') {
                    maybePromise
                        .then(() => {
                            if (index === handlers.length - 1 && res.body === undefined) resolve(res);
                        })
                        .catch(reject);
                }
            } catch (error) {
                reject(error);
            }
        };

        run(0);
    });
};

describe('Product library and clone routes', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        Product.exists.mockResolvedValue(false);
    });

    test('GET /api/products/library applies vendor/category filters and marks already-added items', async () => {
        Vendor.findOne.mockReturnValueOnce(makeSelectChain({ _id: 'vendor-self' }));
        Product.countDocuments.mockResolvedValueOnce(1);
        Product.find
            .mockReturnValueOnce(makeLeanChain([{
                _id: 'product-1',
                sourceProductId: 'catalog-root',
                title: 'Phone',
                images: ['/phone.jpg'],
                vendorId: { _id: 'vendor-other', storeName: 'Other Store' },
                category: { _id: 'cat-1', name: 'Electronics' },
                city: 'Varanasi',
            }]))
            .mockReturnValueOnce(makeLeanChain([
                { _id: 'owned-copy', sourceProductId: 'catalog-root' },
            ]));

        const res = await invokeRoute({
            path: '/library',
            method: 'get',
            headers: { 'x-role': 'vendor' },
            query: { search: 'phone', category: 'cat-1', vendorId: 'vendor-other' },
        });

        expect(res.statusCode).toBe(200);
        expect(Product.countDocuments).toHaveBeenCalledWith(expect.objectContaining({
            isActive: true,
            isApproved: true,
            vendorId: 'vendor-other',
        }));
        expect(Product.countDocuments.mock.calls[0][0].$and).toEqual(expect.arrayContaining([
            { $or: [{ category: 'cat-1' }, { categories: 'cat-1' }] },
        ]));
        expect(res.body.products[0]).toEqual(expect.objectContaining({
            canonicalSourceId: 'catalog-root',
            alreadyAdded: true,
        }));
    });

    test('GET /api/products treats category=all as no category filter', async () => {
        Product.find.mockReturnValueOnce(makeLeanChain([]));
        Product.countDocuments.mockResolvedValueOnce(0);

        const res = await invokeRoute({
            path: '/',
            method: 'get',
            query: { category: 'all', page: '1', limit: '20' },
        });

        expect(res.statusCode).toBe(200);
        expect(Category.findOne).not.toHaveBeenCalled();
        expect(Product.countDocuments).toHaveBeenCalledWith(expect.not.objectContaining({
            $or: expect.anything(),
        }));
    });

    test('GET /api/products keeps out-of-stock items in the public shop listing', async () => {
        Product.find.mockReturnValueOnce(makeLeanChain([
            {
                _id: 'product-out-of-stock',
                title: 'Sold Out Phone',
                slug: 'sold-out-phone',
                images: ['/phone.jpg'],
                price: 19999,
                discountPrice: 17999,
                stock: 0,
                city: 'Varanasi',
                state: 'Uttar Pradesh',
                pincode: '221001',
                ratings: { average: 4.4, count: 12 },
                isFeatured: false,
                vendorId: 'vendor-1',
                category: 'cat-1',
                categories: ['cat-1'],
                subCategory: null,
                categoryName: 'Electronics',
                tags: ['phone'],
                attributes: [],
                location: { type: 'Point', coordinates: [82.9739, 25.3176] },
                createdAt: '2026-01-01T00:00:00.000Z',
                orderCount: 4,
            },
        ]));
        Product.countDocuments.mockResolvedValueOnce(1);
        Vendor.find.mockReturnValueOnce(makeLeanChain([
            {
                _id: 'vendor-1',
                storeName: 'Open Store',
                storeLogo: '/logo.jpg',
                ratings: { average: 4.5, count: 30 },
                address: { line1: 'Market Road' },
                location: { type: 'Point', coordinates: [82.9739, 25.3176] },
                isOpen: true,
                approved: true,
            },
        ]));
        Category.find.mockReturnValueOnce(makeLeanChain([
            { _id: 'cat-1', name: 'Electronics', slug: 'electronics', icon: '📱' },
        ]));

        const res = await invokeRoute({
            path: '/',
            method: 'get',
            query: { page: '1', limit: '20' },
        });

        expect(res.statusCode).toBe(200);
        expect(Product.countDocuments).toHaveBeenCalledWith(expect.not.objectContaining({
            stock: expect.anything(),
        }));
        expect(res.body.products).toEqual(expect.arrayContaining([
            expect.objectContaining({
                _id: 'product-out-of-stock',
                stock: 0,
                title: 'Sold Out Phone',
            }),
        ]));
    });

    test('POST /api/products creates vendor-specific copies from a source product and skips duplicates', async () => {
        Vendor.find.mockResolvedValueOnce([
            {
                _id: 'vendor-a',
                storeName: 'Store A',
                location: { type: 'Point', coordinates: [82.9, 25.3] },
                pincode: '221001',
                city: 'Varanasi',
                state: 'Uttar Pradesh',
                address: { city: 'Varanasi', state: 'Uttar Pradesh' },
            },
            {
                _id: 'vendor-b',
                storeName: 'Store B',
                location: { type: 'Point', coordinates: [80.9, 26.8] },
                pincode: '226001',
                city: 'Lucknow',
                state: 'Uttar Pradesh',
                address: { city: 'Lucknow', state: 'Uttar Pradesh' },
            },
        ]);

        Product.findById.mockReturnValueOnce({
            lean: jest.fn().mockResolvedValue({
                _id: 'source-copy',
                sourceProductId: 'catalog-root',
                title: 'Catalog Phone',
                description: 'Catalog description',
                images: ['/catalog-phone.jpg'],
                imageAssets: [{ url: '/catalog-phone.jpg', publicId: '', provider: 'external' }],
                unit: 'piece',
                productType: 'simple',
            }),
        });

        Product.find.mockReturnValueOnce(makeLeanChain([
            { vendorId: 'vendor-b' },
        ]));

        Product.create.mockResolvedValueOnce([
            { _id: 'created-1', vendorId: 'vendor-a', title: 'Catalog Phone' },
        ]);

        const res = await invokeRoute({
            path: '/',
            method: 'post',
            headers: { 'x-role': 'admin' },
            body: {
                vendorIds: ['vendor-a', 'vendor-b'],
                sourceProductId: 'source-copy',
                title: 'Catalog Phone',
                description: 'Catalog description',
                price: 49999,
                stock: 8,
                category: 'cat-1',
                imageUrls: 'https://img.example/phone.jpg',
            },
        });

        expect(res.statusCode).toBe(201);
        expect(Product.create).toHaveBeenCalledWith([
            expect.objectContaining({
                vendorId: 'vendor-a',
                sourceProductId: 'catalog-root',
                title: 'Catalog Phone',
                price: 49999,
            }),
        ]);
        expect(res.body).toEqual(expect.objectContaining({
            createdCount: 1,
            skippedVendorIds: ['vendor-b'],
            assignedVendors: [{ _id: 'vendor-a', storeName: 'Store A' }],
            skippedVendors: [{ _id: 'vendor-b', storeName: 'Store B' }],
        }));
    });

    test('POST /api/products/uploads/signature returns a vendor-scoped signed upload payload', async () => {
        Vendor.findById.mockReturnValueOnce(makeSelectChain({ _id: 'vendor-a' }));

        const res = await invokeRoute({
            path: '/uploads/signature',
            method: 'post',
            headers: { 'x-role': 'admin' },
            body: { vendorId: 'vendor-a' },
        });

        expect(res.statusCode).toBe(200);
        expect(res.body.upload).toEqual(expect.objectContaining({
            folder: 'products/vendor-a',
            signature: 'signed-payload',
            apiKey: 'cloud-key',
            cloudName: 'cloud-name',
        }));
    });
});
