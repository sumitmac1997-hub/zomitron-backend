const mongoose = require('mongoose');

const slugifyProductTitle = (value) => {
    const base = String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '');
    return base || 'product';
};

const imageAssetSchema = new mongoose.Schema(
    {
        url: {
            type: String,
            required: true,
            trim: true,
        },
        publicId: {
            type: String,
            default: '',
            trim: true,
        },
        provider: {
            type: String,
            enum: ['cloudinary', 'external', 'local'],
            default: 'cloudinary',
        },
        resourceType: {
            type: String,
            default: 'image',
        },
        width: Number,
        height: Number,
        bytes: Number,
        format: String,
    },
    { _id: false },
);

const productSchema = new mongoose.Schema(
    {
        vendorId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Vendor',
            required: true,
        },
        sourceProductId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Product',
        },
        title: {
            type: String,
            required: [true, 'Product title is required'],
            trim: true,
            maxlength: [200, 'Title cannot exceed 200 characters'],
        },
        slug: { type: String, unique: true, sparse: true, lowercase: true },
        description: {
            type: String,
            required: [true, 'Description is required'],
            maxlength: [2000, 'Description cannot exceed 2000 characters'],
        },
        shortDescription: { type: String, maxlength: [300] },
        price: {
            type: Number,
            required: [true, 'Price is required'],
            min: [0, 'Price cannot be negative'],
        },
        discountPrice: {
            type: Number,
            min: [0, 'Discount price cannot be negative'],
            validate: {
                validator: function (v) {
                    // Works for both document saves and update queries
                    if (v === null || v === undefined) return true;
                    const update = typeof this.getUpdate === 'function' ? this.getUpdate() : null;
                    const priceFromUpdate = update ? (update.$set?.price ?? update.price) : undefined;
                    const price = this.price ?? priceFromUpdate;
                    if (price === null || price === undefined) return true; // cannot compare, skip
                    return v < price;
                },
                message: 'Discount price must be less than original price',
            },
        },
        images: {
            type: [String],
            required: [true, 'At least one image is required'],
            validate: {
                validator: (v) => v.length >= 1 && v.length <= 5,
                message: 'Product must have 1-5 images',
            },
        },
        imageAssets: {
            type: [imageAssetSchema],
            default: [],
            validate: {
                validator: (value) => Array.isArray(value) && value.length <= 5,
                message: 'Product cannot store more than 5 image assets',
            },
        },
        category: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Category',
            required: true,
        },
        categories: [{
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Category',
        }],
        subCategory: { type: mongoose.Schema.Types.ObjectId, ref: 'Category' },
        categoryName: String, // Denormalized for faster queries
        tags: [String],
        stock: { type: Number, required: true, min: 0, default: 0 },
        sku: String,
        unit: { type: String, default: 'piece' }, // piece, kg, litre, etc.
        weight: Number, // in kg for shipping calculation
        manageStock: { type: Boolean, default: true },
        allowBackorders: { type: Boolean, default: false },
        soldIndividually: { type: Boolean, default: false },
        // GeoJSON Point - inherited from vendor but stored at product level for direct filtering
        location: {
            type: {
                type: String,
                enum: ['Point'],
                default: 'Point',
            },
            coordinates: {
                type: [Number], // [longitude, latitude]
                required: true,
            },
        },
        pincode: {
            type: String,
            required: true,
            match: [/^\d{6}$/, 'Pincode must be 6 digits'],
        },
        city: String,
        state: String,
        // Ratings (denormalized)
        ratings: {
            average: { type: Number, default: 0, min: 0, max: 5 },
            count: { type: Number, default: 0 },
        },
        // Attributes
        productType: { type: String, enum: ['simple', 'grouped', 'external', 'variable'], default: 'simple' },
        externalUrl: String,
        externalButtonText: String,
        attributes: [{ key: String, value: String, visible: { type: Boolean, default: true }, forVariation: { type: Boolean, default: false } }],
        variations: [{
            title: String,
            price: Number,
            discountPrice: Number,
            stock: { type: Number, default: 0 },
            sku: String,
            image: String,
            imageAsset: imageAssetSchema,
            isPrimaryImage: { type: Boolean, default: false },
            attributes: [{ key: String, value: String }],
        }],
        // Tax / Commission
        taxStatus: { type: String, default: 'taxable' }, // taxable | shipping | none
        taxClass: { type: String, default: 'standard' },
        commissionMode: { type: String, enum: ['global', 'percent', 'fixed', 'percent_fixed'], default: 'global' },
        commissionValue: { type: Number, default: 0 },
        // Status
        isActive: { type: Boolean, default: true },
        isFeatured: { type: Boolean, default: false },
        isApproved: { type: Boolean, default: true },
        // SEO
        metaTitle: String,
        metaDescription: String,
        // Stats
        viewCount: { type: Number, default: 0 },
        orderCount: { type: Number, default: 0 },
    },
    {
        timestamps: true,
        toJSON: { virtuals: true },
        toObject: { virtuals: true },
    }
);

// CRITICAL: 2dsphere geospatial index for $geoNear queries
productSchema.index({ location: '2dsphere' });
productSchema.index({ vendorId: 1, isActive: 1 });
productSchema.index({ sourceProductId: 1, vendorId: 1 });
productSchema.index({ categories: 1 });
productSchema.index({ isActive: 1, isApproved: 1, stock: 1, createdAt: -1 });
productSchema.index({ isActive: 1, isApproved: 1, stock: 1, price: 1 });
productSchema.index({ isActive: 1, isApproved: 1, stock: 1, 'ratings.average': -1 });
productSchema.index({ isFeatured: 1, isActive: 1, isApproved: 1, stock: 1 });
productSchema.index({ category: 1, isActive: 1, isApproved: 1, stock: 1, createdAt: -1 });
productSchema.index({ pincode: 1, isActive: 1, isApproved: 1, stock: 1, createdAt: -1 });
// Full-text search across key merchandising fields
productSchema.index({
    title: 'text',
    description: 'text',
    tags: 'text',
    categoryName: 'text',
    sku: 'text',
});
productSchema.index({ price: 1 });
productSchema.index({ 'ratings.average': -1 });
productSchema.index({ createdAt: -1 });

// Virtual: discount percentage
productSchema.virtual('discountPercent').get(function () {
    if (this.discountPrice && this.price) {
        return Math.round(((this.price - this.discountPrice) / this.price) * 100);
    }
    return 0;
});

// Virtual: effective price
productSchema.virtual('effectivePrice').get(function () {
    return this.discountPrice || this.price;
});

productSchema.pre('validate', function (next) {
    if (Array.isArray(this.imageAssets) && this.imageAssets.length > 0) {
        this.images = this.imageAssets
            .map((asset) => asset?.url)
            .filter(Boolean)
            .slice(0, 5);
    }

    if (Array.isArray(this.variations)) {
        this.variations = this.variations.map((variation) => {
            if (variation?.image || !variation?.imageAsset?.url) return variation;
            return {
                ...variation,
                image: variation.imageAsset.url,
            };
        });
    }

    next();
});

// Auto-generate slug
productSchema.pre('save', function (next) {
    if (this.isModified('title') && !this.slug) {
        this.slug = `${slugifyProductTitle(this.title)}-${new mongoose.Types.ObjectId().toString().slice(-8)}`;
    }
    next();
});

module.exports = mongoose.model('Product', productSchema);
