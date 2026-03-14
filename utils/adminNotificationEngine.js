const AdminNotification = require('../models/AdminNotification');

const notifyAdmin = async (io, payload) => {
    try {
        const { type, message, link, relatedId } = payload;
        
        // Save to DB
        const notification = await AdminNotification.create({
            type,
            message,
            link,
            relatedId
        });

        // Count unread
        const unreadCount = await AdminNotification.countDocuments({ isRead: false });

        // Emit via WebSocket to all users in 'admin_room'
        if (io) {
            io.to('admin_room').emit('adminNotification', {
                notification,
                unreadCount
            });
        }
        
        return notification;
    } catch (err) {
        console.error('Error generating admin notification:', err);
    }
};

module.exports = { notifyAdmin };
