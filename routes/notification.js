const express = require('express');
const router = express.Router();
const asyncHandler = require('express-async-handler');
const { protect } = require('../middleware/auth');
const { getLocationFromIP, getRealIP } = require('../utils/ipGeolocation');

let admin;
try {
    admin = require('firebase-admin');
    if (!admin.apps.length && process.env.FIREBASE_PROJECT_ID) {
        admin.initializeApp({
            credential: admin.credential.cert({
                projectId: process.env.FIREBASE_PROJECT_ID,
                privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
                clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            }),
        });
    }
} catch { admin = null; }

let twilio;
try {
    if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
        twilio = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    }
} catch { twilio = null; }

// POST /api/notifications/push — Send FCM push notification
router.post('/push', protect, asyncHandler(async (req, res) => {
    const { userId, title, body, data } = req.body;
    if (!admin) return res.status(503).json({ success: false, message: 'Firebase not configured' });

    const User = require('../models/User');
    const user = await User.findById(userId).select('fcmToken');
    if (!user?.fcmToken) return res.status(400).json({ success: false, message: 'User has no FCM token' });

    await admin.messaging().send({
        token: user.fcmToken,
        notification: { title, body },
        data: data || {},
        android: { priority: 'high' },
        apns: { headers: { 'apns-priority': '10' } },
    });

    res.json({ success: true, message: 'Push notification sent' });
}));

// POST /api/notifications/whatsapp — Send WhatsApp notification via Twilio
router.post('/whatsapp', asyncHandler(async (req, res) => {
    const { to, message } = req.body;
    if (!twilio) return res.status(503).json({ success: false, message: 'WhatsApp not configured' });

    await twilio.messages.create({
        from: process.env.TWILIO_WHATSAPP_FROM,
        to: `whatsapp:${to}`,
        body: message,
    });

    res.json({ success: true, message: 'WhatsApp message sent' });
}));

// GET /api/notifications/detect-location — IP-based location detection
router.get('/detect-location', asyncHandler(async (req, res) => {
    const ip = getRealIP(req);
    const location = await getLocationFromIP(ip);
    res.json({ success: true, location });
}));

module.exports = router;
