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

        // Subscribe to order updates
        socket.on('subscribeOrder', (orderId) => {
            socket.join(`order_${orderId}`);
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
    io.emitOrderUpdate = (orderId, data) => {
        io.to(`order_${orderId}`).emit('orderUpdate', data);
    };

    // Helper: emit to admin
    io.emitToAdmin = (event, data) => {
        io.to('admin_room').emit(event, data);
    };
};

module.exports = { initSocket };
