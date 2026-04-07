const multer = require('multer');
const path = require('path');

const MAX_PRODUCT_IMAGE_COUNT = 5;
const MAX_PRODUCT_IMAGE_SIZE_BYTES = 2 * 1024 * 1024;
const MAX_VARIATION_IMAGE_COUNT = 30;
const ALLOWED_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp']);

const productImageUpload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: MAX_PRODUCT_IMAGE_SIZE_BYTES,
    },
    fileFilter: (req, file, cb) => {
        const extension = path.extname(file.originalname || '').toLowerCase();
        const mimeType = String(file.mimetype || '').toLowerCase();

        if (ALLOWED_MIME_TYPES.has(mimeType) || ALLOWED_EXTENSIONS.has(extension)) {
            cb(null, true);
            return;
        }

        cb(new Error('Only JPG, JPEG, PNG, and WEBP images are allowed.'), false);
    },
});

const handleProductUploadError = (error, res) => {
    if (error instanceof multer.MulterError) {
        if (error.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).json({
                success: false,
                message: 'Each image must be 2MB or smaller.',
            });
        }

        if (error.code === 'LIMIT_UNEXPECTED_FILE') {
            return res.status(400).json({
                success: false,
                message: 'Too many images were uploaded for this product.',
            });
        }
    }

    return res.status(400).json({
        success: false,
        message: error.message || 'Image upload failed.',
    });
};

const parseProductImageUpload = (req, res, next) => productImageUpload.fields([
    { name: 'images', maxCount: MAX_PRODUCT_IMAGE_COUNT },
    { name: 'variationImages', maxCount: MAX_VARIATION_IMAGE_COUNT },
])(req, res, (error) => {
    if (error) {
        handleProductUploadError(error, res);
        return;
    }
    next();
});

module.exports = {
    ALLOWED_MIME_TYPES,
    MAX_PRODUCT_IMAGE_COUNT,
    MAX_PRODUCT_IMAGE_SIZE_BYTES,
    MAX_VARIATION_IMAGE_COUNT,
    parseProductImageUpload,
};
