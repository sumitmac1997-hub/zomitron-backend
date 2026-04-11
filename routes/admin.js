const express = require('express');
const router = express.Router();
const asyncHandler = require('express-async-handler');
const User = require('../models/User');
const Vendor = require('../models/Vendor');
const Product = require('../models/Product');
const Order = require('../models/Order');
const Category = require('../models/Category');
const ShippingRule = require('../models/ShippingRule');
const Setting = require('../models/Setting');
const AdminNotification = require('../models/AdminNotification');
const Rider = require('../models/Rider');
const { getSettingValue, setSettingValue } = require('../utils/settings');
const { protect, authorize } = require('../middleware/auth');
const { geocodePincode } = require('../utils/geocode');
const { uploadVendor, toUploadUrl } = require('../config/cloudinary');
const { buildInvoicePdf } = require('../utils/pdfInvoice');
const { normalizeCity, parsePincodeRanges, serializeShippingRule } = require('../utils/shippingRules');

const escapeRegex = (value = '') => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// All admin routes require auth + admin role
router.use(protect, authorize('admin'));

// GET /api/admin/dashboard — Analytics overview
router.get('/dashboard', asyncHandler(async (req, res) => {
    const { period } = req.query;
    const matchByPeriod = {};
    if (period && period !== 'all') {
        const days = parseInt(period);
        if (!Number.isNaN(days) && days > 0) {
            matchByPeriod.createdAt = { $gte: new Date(Date.now() - days * 24 * 60 * 60 * 1000) };
        }
    }

    const [
        totalUsers, totalVendors, totalProducts, totalOrders,
        revenueResult, pendingVendors, recentOrders, salesByCategory,
    ] = await Promise.all([
        User.countDocuments({ role: 'customer' }),
        Vendor.countDocuments({ approved: true }),
        Product.countDocuments({ isActive: true }),
        Order.countDocuments({ ...matchByPeriod, isPlaced: { $ne: false } }),
        Order.aggregate([
            { $match: { ...matchByPeriod, isPlaced: { $ne: false }, paymentStatus: 'paid' } },
            { $group: { _id: null, total: { $sum: '$total' }, platformFee: { $sum: '$platformFee' } } },
        ]),
        Vendor.countDocuments({ approved: false }),
        Order.find({ ...matchByPeriod, isPlaced: { $ne: false } })
            .populate('customerId', 'name')
            .sort({ createdAt: -1 })
            .limit(10)
            .lean(),
        Order.aggregate([
            { $match: { ...matchByPeriod, isPlaced: { $ne: false } } },
            { $unwind: '$items' },
            { $lookup: { from: 'products', localField: 'items.productId', foreignField: '_id', as: 'product' } },
            { $unwind: '$product' },
            { $lookup: { from: 'categories', localField: 'product.category', foreignField: '_id', as: 'cat' } },
            { $unwind: { path: '$cat', preserveNullAndEmptyArrays: true } },
            { $group: { _id: '$cat.name', total: { $sum: '$items.subtotal' }, count: { $sum: 1 } } },
            { $sort: { total: -1 } }, { $limit: 10 },
        ]),
    ]);

    res.json({
        success: true,
        stats: {
            totalUsers, totalVendors, totalProducts, totalOrders,
            revenue: revenueResult[0]?.total || 0,
            platformEarnings: revenueResult[0]?.platformFee || 0,
            pendingVendors,
        },
        recentOrders,
        salesByCategory,
    });
}));

// GET /api/admin/vendors — All vendors (paginated)
router.get('/vendors', asyncHandler(async (req, res) => {
    const { page = 1, limit = 20, approved, search } = req.query;
    const query = {};
    if (approved !== undefined) query.approved = approved === 'true';
    if (search) query.storeName = { $regex: search, $options: 'i' };

    const total = await Vendor.countDocuments(query);
    const vendors = await Vendor.find(query)
        .populate('userId', 'name email phone createdAt')
        .sort({ createdAt: -1 })
        .skip((parseInt(page) - 1) * parseInt(limit))
        .limit(parseInt(limit))
        .lean();

    res.json({ success: true, vendors, total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)) });
}));

// PUT /api/admin/vendors/approve/:id
router.put('/vendors/approve/:id', asyncHandler(async (req, res) => {
    const { approved, rejectionReason } = req.body;
    const vendor = await Vendor.findByIdAndUpdate(
        req.params.id,
        { approved, rejectionReason: approved ? undefined : rejectionReason, approvedAt: approved ? new Date() : undefined, approvedBy: req.user._id },
        { new: true }
    ).populate('userId', 'name email');

    if (!vendor) return res.status(404).json({ success: false, message: 'Vendor not found' });

    // Notify vendor user
    const io = req.app.get('io');
    if (io) io.emitToUser(vendor.userId._id.toString(), 'vendorApproval', { approved, message: approved ? 'Your store is approved!' : rejectionReason });

    res.json({ success: true, vendor, message: approved ? 'Vendor approved' : 'Vendor rejected' });
}));

// GET /api/admin/vendors/:id — Get full vendor detail
router.get('/vendors/:id', asyncHandler(async (req, res) => {
    const vendor = await Vendor.findById(req.params.id)
        .populate('userId', 'name email phone createdAt avatar')
        .lean();
    if (!vendor) return res.status(404).json({ success: false, message: 'Vendor not found' });
    res.json({ success: true, vendor });
}));

// PUT /api/admin/vendors/:id — edit vendor profile
router.put('/vendors/:id', uploadVendor.fields([
    { name: 'storeLogo', maxCount: 1 },
    { name: 'storeBanner', maxCount: 1 },
]), asyncHandler(async (req, res) => {
    const updates = { ...req.body };

    if (req.files?.storeLogo) updates.storeLogo = toUploadUrl(req.files.storeLogo[0]);
    if (req.files?.storeBanner) updates.storeBanner = toUploadUrl(req.files.storeBanner[0]);

    if (updates.address && typeof updates.address === 'string') updates.address = JSON.parse(updates.address);
    if (updates.storeHours && typeof updates.storeHours === 'string') updates.storeHours = JSON.parse(updates.storeHours);
    if (updates.bankDetails && typeof updates.bankDetails === 'string') updates.bankDetails = JSON.parse(updates.bankDetails);

    // Re-geocode if pincode changed
    let vendor = await Vendor.findById(req.params.id);
    if (!vendor) return res.status(404).json({ success: false, message: 'Vendor not found' });

    if (updates.pincode && updates.pincode !== vendor.pincode) {
        const geo = await geocodePincode(updates.pincode);
        if (geo) {
            updates.location = { type: 'Point', coordinates: [geo.lng, geo.lat] };
            updates.city = updates.city || geo.city;
            updates.state = updates.state || geo.state;
            await Product.updateMany(
                { vendorId: vendor._id },
                { location: updates.location, pincode: updates.pincode, city: updates.city }
            );
        }
    }

    vendor = await Vendor.findByIdAndUpdate(req.params.id, updates, { new: true, runValidators: true });
    res.json({ success: true, vendor });
}));

// PUT /api/admin/vendors/:id/open — toggle store availability
router.put('/vendors/:id/open', asyncHandler(async (req, res) => {
    const { isOpen } = req.body;
    const vendor = await Vendor.findByIdAndUpdate(req.params.id, { isOpen: !!isOpen }, { new: true, runValidators: true });
    if (!vendor) return res.status(404).json({ success: false, message: 'Vendor not found' });
    res.json({ success: true, vendor });
}));

// PUT /api/admin/vendors/:id/commission
router.put('/vendors/:id/commission', asyncHandler(async (req, res) => {
    const { commissionRate } = req.body;
    if (commissionRate < 0 || commissionRate > 1) return res.status(400).json({ success: false, message: 'Invalid commission rate (0-1)' });
    const vendor = await Vendor.findByIdAndUpdate(req.params.id, { commissionRate }, { new: true });
    res.json({ success: true, vendor });
}));

// GET /api/admin/orders
router.get('/orders', asyncHandler(async (req, res) => {
    const { page = 1, limit = 20, status, vendorId, from, to, search, storeSearch } = req.query;
    const andConditions = [];

    if (status) andConditions.push({ orderStatus: status });
    if (vendorId) andConditions.push({ vendorIds: vendorId });

    if (from || to) {
        const createdAt = {};
        if (from) createdAt.$gte = new Date(from);
        if (to) createdAt.$lte = new Date(to);
        andConditions.push({ createdAt });
    }
    if (search) {
        const term = search.trim();
        andConditions.push({ orderNumber: { $regex: escapeRegex(term), $options: 'i' } });
    }

    const storeSearchTerm = String(storeSearch || '').trim();
    if (storeSearchTerm) {
        const storeRegex = new RegExp(escapeRegex(storeSearchTerm), 'i');

        const [matchingVendors, matchingCategories] = await Promise.all([
            Vendor.aggregate([
                {
                    $project: {
                        _id: 1,
                        storeName: 1,
                        idStr: { $toString: '$_id' },
                    },
                },
                {
                    $match: {
                        $or: [
                            { storeName: storeRegex },
                            { idStr: storeRegex },
                        ],
                    },
                },
                { $limit: 100 },
            ]),
            Category.find({
                $or: [
                    { name: storeRegex },
                    { slug: storeRegex },
                ],
            }).select('_id').lean(),
        ]);

        const categoryIds = matchingCategories.map((category) => category._id);
        const productCategoryFilters = [
            { categoryName: storeRegex },
            ...(categoryIds.length ? [
                { category: { $in: categoryIds } },
                { categories: { $in: categoryIds } },
            ] : []),
        ];

        const matchingProductIds = productCategoryFilters.length > 0
            ? await Product.distinct('_id', { $or: productCategoryFilters })
            : [];

        const matchingVendorIds = [...new Set(matchingVendors.map((vendor) => vendor._id))];
        const storeSearchFilters = [];

        if (matchingVendorIds.length > 0) {
            storeSearchFilters.push({ vendorIds: { $in: matchingVendorIds } });
        }
        if (matchingProductIds.length > 0) {
            storeSearchFilters.push({ 'items.productId': { $in: matchingProductIds } });
        }

        if (storeSearchFilters.length === 0) {
            return res.json({ success: true, orders: [], total: 0, page: parseInt(page), pages: 0 });
        }

        andConditions.push({ $or: storeSearchFilters });
    }

    const limitNum = Math.min(parseInt(limit), 100);
    const pageNum = parseInt(page);
    const query = andConditions.length
        ? { $and: [{ isPlaced: { $ne: false } }, ...andConditions] }
        : { isPlaced: { $ne: false } };
    const total = await Order.countDocuments(query);
    const orders = await Order.find(query)
        .populate('customerId', 'name email')
        .populate('vendorIds', 'storeName')
        .sort({ createdAt: -1 })
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum)
        .lean();

    res.json({ success: true, orders, total, page: pageNum, pages: Math.ceil(total / limitNum) });
}));

// GET /api/admin/orders/:id/invoice — PDF invoice
router.get('/orders/:id/invoice', asyncHandler(async (req, res) => {
    const order = await Order.findOne({ _id: req.params.id, isPlaced: { $ne: false } })
        .populate('customerId', 'name email phone')
        .populate('vendorIds', 'storeName')
        .lean();
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

    const pdf = buildInvoicePdf(order);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename=invoice-${order.orderNumber || order._id}.pdf`);
    res.send(pdf);
}));

// GET /api/admin/products — All products (moderation)
router.get('/products', asyncHandler(async (req, res) => {
    const { page = 1, limit = 20, isApproved, vendorId, search } = req.query;
    const filters = [];

    if (isApproved !== undefined) filters.push({ isApproved: isApproved === 'true' });
    if (vendorId) filters.push({ vendorId });

    const searchTerm = String(search || '').trim();
    let projection;
    let sort = { createdAt: -1 };

    if (searchTerm) {
        filters.push({ $text: { $search: searchTerm } });
        projection = { score: { $meta: 'textScore' } };
        sort = { score: { $meta: 'textScore' }, createdAt: -1 };
    }

    const query = filters.length ? { $and: filters } : {};
    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);

    const total = await Product.countDocuments(query);
    const products = await Product.find(query, projection)
        .populate('vendorId', 'storeName')
        .sort(sort)
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum)
        .lean();

    res.json({
        success: true,
        products,
        total,
        page: pageNum,
        pages: Math.ceil(total / limitNum),
    });
}));
// PUT /api/admin/products/:id/approve
router.put('/products/:id/approve', asyncHandler(async (req, res) => {
    const { isApproved } = req.body;
    const product = await Product.findByIdAndUpdate(req.params.id, { isApproved }, { new: true });
    res.json({ success: true, product });
}));

// GET /api/admin/payouts — Pending vendor payouts
router.get('/payouts', asyncHandler(async (req, res) => {
    const vendors = await Vendor.find({ balance: { $gt: 0 } })
        .populate('userId', 'name email')
        .select('storeName balance bankDetails userId')
        .lean();
    res.json({ success: true, vendors });
}));

// POST /api/admin/payouts/:vendorId — Process payout
router.post('/payouts/:vendorId', asyncHandler(async (req, res) => {
    const { amount } = req.body;
    const vendor = await Vendor.findById(req.params.vendorId);
    if (!vendor) return res.status(404).json({ success: false, message: 'Vendor not found' });
    if (vendor.balance < amount) return res.status(400).json({ success: false, message: 'Insufficient vendor balance' });

    await Vendor.findByIdAndUpdate(vendor._id, {
        $inc: { balance: -amount, totalWithdrawn: amount },
    });

    res.json({ success: true, message: `Payout of ₹${amount} processed for ${vendor.storeName}` });
}));

// GET /api/admin/shipping-rules
router.get('/shipping-rules', asyncHandler(async (req, res) => {
    const rules = await ShippingRule.find({})
        .sort({ cityNormalized: 1, createdAt: -1 })
        .lean();

    res.json({
        success: true,
        rules: rules.map((rule) => serializeShippingRule(rule)),
    });
}));

// POST /api/admin/shipping-rules
router.post('/shipping-rules', asyncHandler(async (req, res) => {
    const {
        city,
        pincodeRanges,
        pincodeRangesText,
        freeShippingThreshold = 0,
        shippingCharge,
        isActive = true,
    } = req.body;

    if (!String(city || '').trim()) {
        return res.status(400).json({ success: false, message: 'City is required' });
    }

    if (shippingCharge === undefined || Number(shippingCharge) < 0) {
        return res.status(400).json({ success: false, message: 'Shipping charge must be 0 or more' });
    }

    if (Number(freeShippingThreshold) < 0) {
        return res.status(400).json({ success: false, message: 'Free shipping threshold must be 0 or more' });
    }

    const parsedRanges = parsePincodeRanges(pincodeRangesText || pincodeRanges);
    if (String(pincodeRangesText || pincodeRanges || '').trim() && parsedRanges.length === 0) {
        return res.status(400).json({ success: false, message: 'No valid pincodes found in the range. Use 6-digit pins or ranges like 560001-560010.' });
    }

    const rule = await ShippingRule.create({
        city: String(city).trim(),
        cityNormalized: normalizeCity(city),
        pincodeRanges: parsedRanges,
        freeShippingThreshold: Number(freeShippingThreshold) || 0,
        shippingCharge: Number(shippingCharge) || 0,
        isActive: isActive !== false && isActive !== 'false',
        createdBy: req.user._id,
    });

    res.status(201).json({
        success: true,
        rule: serializeShippingRule(rule.toObject()),
        message: 'Shipping rule created',
    });
}));

// PUT /api/admin/shipping-rules/:id
router.put('/shipping-rules/:id', asyncHandler(async (req, res) => {
    const {
        city,
        pincodeRanges,
        pincodeRangesText,
        freeShippingThreshold = 0,
        shippingCharge,
        isActive = true,
    } = req.body;

    if (!String(city || '').trim()) {
        return res.status(400).json({ success: false, message: 'City is required' });
    }

    if (shippingCharge === undefined || Number(shippingCharge) < 0) {
        return res.status(400).json({ success: false, message: 'Shipping charge must be 0 or more' });
    }

    if (Number(freeShippingThreshold) < 0) {
        return res.status(400).json({ success: false, message: 'Free shipping threshold must be 0 or more' });
    }

    const parsedRanges = parsePincodeRanges(pincodeRangesText || pincodeRanges);
    if (String(pincodeRangesText || pincodeRanges || '').trim() && parsedRanges.length === 0) {
        return res.status(400).json({ success: false, message: 'No valid pincodes found in the range. Use 6-digit pins or ranges like 560001-560010.' });
    }

    const rule = await ShippingRule.findByIdAndUpdate(
        req.params.id,
        {
            city: String(city).trim(),
            cityNormalized: normalizeCity(city),
            pincodeRanges: parsedRanges,
            freeShippingThreshold: Number(freeShippingThreshold) || 0,
            shippingCharge: Number(shippingCharge) || 0,
            isActive: isActive !== false && isActive !== 'false',
        },
        { new: true, runValidators: true }
    ).lean();

    if (!rule) {
        return res.status(404).json({ success: false, message: 'Shipping rule not found' });
    }

    res.json({
        success: true,
        rule: serializeShippingRule(rule),
        message: 'Shipping rule updated',
    });
}));

// GET /api/admin/refund-settings — current window in days
router.get('/refund-settings', asyncHandler(async (_req, res) => {
    const days = await getSettingValue('refundWindowDays', 5);
    res.json({ success: true, days: Number(days) || 5 });
}));

// PUT /api/admin/refund-settings — update refund window (days)
router.put('/refund-settings', asyncHandler(async (req, res) => {
    const days = Number(req.body.days);
    if (Number.isNaN(days) || days < 0 || days > 365) {
        return res.status(400).json({ success: false, message: 'Refund window must be between 0 and 365 days' });
    }
    const setting = await setSettingValue('refundWindowDays', Math.round(days), req.user._id);
    res.json({ success: true, days: setting.value });
}));

// GET /api/admin/refunds — list item-level refund requests
router.get('/refunds', asyncHandler(async (req, res) => {
    const { status } = req.query; // optional filter

    const orders = await Order.find({ isPlaced: { $ne: false }, 'refundRequests.0': { $exists: true } })
        .populate('customerId', 'name email phone')
        .populate('vendorIds', 'storeName address city state pincode phone')
        .populate('refundRequests.vendorId', 'storeName address city state pincode phone')
        .lean();

    const refunds = [];
    orders.forEach((order) => {
        (order.refundRequests || []).forEach((reqItem) => {
            if (status && reqItem.status !== status) return;
            refunds.push({
                _id: reqItem._id,
                status: reqItem.status,
                reason: reqItem.reason,
                responseNote: reqItem.responseNote,
                requestedAt: reqItem.requestedAt,
                processedAt: reqItem.processedAt,
                amount: reqItem.amount,
                orderId: order._id,
                orderNumber: order.orderNumber,
                customer: order.customerId,
                deliveryAddress: order.deliveryAddress,
                product: {
                    title: reqItem.title,
                    image: reqItem.image,
                    qty: reqItem.qty,
                    price: reqItem.price,
                },
                vendor: reqItem.vendorId || order.vendorIds?.find((v) => v._id?.toString() === reqItem.vendorId?.toString()) || null,
            });
        });
    });

    refunds.sort((a, b) => new Date(b.requestedAt || 0) - new Date(a.requestedAt || 0));
    res.json({ success: true, refunds });
}));

// PUT /api/admin/refunds/:refundId — update item-level refund status
router.put('/refunds/:refundId', asyncHandler(async (req, res) => {
    const { status, responseNote } = req.body;
    const allowed = ['requested', 'approved', 'rejected', 'processed'];
    if (!allowed.includes(status)) {
        return res.status(400).json({ success: false, message: 'Invalid refund status' });
    }

    const order = await Order.findOne({ isPlaced: { $ne: false }, 'refundRequests._id': req.params.refundId });
    if (!order) return res.status(404).json({ success: false, message: 'Refund request not found' });

    const reqItem = order.refundRequests.id(req.params.refundId);
    reqItem.status = status;
    reqItem.responseNote = responseNote;
    if (status === 'processed') reqItem.processedAt = new Date();

    // Mark payment status as partial refund if any processed requests
    if (status === 'processed') {
        order.paymentStatus = 'partial_refund';
        order.refundStatus = 'processed';
    }

    await order.save();
    const io = req.app.get('io');
    if (io) {
        const payload = {
            orderId: order._id,
            type: 'refund',
            refundId: reqItem._id,
            refundStatus: status,
            itemId: reqItem.itemId,
        };
        io.emitToUser(order.customerId?.toString(), 'orderUpdate', payload);
        io.emitOrderUpdate(order._id.toString(), payload);
    }
    res.json({ success: true, refund: reqItem, orderId: order._id });
}));

// GET /api/admin/users
router.get('/users', asyncHandler(async (req, res) => {
    const { page = 1, limit = 20, role, search, from, to } = req.query;
    const query = {};
    if (role) query.role = role;
    if (search) query.$or = [{ name: { $regex: search, $options: 'i' } }, { email: { $regex: search, $options: 'i' } }];
    if (from || to) {
        query.createdAt = {};
        if (from) query.createdAt.$gte = new Date(from);
        if (to) query.createdAt.$lte = new Date(to);
    }

    const users = await User.find(query).sort({ createdAt: -1 })
        .skip((parseInt(page) - 1) * parseInt(limit)).limit(parseInt(limit)).lean();
    const total = await User.countDocuments(query);
    res.json({ success: true, users, total });
}));

// PUT /api/admin/users/:id/status
router.put('/users/:id/status', asyncHandler(async (req, res) => {
    const user = await User.findByIdAndUpdate(req.params.id, { isActive: req.body.isActive }, { new: true });
    res.json({ success: true, user });
}));

// GET /api/admin/analytics/sales-by-region
router.get('/analytics/sales-by-region', asyncHandler(async (req, res) => {
    const stats = await Order.aggregate([
        { $match: { isPlaced: { $ne: false }, paymentStatus: 'paid' } },
        { $group: { _id: '$deliveryAddress.city', total: { $sum: '$total' }, count: { $sum: 1 } } },
        { $sort: { total: -1 } }, { $limit: 20 },
    ]);
    res.json({ success: true, stats });
}));

// GET /api/admin/notifications — Fetch recently generated admin alerts
router.get('/notifications', asyncHandler(async (req, res) => {
    const { limit = 50 } = req.query;
    const notifications = await AdminNotification.find()
        .sort({ createdAt: -1 })
        .limit(parseInt(limit))
        .lean();
    
    const unreadCount = await AdminNotification.countDocuments({ isRead: false });

    res.json({ success: true, notifications, unreadCount });
}));

// PUT /api/admin/notifications/read-all
router.put('/notifications/read-all', asyncHandler(async (req, res) => {
    await AdminNotification.updateMany({ isRead: false }, { isRead: true });
    res.json({ success: true, message: 'All notifications marked as read' });
}));

// PUT /api/admin/notifications/:id/read
router.put('/notifications/:id/read', asyncHandler(async (req, res) => {
    const notification = await AdminNotification.findByIdAndUpdate(
        req.params.id,
        { isRead: true },
        { new: true }
    );
    res.json({ success: true, notification });
}));

// ──────────────────────────────────────────────────────
// RIDER MANAGEMENT
// ──────────────────────────────────────────────────────

// GET /api/admin/riders — list all riders (paginated + filter)
router.get('/riders', asyncHandler(async (req, res) => {
    const { page = 1, limit = 20, status, search } = req.query;
    const query = {};
    if (status) query.status = status;

    const pageNum = parseInt(page);
    const limitNum = Math.min(parseInt(limit), 100);

    // If search, find matching users first
    if (search) {
        const matchingUsers = await User.find({
            $or: [
                { name: { $regex: search, $options: 'i' } },
                { email: { $regex: search, $options: 'i' } },
            ],
        }).select('_id').lean();
        query.userId = { $in: matchingUsers.map((u) => u._id) };
    }

    const [riders, total] = await Promise.all([
        Rider.find(query)
            .populate('userId', 'name email mobileNumber phone avatar createdAt')
            .sort({ createdAt: -1 })
            .skip((pageNum - 1) * limitNum)
            .limit(limitNum)
            .lean(),
        Rider.countDocuments(query),
    ]);

    res.json({ success: true, riders, total, page: pageNum, pages: Math.ceil(total / limitNum) });
}));

// GET /api/admin/riders/:id — get a single rider
router.get('/riders/:id', asyncHandler(async (req, res) => {
    const rider = await Rider.findById(req.params.id)
        .populate('userId', 'name email mobileNumber phone avatar createdAt')
        .lean();
    if (!rider) return res.status(404).json({ success: false, message: 'Rider not found' });
    res.json({ success: true, rider });
}));

// PUT /api/admin/riders/:id/approve — approve or reject
router.put('/riders/:id/approve', asyncHandler(async (req, res) => {
    const { approved, rejectionReason } = req.body;
    const rider = await Rider.findById(req.params.id).populate('userId', 'name email mobileNumber');
    if (!rider) return res.status(404).json({ success: false, message: 'Rider not found' });

    rider.status = approved ? 'ACTIVE' : 'REJECTED';
    rider.rejectionReason = approved ? undefined : (rejectionReason || 'Application not approved');
    rider.approvedAt = approved ? new Date() : undefined;
    rider.approvedBy = req.user._id;
    await rider.save();

    // Notify rider via socket
    const io = req.app.get('io');
    if (io) {
        io.emitToUser(rider.userId._id.toString(), 'riderApproval', {
            status: rider.status,
            message: approved ? 'Congratulations! Your rider profile is approved. You can now go online and accept deliveries.' : (rejectionReason || 'Your rider application was not approved.'),
        });
        io.emitToAdmin('riderApproved', { riderId: rider._id, status: rider.status });
    }

    res.json({ success: true, rider, message: approved ? 'Rider approved' : 'Rider rejected' });
}));

// PUT /api/admin/riders/:id/status — activate / deactivate
router.put('/riders/:id/status', asyncHandler(async (req, res) => {
    const { isActive } = req.body;
    const rider = await Rider.findByIdAndUpdate(
        req.params.id,
        { isActive: Boolean(isActive), isOnline: isActive ? undefined : false },
        { new: true }
    ).populate('userId', 'name email');
    if (!rider) return res.status(404).json({ success: false, message: 'Rider not found' });
    res.json({ success: true, rider, message: isActive ? 'Rider activated' : 'Rider deactivated' });
}));

module.exports = router;
