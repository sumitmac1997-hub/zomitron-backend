const mongoose = require('mongoose');
const Order = require('../models/Order');
const Product = require('../models/Product');
const Vendor = require('../models/Vendor');
const Coupon = require('../models/Coupon');
const User = require('../models/User');
const ShippingRule = require('../models/ShippingRule');
const { haversineDistance } = require('./haversine');
const { getDeliveryInfo, getEstimatedDeliveryDate } = require('./deliveryETA');
const { calculateMultiVendorPayouts } = require('./commission');
const { calculateShippingQuote } = require('./shippingRules');
const { getSettingValue } = require('./settings');

const MAX_ORDER_ITEMS = Number(process.env.MAX_ORDER_ITEMS) || 25;
const VALID_PAYMENT_METHODS = new Set(['stripe', 'razorpay', 'paypal', 'cod']);

const clean = (value) => (value ?? '').toString().trim();
const normalizeEmail = (value) => clean(value).toLowerCase();
const isValidEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || ''));
const isValidIndianPhone = (value) => {
    const digits = String(value || '').replace(/\D/g, '');
    return digits.length === 10 || (digits.length === 12 && digits.startsWith('91'));
};
const isValidPincode = (value) => /^\d{6}$/.test(String(value || ''));

const createHttpError = (statusCode, message) => {
    const error = new Error(message);
    error.statusCode = statusCode;
    return error;
};

const normalizeOrderItems = (items) => {
    if (!Array.isArray(items) || items.length === 0) {
        throw createHttpError(400, 'No items in order');
    }

    if (items.length > MAX_ORDER_ITEMS) {
        throw createHttpError(400, `Order cannot contain more than ${MAX_ORDER_ITEMS} distinct line items`);
    }

    const mergedItems = new Map();

    for (const rawItem of items) {
        const productId = clean(rawItem?.productId);
        const qty = Number.parseInt(rawItem?.qty, 10);

        if (!productId || !Number.isInteger(qty) || qty <= 0) {
            throw createHttpError(400, 'Each order item must include a valid productId and positive qty');
        }

        mergedItems.set(productId, (mergedItems.get(productId) || 0) + qty);
    }

    return Array.from(mergedItems.entries()).map(([productId, qty]) => ({ productId, qty }));
};

const normalizeDeliveryAddress = (deliveryAddress, orderEmail, fallbackPhone) => {
    if (!deliveryAddress || typeof deliveryAddress !== 'object') {
        throw createHttpError(400, 'Delivery address required');
    }

    const normalizedAddress = {
        name: clean(deliveryAddress.name),
        email: normalizeEmail(deliveryAddress.email || orderEmail),
        phone: clean(deliveryAddress.phone || fallbackPhone),
        line1: clean(deliveryAddress.line1),
        line2: clean(deliveryAddress.line2),
        city: clean(deliveryAddress.city),
        state: clean(deliveryAddress.state),
        pincode: clean(deliveryAddress.pincode),
        lat: deliveryAddress.lat === undefined || deliveryAddress.lat === '' ? undefined : Number(deliveryAddress.lat),
        lng: deliveryAddress.lng === undefined || deliveryAddress.lng === '' ? undefined : Number(deliveryAddress.lng),
    };

    if (!normalizedAddress.line1 || !normalizedAddress.city || !normalizedAddress.state || !isValidPincode(normalizedAddress.pincode)) {
        throw createHttpError(400, 'Delivery address must include line1, city, state, and a valid 6-digit pincode');
    }

    if (!normalizedAddress.email || !isValidEmail(normalizedAddress.email)) {
        throw createHttpError(400, 'A valid order email is required');
    }

    if (!normalizedAddress.phone || !isValidIndianPhone(normalizedAddress.phone)) {
        throw createHttpError(400, 'A valid phone number is required for delivery');
    }

    if ((normalizedAddress.lat !== undefined && !Number.isFinite(normalizedAddress.lat))
        || (normalizedAddress.lng !== undefined && !Number.isFinite(normalizedAddress.lng))) {
        throw createHttpError(400, 'Latitude and longitude must be valid numbers');
    }

    return normalizedAddress;
};

const buildOrderItems = (normalizedItems, productsById) => {
    const orderItems = [];
    let subtotal = 0;

    for (const item of normalizedItems) {
        const product = productsById.get(item.productId);
        if (!product || !product.isActive) {
            throw createHttpError(404, `Product ${item.productId} not found`);
        }

        if (product.stock < item.qty) {
            throw createHttpError(409, `Product ${item.productId} has insufficient stock`);
        }

        const price = product.discountPrice || product.price;
        orderItems.push({
            productId: product._id,
            vendorId: product.vendorId,
            title: product.title,
            image: product.images?.[0],
            price,
            qty: item.qty,
            subtotal: price * item.qty,
        });
        subtotal += price * item.qty;
    }

    return { orderItems, subtotal };
};

const isTransactionUnsupportedError = (error) => /Transaction numbers are only allowed on a replica set member or mongos|does not support transactions|replica set/i.test(error?.message || '');

const toInventoryItems = (orderItems = []) => orderItems.map((item) => ({
    productId: item.productId,
    qty: item.qty,
}));

const buildReserveStockOps = (orderItems, includeOrderCount = false) => orderItems.map((item) => ({
    updateOne: {
        filter: {
            _id: item.productId,
            isActive: true,
            stock: { $gte: item.qty },
        },
        update: {
            $inc: {
                stock: -item.qty,
                ...(includeOrderCount ? { orderCount: item.qty } : {}),
            },
        },
    },
}));

const buildRestoreStockOps = (orderItems, includeOrderCount = false) => orderItems.map((item) => ({
    updateOne: {
        filter: { _id: item.productId },
        update: {
            $inc: {
                stock: item.qty,
                ...(includeOrderCount ? { orderCount: -item.qty } : {}),
            },
        },
    },
}));

const buildOrderCountOps = (orderItems) => orderItems.map((item) => ({
    updateOne: {
        filter: { _id: item.productId },
        update: { $inc: { orderCount: item.qty } },
    },
}));

const reserveStockWithoutTransaction = async (orderItems, { includeOrderCount = false } = {}) => {
    const reserved = [];

    const rollback = async () => {
        if (reserved.length === 0) return;
        await Product.bulkWrite(buildRestoreStockOps(reserved, includeOrderCount), { ordered: false });
    };

    for (const item of orderItems) {
        const updatedProduct = await Product.findOneAndUpdate(
            {
                _id: item.productId,
                isActive: true,
                stock: { $gte: item.qty },
            },
            {
                $inc: {
                    stock: -item.qty,
                    ...(includeOrderCount ? { orderCount: item.qty } : {}),
                },
            },
            { new: true },
        );

        if (!updatedProduct) {
            await rollback();
            throw createHttpError(409, `Product ${item.productId} became unavailable during checkout`);
        }

        reserved.push({ productId: item.productId, qty: item.qty });
    }

    return rollback;
};

const syncAddressToUser = async (userId, deliveryAddress, session) => {
    if (!userId) return null;

    const user = session
        ? await User.findById(userId).session(session)
        : await User.findById(userId);

    if (!user) return null;

    const addresses = Array.isArray(user.addresses) ? user.addresses : [];
    const addressExists = addresses.some((addr) => (
        clean(addr.line1).toLowerCase() === deliveryAddress.line1.toLowerCase()
        && clean(addr.city).toLowerCase() === deliveryAddress.city.toLowerCase()
        && clean(addr.pincode) === deliveryAddress.pincode
    ));

    if (addressExists) {
        return user.toObject();
    }

    user.addresses.push({
        label: 'Saved Address',
        line1: deliveryAddress.line1,
        line2: deliveryAddress.line2 || '',
        city: deliveryAddress.city,
        state: deliveryAddress.state,
        pincode: deliveryAddress.pincode,
        lat: deliveryAddress.lat,
        lng: deliveryAddress.lng,
        isDefault: addresses.length === 0,
    });

    await user.save({ session, validateBeforeSave: false });
    return user.toObject();
};

const incrementCouponUsage = async ({ couponCode, customerId, session }) => {
    if (!couponCode) return;

    await Coupon.updateOne(
        { code: clean(couponCode).toUpperCase() },
        {
            $inc: { usedCount: 1 },
            ...(customerId ? { $addToSet: { usedBy: customerId } } : {}),
        },
        session ? { session } : undefined,
    );
};

const notifyOrderPlaced = async ({ app, order, includePaymentSuccess = false }) => {
    const io = app?.get?.('io');
    if (io) {
        (order.vendorIds || []).forEach((vendorId) => {
            io.emitToVendor(vendorId.toString(), 'newOrder', {
                orderId: order._id,
                orderNumber: order.orderNumber,
            });
        });

        if (includePaymentSuccess && order.customerId) {
            io.emitToUser(order.customerId.toString(), 'paymentSuccess', { orderId: order._id });
        }
    }

    const { notifyAdmin } = require('./adminNotificationEngine');
    await notifyAdmin(io, {
        type: 'order_placed',
        message: `New Order Placed: #${order.orderNumber} (₹${order.total})`,
        link: '/admin/dashboard',
        relatedId: order._id,
    });
};

const prepareOrderDraft = async ({ user, body }) => {
    const { items, deliveryAddress, paymentMethod, couponCode, guestEmail, guestPhone } = body;
    const normalizedItems = normalizeOrderItems(items);
    const orderEmail = normalizeEmail(guestEmail || user?.email);

    if (!user && !orderEmail) {
        throw createHttpError(400, 'Login or provide guest email');
    }

    const paymentMethodValue = clean(paymentMethod || 'cod').toLowerCase();
    if (!VALID_PAYMENT_METHODS.has(paymentMethodValue)) {
        throw createHttpError(400, 'Invalid payment method');
    }

    const normalizedAddress = normalizeDeliveryAddress(deliveryAddress, orderEmail, guestPhone);
    const productIds = normalizedItems.map((item) => item.productId);
    const products = await Product.find({ _id: { $in: productIds } })
        .select('_id vendorId title images price discountPrice stock isActive')
        .lean();

    if (products.length !== productIds.length) {
        throw createHttpError(404, 'One or more products were not found');
    }

    const productsById = new Map(products.map((product) => [String(product._id), product]));
    const { orderItems, subtotal } = buildOrderItems(normalizedItems, productsById);
    const vendorIdArray = [...new Set(orderItems.map((item) => String(item.vendorId)))];

    const [vendors, coupon, ruleList, refundWindowDays] = await Promise.all([
        Vendor.find({ _id: { $in: vendorIdArray } }).select('_id commissionRate city location').lean(),
        couponCode ? Coupon.findOne({ code: clean(couponCode).toUpperCase(), isActive: true }) : Promise.resolve(null),
        ShippingRule.find({ isActive: true }).sort({ updatedAt: -1 }).lean(),
        getSettingValue('refundWindowDays', 5),
    ]);

    if (vendors.length !== vendorIdArray.length) {
        throw createHttpError(400, 'One or more vendors for this order are unavailable');
    }

    const commissionRates = Object.fromEntries(vendors.map((vendor) => [String(vendor._id), vendor.commissionRate]));

    let deliveryDistance = 0;
    let deliveryInfo = { eta: '3-5 days', etaLabel: 'Standard Delivery', deliveryCharge: 0 };
    if (normalizedAddress.lat !== undefined && normalizedAddress.lng !== undefined && vendors[0]?.location?.coordinates) {
        const [vendorLng, vendorLat] = vendors[0].location.coordinates;
        deliveryDistance = haversineDistance(normalizedAddress.lat, normalizedAddress.lng, vendorLat, vendorLng);
        deliveryInfo = getDeliveryInfo(deliveryDistance);
    }

    let discount = 0;
    if (coupon) {
        const validation = coupon.validateCoupon(user?._id, subtotal);
        if (validation.valid) {
            discount = coupon.calculateDiscount(subtotal);
        }
    }

    const { platformTotal, vendorPayouts } = calculateMultiVendorPayouts(orderItems, commissionRates);

    const shippingQuote = calculateShippingQuote({
        city: normalizedAddress.city,
        pincode: normalizedAddress.pincode,
        subtotal,
        discount,
    }, ruleList);

    if (!shippingQuote.serviceAvailable) {
        throw createHttpError(
            422,
            shippingQuote.message || 'Delivery is not available at your location. Please use a supported city and pincode.',
        );
    }

    const total = Math.max(0, subtotal - discount + shippingQuote.shippingCharge);

    return {
        paymentMethodValue,
        deliveryInfo,
        shippingQuote,
        orderPayload: {
            customerId: user?._id || null,
            guestEmail: orderEmail,
            guestPhone: normalizedAddress.phone,
            items: orderItems,
            vendorIds: vendorIdArray,
            subtotal,
            platformFee: platformTotal,
            deliveryCharge: shippingQuote.shippingCharge,
            discount,
            total,
            vendorPayouts,
            couponCode: clean(couponCode).toUpperCase() || undefined,
            paymentMethod: paymentMethodValue,
            paymentStatus: 'pending',
            deliveryAddress: normalizedAddress,
            deliveryETA: deliveryInfo.eta,
            estimatedDelivery: getEstimatedDeliveryDate(deliveryDistance),
            deliveryDistance,
            shippingRule: {
                ruleId: shippingQuote.ruleId,
                city: shippingQuote.city || normalizedAddress.city,
                freeShippingThreshold: shippingQuote.freeShippingThreshold,
                baseShippingCharge: shippingQuote.baseShippingCharge,
                appliedCharge: shippingQuote.shippingCharge,
                matchingMode: shippingQuote.matchingMode,
                pincodeRangesText: shippingQuote.pincodeRangesText,
            },
            vendorFulfillments: vendorIdArray.map((vendorId) => ({ vendorId, status: 'pending' })),
            refundWindowDays: Number(refundWindowDays) || 5,
            isPlaced: false,
            stockReserved: false,
        },
    };
};

const createOrderDraft = async ({ orderPayload, reserveStock = false }) => {
    let order = null;
    const session = await mongoose.startSession();

    try {
        let transactionSupported = true;

        try {
            await session.withTransaction(async () => {
                [order] = await Order.create([orderPayload], { session });

                if (reserveStock) {
                    const stockResult = await Product.bulkWrite(
                        buildReserveStockOps(toInventoryItems(orderPayload.items), false),
                        { session, ordered: true },
                    );

                    if (stockResult.modifiedCount !== orderPayload.items.length) {
                        throw createHttpError(409, 'One or more items became unavailable during checkout');
                    }

                    order.stockReserved = true;
                    await order.save({ session, validateBeforeSave: false });
                }
            });
        } catch (error) {
            if (!isTransactionUnsupportedError(error)) {
                throw error;
            }
            transactionSupported = false;
        }

        if (!transactionSupported) {
            order = await Order.create(orderPayload);

            if (reserveStock) {
                let rollbackStock = null;
                try {
                    rollbackStock = await reserveStockWithoutTransaction(toInventoryItems(order.items), { includeOrderCount: false });
                    order.stockReserved = true;
                    await order.save({ validateBeforeSave: false });
                } catch (error) {
                    if (rollbackStock) {
                        await rollbackStock().catch(() => null);
                    }
                    await Order.findByIdAndDelete(order._id).catch(() => null);
                    throw error;
                }
            }
        }

        return order;
    } finally {
        await session.endSession();
    }
};

const finalizeOrderPlacement = async ({
    orderId,
    app,
    markPaid = false,
    razorpayPaymentId = null,
}) => {
    let order = null;
    let updatedUser = null;
    let justPlaced = false;
    const session = await mongoose.startSession();

    try {
        let transactionSupported = true;

        try {
            await session.withTransaction(async () => {
                order = await Order.findById(orderId).session(session);
                if (!order) {
                    throw createHttpError(404, 'Order not found');
                }

                if (order.isPlaced !== false) {
                    return;
                }

                const inventoryItems = toInventoryItems(order.items);

                if (order.stockReserved) {
                    await Product.bulkWrite(buildOrderCountOps(inventoryItems), { session, ordered: false });
                } else {
                    const stockResult = await Product.bulkWrite(buildReserveStockOps(inventoryItems, true), { session, ordered: true });
                    if (stockResult.modifiedCount !== inventoryItems.length) {
                        throw createHttpError(409, 'One or more items became unavailable during checkout');
                    }
                    order.stockReserved = true;
                }

                updatedUser = await syncAddressToUser(order.customerId, order.deliveryAddress, session);
                await Promise.all([
                    incrementCouponUsage({ couponCode: order.couponCode, customerId: order.customerId, session }),
                    Vendor.updateMany(
                        { _id: { $in: order.vendorIds } },
                        { $inc: { totalOrders: 1 } },
                        { session },
                    ),
                ]);

                order.isPlaced = true;
                order.placedAt = order.placedAt || new Date();

                if (markPaid) {
                    order.paymentStatus = 'paid';
                    order.orderStatus = 'confirmed';
                    order.confirmedAt = order.confirmedAt || new Date();
                    if (razorpayPaymentId) {
                        order.razorpayPaymentId = razorpayPaymentId;
                    }
                }

                justPlaced = true;
                await order.save({ session, validateBeforeSave: false });
            });
        } catch (error) {
            if (!isTransactionUnsupportedError(error)) {
                throw error;
            }
            transactionSupported = false;
        }

        if (!transactionSupported) {
            order = await Order.findById(orderId);
            if (!order) {
                throw createHttpError(404, 'Order not found');
            }

            if (order.isPlaced === false) {
                const inventoryItems = toInventoryItems(order.items);
                let rollbackInventory = null;

                if (order.stockReserved) {
                    await Product.bulkWrite(buildOrderCountOps(inventoryItems), { ordered: false });
                } else {
                    rollbackInventory = await reserveStockWithoutTransaction(inventoryItems, { includeOrderCount: true });
                    order.stockReserved = true;
                }

                try {
                    updatedUser = await syncAddressToUser(order.customerId, order.deliveryAddress);
                    await Promise.all([
                        incrementCouponUsage({ couponCode: order.couponCode, customerId: order.customerId }),
                        Vendor.updateMany(
                            { _id: { $in: order.vendorIds } },
                            { $inc: { totalOrders: 1 } },
                        ),
                    ]);

                    order.isPlaced = true;
                    order.placedAt = order.placedAt || new Date();

                    if (markPaid) {
                        order.paymentStatus = 'paid';
                        order.orderStatus = 'confirmed';
                        order.confirmedAt = order.confirmedAt || new Date();
                        if (razorpayPaymentId) {
                            order.razorpayPaymentId = razorpayPaymentId;
                        }
                    }

                    justPlaced = true;
                    await order.save({ validateBeforeSave: false });
                } catch (error) {
                    if (rollbackInventory) {
                        await rollbackInventory();
                    }
                    throw error;
                }
            }
        }
    } finally {
        await session.endSession();
    }

    if (justPlaced) {
        await notifyOrderPlaced({ app, order, includePaymentSuccess: markPaid });
    }

    return { order, updatedUser, justPlaced };
};

const abortOrderDraft = async ({ orderId, reason }) => {
    let order = null;
    const session = await mongoose.startSession();

    try {
        let transactionSupported = true;

        try {
            await session.withTransaction(async () => {
                order = await Order.findById(orderId).session(session);
                if (!order || order.isPlaced !== false) {
                    return;
                }

                if (order.stockReserved) {
                    await Product.bulkWrite(buildRestoreStockOps(toInventoryItems(order.items), false), { session, ordered: false });
                    order.stockReserved = false;
                }

                order.paymentStatus = 'failed';
                order.orderStatus = 'cancelled';
                order.cancelledAt = order.cancelledAt || new Date();
                if (reason) {
                    order.cancellationReason = reason;
                }

                await order.save({ session, validateBeforeSave: false });
            });
        } catch (error) {
            if (!isTransactionUnsupportedError(error)) {
                throw error;
            }
            transactionSupported = false;
        }

        if (!transactionSupported) {
            order = await Order.findById(orderId);
            if (!order || order.isPlaced !== false) {
                return order;
            }

            if (order.stockReserved) {
                await Product.bulkWrite(buildRestoreStockOps(toInventoryItems(order.items), false), { ordered: false });
                order.stockReserved = false;
            }

            order.paymentStatus = 'failed';
            order.orderStatus = 'cancelled';
            order.cancelledAt = order.cancelledAt || new Date();
            if (reason) {
                order.cancellationReason = reason;
            }

            await order.save({ validateBeforeSave: false });
        }

        return order;
    } finally {
        await session.endSession();
    }
};

module.exports = {
    VALID_PAYMENT_METHODS,
    createHttpError,
    prepareOrderDraft,
    createOrderDraft,
    finalizeOrderPlacement,
    abortOrderDraft,
};
