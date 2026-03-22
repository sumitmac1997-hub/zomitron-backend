const jwt = require('jsonwebtoken');
const asyncHandler = require('express-async-handler');
const User = require('../models/User');

const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_change_me';
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || JWT_SECRET;
const getBearerToken = (req) => {
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
        return req.headers.authorization.split(' ')[1];
    }
    return req.cookies?.token || null;
};

// Verify JWT and attach user to request
const protect = asyncHandler(async (req, res, next) => {
    const token = getBearerToken(req);

    if (!token) {
        return res.status(401).json({ success: false, message: 'Not authorized, token missing' });
    }

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = await User.findById(decoded.id)
            .select('-password -otp -otpExpiry -refreshToken')
            .lean();
        if (!req.user) {
            return res.status(401).json({ success: false, message: 'User not found' });
        }
        if (!req.user.isActive) {
            return res.status(403).json({ success: false, message: 'Account has been deactivated' });
        }
        next();
    } catch (error) {
        return res.status(401).json({ success: false, message: 'Invalid or expired token' });
    }
});

// Role-based authorization
const authorize = (...roles) => {
    return (req, res, next) => {
        if (!roles.includes(req.user.role)) {
            return res.status(403).json({
                success: false,
                message: `Access denied. Required role: ${roles.join(' or ')}`,
            });
        }
        next();
    };
};

// Optional auth (doesn't fail if no token)
const optionalAuth = asyncHandler(async (req, res, next) => {
    const token = getBearerToken(req);
    if (token) {
        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            req.user = await User.findById(decoded.id).select('-password').lean();
            if (req.user && req.user.isActive === false) {
                req.user = null;
            }
        } catch {
            req.user = null;
        }
    }
    next();
});

// Generate JWT tokens
const generateTokens = (userId) => {
    const accessToken = jwt.sign({ id: userId }, JWT_SECRET, {
        expiresIn: process.env.JWT_EXPIRE || '7d',
    });
    const refreshToken = jwt.sign({ id: userId }, JWT_REFRESH_SECRET, {
        expiresIn: process.env.JWT_REFRESH_EXPIRE || '30d',
    });
    return { accessToken, refreshToken };
};

module.exports = { protect, authorize, optionalAuth, generateTokens };
