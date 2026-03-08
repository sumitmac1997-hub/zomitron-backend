const mongoose = require('mongoose');

const categorySchema = new mongoose.Schema(
    {
        name: {
            type: String,
            required: [true, 'Category name is required'],
            trim: true,
            unique: true,
        },
        slug: { type: String, unique: true, lowercase: true },
        description: { type: String, maxlength: 500 },
        icon: String, // Emoji or icon class
        themeColor: {
            type: String,
            default: '#3b82f6',
            match: [/^#([0-9A-Fa-f]{6})$/, 'Theme color must be a valid 6-digit hex value'],
        },
        image: String, // Cloudinary URL
        parent: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Category',
            default: null,
        },
        isActive: { type: Boolean, default: true },
        sortOrder: { type: Number, default: 0 },
        productCount: { type: Number, default: 0 },
        metaTitle: String,
        metaDescription: String,
    },
    { timestamps: true }
);

categorySchema.pre('save', function (next) {
    if (this.isModified('name') && !this.slug) {
        this.slug = this.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    }
    next();
});

categorySchema.index({ parent: 1 });
categorySchema.index({ slug: 1 });

module.exports = mongoose.model('Category', categorySchema);
