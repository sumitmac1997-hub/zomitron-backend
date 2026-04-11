const Rider = require('../models/Rider');
const Order = require('../models/Order');
const Vendor = require('../models/Vendor');

// Haversine distance in km between two [lat, lng] points
const haversineKm = (lat1, lng1, lat2, lng2) => {
    const R = 6371;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLng = ((lng2 - lng1) * Math.PI) / 180;
    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos((lat1 * Math.PI) / 180) *
        Math.cos((lat2 * Math.PI) / 180) *
        Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

/**
 * Auto-assign the nearest available rider to an order.
 * Called from the order route when order status → confirmed.
 * @param {object} io - Socket.io server instance
 * @param {object} order - Mongoose Order document (with deliveryAddress)
 * @param {object} vendorLocation - { lat, lng } of the vendor
 */
const autoAssignRider = async (io, order, vendorLocation) => {
    try {
        // Find all ACTIVE + ONLINE riders with no current active order
        const availableRiders = await Rider.find({
            status: 'ACTIVE',
            isOnline: true,
            isActive: true,
            activeOrderId: null,
            'location.lat': { $ne: null },
            'location.lng': { $ne: null },
        }).populate('userId', 'name phone mobileNumber');

        if (!availableRiders.length) {
            console.log(`[AutoAssign] No available riders for order ${order._id}`);
            io.emitToAdmin('noRiderAvailable', { orderId: order._id, orderNumber: order.orderNumber });
            return;
        }

        // Sort by distance to vendor
        const refLat = vendorLocation?.lat || order.deliveryAddress?.lat;
        const refLng = vendorLocation?.lng || order.deliveryAddress?.lng;

        const sorted = availableRiders
            .filter((r) => r.location.lat && r.location.lng)
            .map((r) => ({
                rider: r,
                distance: haversineKm(refLat, refLng, r.location.lat, r.location.lng),
            }))
            .sort((a, b) => a.distance - b.distance);

        if (!sorted.length) {
            io.emitToAdmin('noRiderAvailable', { orderId: order._id, orderNumber: order.orderNumber });
            return;
        }

        // ── Fetch vendor info in an ISOLATED try/catch ──────────────────────────
        // A failure here must NEVER prevent rider notifications from being sent
        let vendorInfo = null;
        try {
            if (order.vendorIds && order.vendorIds.length > 0) {
                const v = await Vendor.findById(order.vendorIds[0])
                    .select('storeName address city state phone location')
                    .lean();
                if (v) {
                    const coords = v.location?.coordinates;
                    // address is an embedded object: { line1, line2, city, state, pincode }
                    // Build a safe string for display
                    const addrObj = v.address || {};
                    const addrStr = [addrObj.line1, addrObj.city, addrObj.state]
                        .filter(Boolean).join(', ');
                    vendorInfo = {
                        storeName: v.storeName || 'Vendor Store',
                        address: addrStr || v.city || '',
                        city: addrObj.city || v.city || '',
                        phone: v.phone || '',
                        lat: vendorLocation?.lat ?? (coords ? coords[1] : null),
                        lng: vendorLocation?.lng ?? (coords ? coords[0] : null),
                    };
                }
            }
        } catch (vendorErr) {
            console.warn('[AutoAssign] Vendor lookup failed (non-fatal):', vendorErr.message);
        }

        // Fallback: use the vendorLocation already passed in
        if (!vendorInfo && vendorLocation) {
            vendorInfo = { storeName: 'Vendor Store', lat: vendorLocation.lat, lng: vendorLocation.lng, address: '', phone: '' };
        }
        // ── End vendor lookup ────────────────────────────────────────────────────

        // Try riders one by one with 60-second timeout
        const tryNextRider = async (index) => {
            if (index >= sorted.length) {
                console.log(`[AutoAssign] All riders declined for order ${order._id}`);
                io.emitToAdmin('noRiderAvailable', { orderId: order._id, orderNumber: order.orderNumber });
                return;
            }

            const { rider, distance } = sorted[index];
            console.log(`[AutoAssign] Offering order ${order._id} to rider ${rider._id} (${distance.toFixed(2)}km away)`);

            // Emit the delivery request to the specific rider
            io.emitToRider(rider._id.toString(), 'newDeliveryRequest', {
                orderId: order._id,
                orderNumber: order.orderNumber,
                vendorAddress: vendorInfo,        // full pickup details (safe string address)
                deliveryAddress: order.deliveryAddress,
                items: order.items,
                total: order.total,
                distance: parseFloat(distance.toFixed(2)),
                timeoutSeconds: 60,
            });

            // 60-second timeout — if rider doesn't respond, try next
            const timer = setTimeout(async () => {
                const freshOrder = await Order.findById(order._id).lean();
                if (freshOrder && freshOrder.assignedRiderId) return; // already accepted
                io.emitToRider(rider._id.toString(), 'deliveryRequestExpired', { orderId: order._id });
                tryNextRider(index + 1);
            }, 60000);

            if (!io._riderTimers) io._riderTimers = new Map();
            io._riderTimers.set(`${order._id}_${rider._id}`, timer);
        };

        tryNextRider(0);
    } catch (err) {
        console.error('[AutoAssign] Fatal error:', err.message);
    }
};

const initSocket = (io) => {
    // Store connected users (userId → socketId)
    const connectedUsers = new Map();

    io.on('connection', (socket) => {
        console.log(`🔌 New socket connection: ${socket.id}`);

        // User joins with their userId
        socket.on('join', (userId) => {
            connectedUsers.set(userId, socket.id);
            socket.join(`user_${userId}`);
            console.log(`👤 User ${userId} joined with socket ${socket.id}`);
        });

        // Vendor joins their room
        socket.on('joinVendor', (vendorId) => {
            socket.join(`vendor_${vendorId}`);
            console.log(`🏪 Vendor ${vendorId} joined room`);
        });

        // Admin joins admin room
        socket.on('joinAdmin', () => {
            socket.join('admin_room');
            console.log(`👑 Admin joined admin room`);
        });

        // Rider joins their personal room
        socket.on('joinRider', (riderId) => {
            socket.join(`rider_${riderId}`);
            console.log(`🚴 Rider ${riderId} joined room`);
        });

        // Subscribe to order updates
        socket.on('subscribeOrder', (orderId) => {
            socket.join(`order_${orderId}`);
        });

        socket.on('unsubscribeOrder', (orderId) => {
            socket.leave(`order_${orderId}`);
        });

        // Rider broadcasts live location update
        socket.on('riderLocationUpdate', async ({ riderId, lat, lng }) => {
            try {
                await Rider.findByIdAndUpdate(riderId, {
                    'location.lat': lat,
                    'location.lng': lng,
                    'location.updatedAt': new Date(),
                    'currentLocation.coordinates': [lng, lat],
                });
                // Broadcast to admin
                io.emitToAdmin('riderLocation', { riderId, lat, lng, ts: Date.now() });
            } catch (err) {
                console.error('[Socket] riderLocationUpdate error:', err.message);
            }
        });

        socket.on('disconnect', () => {
            // Clean up
            for (const [userId, socketId] of connectedUsers.entries()) {
                if (socketId === socket.id) {
                    connectedUsers.delete(userId);
                    break;
                }
            }
            console.log(`🔌 Socket disconnected: ${socket.id}`);
        });
    });

    // Helper: emit to specific user
    io.emitToUser = (userId, event, data) => {
        io.to(`user_${userId}`).emit(event, data);
    };

    // Helper: emit to vendor
    io.emitToVendor = (vendorId, event, data) => {
        io.to(`vendor_${vendorId}`).emit(event, data);
    };

    // Helper: emit order update
    io.emitOrderUpdate = (orderId, data = {}) => {
        io.to(`order_${orderId}`).emit('orderUpdate', { orderId, ...data });
    };

    // Helper: emit to admin
    io.emitToAdmin = (event, data) => {
        io.to('admin_room').emit(event, data);
    };

    // Helper: emit to specific rider
    io.emitToRider = (riderId, event, data) => {
        io.to(`rider_${riderId}`).emit(event, data);
    };
};

module.exports = { initSocket, autoAssignRider, haversineKm };
