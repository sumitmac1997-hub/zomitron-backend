const express = require('express');
const router = express.Router();
const asyncHandler = require('express-async-handler');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const User = require('../models/User');
const Vendor = require('../models/Vendor');
const { generateTokens } = require('../middleware/auth');
const { sendEmail } = require('../utils/email');
const normalizeOptionalString = (value) => {
    if (value === undefined || value === null) return undefined;
    const normalized = String(value).trim();
    return normalized ? normalized : undefined;
};
const normalizeEmail = (value) => normalizeOptionalString(value)?.toLowerCase();

// POST /api/auth/register
router.post('/register', asyncHandler(async (req, res) => {
    const name = normalizeOptionalString(req.body.name);
    const email = normalizeEmail(req.body.email);
    const password = req.body.password;
    const phone = normalizeOptionalString(req.body.phone);
    const role = normalizeOptionalString(req.body.role) || 'customer';

    if (!name || !email || !password) {
        return res.status(400).json({ success: false, message: 'Name, email and password are required' });
    }
    if (role === 'admin') {
        return res.status(403).json({ success: false, message: 'Cannot register as admin' });
    }

    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) return res.status(400).json({ success: false, message: 'Email already registered' });

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const user = await User.create({
        name,
        email,
        password,
        phone,
        role,
        otp,
        otpExpiry: new Date(Date.now() + 10 * 60 * 1000), // 10 min
    });

    const { accessToken, refreshToken } = generateTokens(user._id);
    await User.findByIdAndUpdate(user._id, { refreshToken });

    void sendEmail(email, 'Verify your Zomitron account', `
    <h2>Welcome to Zomitron!</h2>
    <p>Your OTP is: <strong>${otp}</strong></p>
    <p>This OTP expires in 10 minutes.</p>
  `).catch((err) => {
        console.error(`Registration email failed for ${email}:`, err.message);
    });

    // Admin notification should never block registration response.
    const { notifyAdmin } = require('../utils/adminNotificationEngine');
    void notifyAdmin(req.app.get('io'), {
        type: 'new_customer',
        message: `New user joined: ${user.name}`,
        link: '/admin/users',
        relatedId: user._id
    });

    res.status(201).json({
        success: true,
        emailQueued: true,
        message: 'Registration successful. Your verification email should arrive shortly.',
        token: accessToken,
        user: { _id: user._id, name: user.name, email: user.email, role: user.role, isVerified: user.isVerified },
    });
}));

// POST /api/auth/login
router.post('/login', asyncHandler(async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ success: false, message: 'Email and password are required' });

    const user = await User.findOne({ email: email.toLowerCase() }).select('+password');
    if (!user || !user.password) return res.status(401).json({ success: false, message: 'Invalid credentials' });
    if (!user.isActive) return res.status(403).json({ success: false, message: 'Account is deactivated' });

    const isMatch = await user.comparePassword(password);
    if (!isMatch) return res.status(401).json({ success: false, message: 'Invalid credentials' });

    const { accessToken, refreshToken } = generateTokens(user._id);
    user.refreshToken = refreshToken;
    user.lastLogin = new Date();
    await user.save({ validateBeforeSave: false });

    // Attach vendor info if relevant
    let vendorInfo = null;
    if (user.role === 'vendor') {
        vendorInfo = await Vendor.findOne({ userId: user._id }).select('_id storeName approved');
    }

    res.json({
        success: true,
        token: accessToken,
        refreshToken,
        user: {
            _id: user._id, name: user.name, email: user.email,
            role: user.role, avatar: user.avatar, isVerified: user.isVerified,
            wishlist: user.wishlist || [],
            vendor: vendorInfo,
        },
    });
}));

// POST /api/auth/verify-otp
router.post('/verify-otp', asyncHandler(async (req, res) => {
    const { email, otp } = req.body;
    const user = await User.findOne({ email: email?.toLowerCase() });
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    if (user.otp !== otp) return res.status(400).json({ success: false, message: 'Invalid OTP' });
    if (new Date() > user.otpExpiry) return res.status(400).json({ success: false, message: 'OTP has expired' });

    user.isVerified = true;
    user.otp = undefined;
    user.otpExpiry = undefined;
    await user.save({ validateBeforeSave: false });

    res.json({ success: true, message: 'Email verified successfully' });
}));

// POST /api/auth/send-otp
router.post('/send-otp', asyncHandler(async (req, res) => {
    const { email } = req.body;
    const user = await User.findOne({ email: email?.toLowerCase() });
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    user.otp = otp;
    user.otpExpiry = new Date(Date.now() + 10 * 60 * 1000);
    await user.save({ validateBeforeSave: false });

    await sendEmail(email, 'Zomitron OTP', `<p>Your OTP: <strong>${otp}</strong> (valid 10 min)</p>`);
    res.json({ success: true, message: 'OTP sent to your email' });
}));

// POST /api/auth/refresh-token
router.post('/refresh-token', asyncHandler(async (req, res) => {
    const { refreshToken } = req.body;
    if (!refreshToken) return res.status(400).json({ success: false, message: 'Refresh token required' });

    try {
        const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET);
        const user = await User.findById(decoded.id);
        if (!user || user.refreshToken !== refreshToken) {
            return res.status(401).json({ success: false, message: 'Invalid refresh token' });
        }
        const { accessToken, refreshToken: newRefresh } = generateTokens(user._id);
        user.refreshToken = newRefresh;
        await user.save({ validateBeforeSave: false });
        res.json({ success: true, token: accessToken, refreshToken: newRefresh });
    } catch {
        res.status(401).json({ success: false, message: 'Invalid refresh token' });
    }
}));

// POST /api/auth/forgot-password
router.post('/forgot-password', asyncHandler(async (req, res) => {
    const { email } = req.body;
    const user = await User.findOne({ email: email?.toLowerCase() });
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const resetToken = crypto.randomBytes(32).toString('hex');
    user.otp = resetToken;
    user.otpExpiry = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
    await user.save({ validateBeforeSave: false });

    const clientUrl = (process.env.CLIENT_URL || 'http://localhost:5173').replace(/\/+$/, '');
    const resetUrl = `${clientUrl}/reset-password?token=${encodeURIComponent(resetToken)}&email=${encodeURIComponent(user.email)}`;
    await sendEmail(email, 'Reset your Zomitron password', `
    <h2>Password Reset Request</h2>
    <p>Click below to reset your password (valid 1 hour):</p>
    <a href="${resetUrl}" style="background:#f97316;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;">Reset Password</a>
  `);
    res.json({ success: true, message: 'Password reset link sent to your email' });
}));

// POST /api/auth/reset-password
router.post('/reset-password', asyncHandler(async (req, res) => {
    const { email, token, password } = req.body;
    if (!password || String(password).length < 6) {
        return res.status(400).json({ success: false, message: 'Password must be at least 6 characters' });
    }

    const user = await User.findOne({ email: email?.toLowerCase() });
    if (!user || user.otp !== token || new Date() > user.otpExpiry) {
        return res.status(400).json({ success: false, message: 'Invalid or expired reset token' });
    }
    user.password = password;
    user.otp = undefined;
    user.otpExpiry = undefined;
    await user.save();
    res.json({ success: true, message: 'Password reset successfully' });
}));

// GET /api/auth/me
router.get('/me', require('../middleware/auth').protect, asyncHandler(async (req, res) => {
    const user = await User.findById(req.user._id);
    let vendorInfo = null;
    if (user.role === 'vendor') {
        vendorInfo = await Vendor.findOne({ userId: user._id });
    }
    res.json({ success: true, user: { ...user.toJSON(), vendor: vendorInfo } });
}));

// POST /api/auth/google (Google OAuth token from frontend)
router.post('/google', asyncHandler(async (req, res) => {
    const { googleId, email, name, avatar } = req.body;
    if (!googleId || !email) return res.status(400).json({ success: false, message: 'Google auth data required' });

    let user = await User.findOne({ $or: [{ googleId }, { email: email.toLowerCase() }] });
    if (!user) {
        user = await User.create({ name, email: email.toLowerCase(), googleId, avatar, role: 'customer', isVerified: true });
    } else if (!user.googleId) {
        user.googleId = googleId;
        user.isVerified = true;
        await user.save({ validateBeforeSave: false });
    }

    const { accessToken, refreshToken } = generateTokens(user._id);
    user.refreshToken = refreshToken;
    user.lastLogin = new Date();
    await user.save({ validateBeforeSave: false });

    res.json({
        success: true, token: accessToken, refreshToken,
        user: { _id: user._id, name: user.name, email: user.email, role: user.role, avatar: user.avatar, wishlist: user.wishlist || [] },
    });
}));

// PUT /api/auth/update-profile
router.put('/update-profile', require('../middleware/auth').protect, asyncHandler(async (req, res) => {
    const { name, phone, addresses, fcmToken } = req.body;
    const updates = {};
    if (name) updates.name = name;
    if (phone) updates.phone = phone;
    if (addresses) updates.addresses = addresses;
    if (fcmToken) updates.fcmToken = fcmToken;

    const user = await User.findByIdAndUpdate(req.user._id, updates, { new: true, runValidators: true });
    res.json({ success: true, user });
}));

// POST /api/auth/change-password
router.post('/change-password', require('../middleware/auth').protect, asyncHandler(async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
        return res.status(400).json({ success: false, message: 'Current password and new password are required' });
    }
    if (String(newPassword).length < 6) {
        return res.status(400).json({ success: false, message: 'New password must be at least 6 characters' });
    }
    if (currentPassword === newPassword) {
        return res.status(400).json({ success: false, message: 'New password must be different from current password' });
    }

    const user = await User.findById(req.user._id).select('+password');
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    if (!user.password) {
        return res.status(400).json({ success: false, message: 'Password login is not enabled for this account' });
    }

    const isMatch = await user.comparePassword(currentPassword);
    if (!isMatch) {
        return res.status(400).json({ success: false, message: 'Current password is incorrect' });
    }

    user.password = newPassword;
    await user.save();

    res.json({ success: true, message: 'Password changed successfully' });
}));

// POST /api/auth/fcm-token
router.post('/fcm-token', require('../middleware/auth').protect, asyncHandler(async (req, res) => {
    const { fcmToken } = req.body;
    await User.findByIdAndUpdate(req.user._id, { fcmToken });
    res.json({ success: true, message: 'FCM token updated' });
}));

module.exports = router;
