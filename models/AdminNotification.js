const mongoose = require('mongoose');

const adminNotificationSchema = new mongoose.Schema(
    {
        type: {
            type: String,
            required: true,
            enum: ['new_vendor', 'new_customer', 'order_placed', 'order_cancelled', 'refund_requested', 'general'],
        },
        message: {
            type: String,
            required: true,
        },
        isRead: {
            type: Boolean,
            default: false,
        },
        link: {
            type: String, // E.g., '/admin/orders/1234' or '/admin/vendors'
        },
        relatedId: {
            type: mongoose.Schema.Types.ObjectId, // Can be OrderId, UserId, VendorId
        },
    },
    { timestamps: true }
);

adminNotificationSchema.index({ createdAt: -1 });
adminNotificationSchema.index({ isRead: 1 });

module.exports = mongoose.model('AdminNotification', adminNotificationSchema);
