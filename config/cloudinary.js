const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

const isRealValue = (val) => {
    if (!val) return false;
    const normalized = String(val).trim().toLowerCase();
    if (!normalized) return false;
    if (normalized.includes('your_') || normalized.includes('your-')) return false;
    if (normalized.includes('placeholder')) return false;
    if (normalized === '...') return false;
    return true;
};

const hasCloudinaryConfig = isRealValue(process.env.CLOUDINARY_CLOUD_NAME)
    && isRealValue(process.env.CLOUDINARY_API_KEY)
    && isRealValue(process.env.CLOUDINARY_API_SECRET);

if (hasCloudinaryConfig) {
    cloudinary.config({
        cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
        api_key: process.env.CLOUDINARY_API_KEY,
        api_secret: process.env.CLOUDINARY_API_SECRET,
    });
}

const uploadsRoot = path.join(__dirname, '..', 'uploads');
const productsDir = path.join(uploadsRoot, 'products');
const vendorsDir = path.join(uploadsRoot, 'vendors');
const avatarsDir = path.join(uploadsRoot, 'avatars');

const ensureDir = (dir) => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
};
ensureDir(productsDir);
ensureDir(vendorsDir);
ensureDir(avatarsDir);

const localDiskStorage = (destination) => multer.diskStorage({
    destination,
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname) || '.jpg';
        const name = `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext.toLowerCase()}`;
        cb(null, name);
    },
});

// Product images storage
const productStorage = hasCloudinaryConfig
    ? new CloudinaryStorage({
        cloudinary,
        params: {
            folder: 'zomitron/products',
            allowed_formats: ['jpg', 'jpeg', 'png', 'webp'],
            transformation: [
                { width: 800, height: 800, crop: 'limit', quality: 'auto:good' },
            ],
        },
    })
    : localDiskStorage(productsDir);

// Vendor/store images storage
const vendorStorage = hasCloudinaryConfig
    ? new CloudinaryStorage({
        cloudinary,
        params: {
            folder: 'zomitron/vendors',
            allowed_formats: ['jpg', 'jpeg', 'png', 'webp'],
            transformation: [
                { width: 400, height: 400, crop: 'fill', quality: 'auto:good' },
            ],
        },
    })
    : localDiskStorage(vendorsDir);

// Avatar storage
const avatarStorage = hasCloudinaryConfig
    ? new CloudinaryStorage({
        cloudinary,
        params: {
            folder: 'zomitron/avatars',
            allowed_formats: ['jpg', 'jpeg', 'png', 'webp'],
            transformation: [
                { width: 200, height: 200, crop: 'fill', quality: 'auto:good' },
            ],
        },
    })
    : localDiskStorage(avatarsDir);

const uploadProduct = multer({
    storage: productStorage,
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/')) {
            cb(null, true);
        } else {
            cb(new Error('Only image files are allowed'), false);
        }
    },
});

const uploadVendor = multer({ storage: vendorStorage, limits: { fileSize: 5 * 1024 * 1024 } });
const uploadAvatar = multer({ storage: avatarStorage, limits: { fileSize: 2 * 1024 * 1024 } });

// CSV upload (memory storage for parsing)
const csvStorage = multer.memoryStorage();
const uploadCSV = multer({
    storage: csvStorage,
    fileFilter: (req, file, cb) => {
        const allowedMimes = ['text/csv', 'application/vnd.ms-excel', 'application/csv', 'text/plain'];
        if (allowedMimes.includes(file.mimetype) || file.originalname.toLowerCase().endsWith('.csv')) {
            cb(null, true);
        } else {
            cb(new Error('Only CSV files are allowed'), false);
        }
    },
});

const toUploadUrl = (file) => {
    if (!file) return null;
    if (file.path && /^https?:\/\//i.test(file.path)) return file.path;
    if (file.filename && file.destination) {
        const relative = path.relative(path.join(__dirname, '..'), path.join(file.destination, file.filename));
        return `/${relative.replace(/\\/g, '/')}`;
    }
    if (file.path) {
        const normalized = String(file.path).replace(/\\/g, '/');
        const uploadsIdx = normalized.indexOf('/uploads/');
        if (uploadsIdx >= 0) return normalized.slice(uploadsIdx);
    }
    return null;
};

module.exports = { cloudinary, uploadProduct, uploadVendor, uploadAvatar, uploadCSV, toUploadUrl };
