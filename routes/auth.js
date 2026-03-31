const express = require('express');
const asyncHandler = require('express-async-handler');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const User = require('../models/User');
const Vendor = require('../models/Vendor');
const { protect, generateTokens } = require('../middleware/auth');
const { sendEmail } = require('../utils/email');
const { isFirebaseAdminConfigured, verifyFirebaseIdToken } = require('../config/firebaseAdmin');
const { normalizeIndianMobileNumber } = require('../utils/mobileNumber');

const router = express.Router();

const normalizeOptionalString = (value) => {
    if (value === undefined || value === null) return undefined;
    const normalized = String(value).trim();
    return normalized ? normalized : undefined;
};

const normalizeEmail = (value) => normalizeOptionalString(value)?.toLowerCase();

const normalizeMobileInput = (value) => normalizeIndianMobileNumber(normalizeOptionalString(value));

const findUserByMobileNumber = (mobileNumber) => User.findOne({
    $or: [{ mobileNumber }, { phone: mobileNumber }],
});

const buildSessionPayload = async (user) => {
    let vendorInfo = null;
    if (user.role === 'vendor') {
        vendorInfo = await Vendor.findOne({ userId: user._id }).select('_id storeName approved');
    }

    return {
        ...user.toJSON(),
        vendor: vendorInfo,
    };
};

const issueSession = async (user) => {
    const { accessToken, refreshToken } = generateTokens(user._id);
    user.refreshToken = refreshToken;
    user.lastLogin = new Date();
    await user.save({ validateBeforeSave: false });

    return {
        success: true,
        token: accessToken,
        refreshToken,
        user: await buildSessionPayload(user),
    };
};

const mergeMobileAuthProvider = (currentProvider) => {
    switch (currentProvider) {
    case 'google':
        return 'google+mobile';
    case 'local':
        return 'local+mobile';
    case 'mobile':
    case 'local+mobile':
    case 'google+mobile':
        return currentProvider;
    default:
        return 'mobile';
    }
};

const createDefaultMobileName = (mobileNumber) => `User ${mobileNumber.slice(-4)}`;
const shouldUseProvidedMobileName = (currentName, mobileNumber) => {
    const normalizedName = normalizeOptionalString(currentName);
    if (!normalizedName) return true;
    return normalizedName === createDefaultMobileName(mobileNumber);
};
const mergeLocalAuthProvider = (currentProvider) => {
    switch (currentProvider) {
    case 'mobile':
        return 'local+mobile';
    case 'local':
    case 'local+mobile':
    case 'google':
    case 'google+mobile':
        return currentProvider;
    default:
        return 'local';
    }
};

// POST /api/auth/register
router.post('/register', asyncHandler(async (req, res) => {
    const name = normalizeOptionalString(req.body.name);
    const email = normalizeEmail(req.body.email);
    const password = req.body.password;
    const mobileNumber = normalizeMobileInput(req.body.mobileNumber ?? req.body.phone);
    const role = normalizeOptionalString(req.body.role) || 'customer';

    if (!name || !email || !password || !mobileNumber) {
        return res.status(400).json({
            success: false,
            message: 'Name, email, password and mobile number are required',
        });
    }

    if (role === 'admin') {
        return res.status(403).json({ success: false, message: 'Cannot register as admin' });
    }

    const existingByEmail = await User.findOne({ email });
    if (existingByEmail) {
        return res.status(400).json({ success: false, message: 'Email already registered' });
    }

    let user = await findUserByMobileNumber(mobileNumber).select('+password');
    if (user) {
        if (!user.isActive) {
            return res.status(403).json({ success: false, message: 'Account is deactivated' });
        }

        if (user.email) {
            return res.status(400).json({ success: false, message: 'Mobile number already registered' });
        }

        user.name = name;
        user.email = email;
        user.password = password;
        user.mobileNumber = mobileNumber;
        user.phone = mobileNumber;
        user.role = role;
        user.authProvider = mergeLocalAuthProvider(user.authProvider);
        user.otp = Math.floor(100000 + Math.random() * 900000).toString();
        user.otpExpiry = new Date(Date.now() + 10 * 60 * 1000);
        await user.save();
    } else {
        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        user = await User.create({
            name,
            email,
            password,
            mobileNumber,
            phone: mobileNumber,
            role,
            authProvider: 'local',
            otp,
            otpExpiry: new Date(Date.now() + 10 * 60 * 1000),
        });
    }

    const session = await issueSession(user);

    void sendEmail(email, 'Verify your Zomitron account', `
    <h2>Welcome to Zomitron!</h2>
    <p>Your OTP is: <strong>${user.otp}</strong></p>
    <p>This OTP expires in 10 minutes.</p>
  `).catch((err) => {
        console.error(`Registration email failed for ${email}:`, err.message);
    });

    const { notifyAdmin } = require('../utils/adminNotificationEngine');
    void notifyAdmin(req.app.get('io'), {
        type: 'new_customer',
        message: `New user joined: ${user.name}`,
        link: '/admin/users',
        relatedId: user._id,
    });

    res.status(201).json({
        ...session,
        emailQueued: true,
        message: 'Registration successful. Your verification email should arrive shortly.',
    });
}));

// POST /api/auth/login
router.post('/login', asyncHandler(async (req, res) => {
    const email = normalizeEmail(req.body.email);
    const password = req.body.password;

    if (!email || !password) {
        return res.status(400).json({ success: false, message: 'Email and password are required' });
    }

    const user = await User.findOne({ email }).select('+password');
    if (!user || !user.password) {
        return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }
    if (!user.isActive) {
        return res.status(403).json({ success: false, message: 'Account is deactivated' });
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
        return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    res.json(await issueSession(user));
}));

// POST /api/auth/mobile-login
router.post('/mobile-login', asyncHandler(async (req, res) => {
    const name = normalizeOptionalString(req.body.name);
    const mobileNumber = normalizeMobileInput(req.body.mobileNumber ?? req.body.phone);
    const firebaseIdToken = normalizeOptionalString(
        req.body.firebaseIdToken ?? req.body.idToken ?? req.body.token
    );
    const firebaseUid = normalizeOptionalString(req.body.firebaseUid);

    if (!mobileNumber || !firebaseIdToken) {
        return res.status(400).json({
            success: false,
            message: 'Mobile number and Firebase ID token are required',
        });
    }

    if (!isFirebaseAdminConfigured()) {
        return res.status(500).json({
            success: false,
            message: 'Firebase phone authentication is not configured on the server',
        });
    }

    let decodedToken;
    try {
        decodedToken = await verifyFirebaseIdToken(firebaseIdToken);
    } catch (error) {
        return res.status(401).json({
            success: false,
            message: 'Invalid or expired Firebase token',
        });
    }

    const verifiedMobileNumber = normalizeMobileInput(decodedToken.phone_number);
    if (!decodedToken.uid || !verifiedMobileNumber) {
        return res.status(401).json({
            success: false,
            message: 'Firebase token is not valid for phone authentication',
        });
    }

    if (firebaseUid && firebaseUid !== decodedToken.uid) {
        return res.status(401).json({
            success: false,
            message: 'Firebase UID does not match the provided token',
        });
    }

    if (verifiedMobileNumber !== mobileNumber) {
        return res.status(401).json({
            success: false,
            message: 'Verified mobile number does not match the request',
        });
    }

    let user = await findUserByMobileNumber(mobileNumber);

    if (!user) {
        if (!name) {
            return res.status(400).json({
                success: false,
                message: 'Name is required for first-time mobile OTP login',
            });
        }

        user = await User.create({
            name,
            mobileNumber,
            phone: mobileNumber,
            authProvider: 'mobile',
            firebaseUid: decodedToken.uid,
            isVerified: true,
            role: 'customer',
        });
    } else {
        if (!user.isActive) {
            return res.status(403).json({ success: false, message: 'Account is deactivated' });
        }

        user.mobileNumber = mobileNumber;
        user.phone = mobileNumber;
        user.firebaseUid = decodedToken.uid;
        user.authProvider = mergeMobileAuthProvider(user.authProvider);
        if (name && shouldUseProvidedMobileName(user.name, mobileNumber)) {
            user.name = name;
        } else if (!user.name) {
            user.name = createDefaultMobileName(mobileNumber);
        }
    }

    res.json(await issueSession(user));
}));

// POST /api/auth/verify-otp
router.post('/verify-otp', asyncHandler(async (req, res) => {
    const email = normalizeEmail(req.body.email);
    const otp = normalizeOptionalString(req.body.otp);

    const user = await User.findOne({ email });
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
    const email = normalizeEmail(req.body.email);
    const user = await User.findOne({ email });
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
    const refreshToken = normalizeOptionalString(req.body.refreshToken);
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
    const email = normalizeEmail(req.body.email);
    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const resetToken = crypto.randomBytes(32).toString('hex');
    user.otp = resetToken;
    user.otpExpiry = new Date(Date.now() + 60 * 60 * 1000);
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
    const email = normalizeEmail(req.body.email);
    const token = normalizeOptionalString(req.body.token);
    const password = req.body.password;

    if (!password || String(password).length < 6) {
        return res.status(400).json({ success: false, message: 'Password must be at least 6 characters' });
    }

    const user = await User.findOne({ email });
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
router.get('/me', protect, asyncHandler(async (req, res) => {
    const user = await User.findById(req.user._id);
    let vendorInfo = null;
    if (user.role === 'vendor') {
        vendorInfo = await Vendor.findOne({ userId: user._id });
    }
    res.json({ success: true, user: { ...user.toJSON(), vendor: vendorInfo } });
}));

// POST /api/auth/google
router.post('/google', asyncHandler(async (req, res) => {
    const googleId = normalizeOptionalString(req.body.googleId);
    const email = normalizeEmail(req.body.email);
    const name = normalizeOptionalString(req.body.name);
    const avatar = normalizeOptionalString(req.body.avatar);

    if (!googleId || !email) {
        return res.status(400).json({ success: false, message: 'Google auth data required' });
    }

    let user = await User.findOne({ $or: [{ googleId }, { email }] });
    if (!user) {
        user = await User.create({
            name: name || email.split('@')[0],
            email,
            googleId,
            avatar,
            role: 'customer',
            isVerified: true,
            authProvider: 'google',
        });
    } else if (!user.googleId) {
        user.googleId = googleId;
        user.isVerified = true;
        if (user.authProvider === 'mobile') {
            user.authProvider = 'google+mobile';
        } else if (!user.authProvider) {
            user.authProvider = 'google';
        }
        await user.save({ validateBeforeSave: false });
    }

    res.json(await issueSession(user));
}));

// PUT /api/auth/update-profile
router.put('/update-profile', protect, asyncHandler(async (req, res) => {
    const name = normalizeOptionalString(req.body.name);
    const addresses = req.body.addresses;
    const fcmToken = normalizeOptionalString(req.body.fcmToken);
    const requestedMobileNumber = req.body.mobileNumber ?? req.body.phone;
    const hasMobileUpdate = requestedMobileNumber !== undefined;
    const mobileNumber = hasMobileUpdate ? normalizeMobileInput(requestedMobileNumber) : undefined;

    if (hasMobileUpdate && !mobileNumber) {
        return res.status(400).json({ success: false, message: 'Invalid mobile number' });
    }

    if (mobileNumber) {
        const existingUser = await User.findOne({
            _id: { $ne: req.user._id },
            $or: [{ mobileNumber }, { phone: mobileNumber }],
        });
        if (existingUser) {
            return res.status(400).json({ success: false, message: 'Mobile number already registered' });
        }
    }

    const updates = {};
    if (name) updates.name = name;
    if (mobileNumber) {
        updates.mobileNumber = mobileNumber;
        updates.phone = mobileNumber;
    }
    if (addresses) updates.addresses = addresses;
    if (fcmToken) updates.fcmToken = fcmToken;

    const user = await User.findByIdAndUpdate(req.user._id, updates, {
        new: true,
        runValidators: true,
    });
    res.json({ success: true, user });
}));

// POST /api/auth/change-password
router.post('/change-password', protect, asyncHandler(async (req, res) => {
    const currentPassword = req.body.currentPassword;
    const newPassword = req.body.newPassword;

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
router.post('/fcm-token', protect, asyncHandler(async (req, res) => {
    const fcmToken = normalizeOptionalString(req.body.fcmToken);
    await User.findByIdAndUpdate(req.user._id, { fcmToken });
    res.json({ success: true, message: 'FCM token updated' });
}));

module.exports = router;
