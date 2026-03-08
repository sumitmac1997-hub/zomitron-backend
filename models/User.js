const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

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
            required: [true, 'Email is required'],
            unique: true,
            lowercase: true,
            trim: true,
            match: [/^\S+@\S+\.\S+$/, 'Invalid email format'],
        },
        password: {
            type: String,
            minlength: [6, 'Password must be at least 6 characters'],
            select: false,
        },
        phone: {
            type: String,
            match: [/^[6-9]\d{9}$/, 'Invalid Indian phone number'],
        },
        role: {
            type: String,
            enum: ['customer', 'vendor', 'admin'],
            default: 'customer',
        },
        googleId: String,
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
    delete obj.password;
    delete obj.otp;
    delete obj.otpExpiry;
    delete obj.refreshToken;
    return obj;
};

module.exports = mongoose.model('User', userSchema);
