const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { normalizeIndianMobileNumber, isValidIndianMobileNumber } = require('../utils/mobileNumber');

const AUTH_PROVIDERS = ['local', 'google', 'mobile', 'local+mobile', 'google+mobile'];

const userSchema = new mongoose.Schema(
    {
        name: {
            type: String,
            required: [true, 'Name is required'],
            trim: true,
            maxlength: [50, 'Name cannot exceed 50 characters'],
        },
        email: {
            type: String,
            unique: true,
            sparse: true,
            lowercase: true,
            trim: true,
            match: [/^\S+@\S+\.\S+$/, 'Invalid email format'],
        },
        password: {
            type: String,
            minlength: [6, 'Password must be at least 6 characters'],
            select: false,
        },
        mobileNumber: {
            type: String,
            unique: true,
            sparse: true,
            validate: {
                validator: (value) => value === undefined || value === null || value === '' || isValidIndianMobileNumber(value),
                message: 'Invalid Indian mobile number',
            },
        },
        phone: {
            type: String,
            validate: {
                validator: (value) => value === undefined || value === null || value === '' || isValidIndianMobileNumber(value),
                message: 'Invalid Indian phone number',
            },
        },
        role: {
            type: String,
            enum: ['customer', 'vendor', 'admin'],
            default: 'customer',
        },
        authProvider: {
            type: String,
            enum: AUTH_PROVIDERS,
            default: 'local',
        },
        googleId: String,
        firebaseUid: {
            type: String,
            index: true,
            sparse: true,
        },
        avatar: {
            type: String,
            default: 'https://res.cloudinary.com/zomitron/image/upload/v1/avatars/default-avatar.png',
        },
        isVerified: { type: Boolean, default: false },
        otp: String,
        otpExpiry: Date,
        fcmToken: String, // Firebase push notification token
        refreshToken: String,
        wishlist: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Product' }],
        addresses: [
            {
                label: String,
                line1: String,
                line2: String,
                city: String,
                state: String,
                pincode: {
                    type: String,
                    match: [/^\d{6}$/, 'Pincode must be 6 digits'],
                },
                lat: Number,
                lng: Number,
                isDefault: { type: Boolean, default: false },
            },
        ],
        isActive: { type: Boolean, default: true },
        lastLogin: Date,
    },
    { timestamps: true }
);

userSchema.pre('validate', function (next) {
    if (this.email) {
        this.email = String(this.email).trim().toLowerCase();
    }

    const normalizedMobile = normalizeIndianMobileNumber(this.mobileNumber ?? this.phone);
    if (normalizedMobile) {
        this.mobileNumber = normalizedMobile;
        this.phone = normalizedMobile;
    } else {
        if (this.mobileNumber !== undefined && this.mobileNumber !== null && this.mobileNumber !== '') {
            this.invalidate('mobileNumber', 'Invalid Indian mobile number');
        }
        if (this.phone !== undefined && this.phone !== null && this.phone !== '') {
            this.invalidate('phone', 'Invalid Indian phone number');
        }
    }

    next();
});

// Hash password before saving
userSchema.pre('save', async function (next) {
    if (!this.isModified('password') || !this.password) return next();
    this.password = await bcrypt.hash(this.password, 12);
    next();
});

// Compare password
userSchema.methods.comparePassword = async function (candidatePassword) {
    return bcrypt.compare(candidatePassword, this.password);
};

// Remove sensitive fields from JSON output
userSchema.methods.toJSON = function () {
    const obj = this.toObject();
    if (!obj.mobileNumber && obj.phone) obj.mobileNumber = obj.phone;
    if (!obj.phone && obj.mobileNumber) obj.phone = obj.mobileNumber;
    delete obj.password;
    delete obj.otp;
    delete obj.otpExpiry;
    delete obj.refreshToken;
    return obj;
};

userSchema.statics.AUTH_PROVIDERS = AUTH_PROVIDERS;

module.exports = mongoose.model('User', userSchema);
