const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

const IMAGE_MIME_TO_EXTENSION = {
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
};

const PRODUCT_IMAGE_ALLOWED_FORMATS = ['jpg', 'jpeg', 'png', 'webp'];
const PRODUCT_IMAGE_TRANSFORMATION = {
    width: 1600,
    height: 1600,
    crop: 'limit',
    quality: 'auto:good',
    fetch_format: 'auto',
};

const isRealValue = (value) => {
    if (!value) return false;
    const normalized = String(value).trim().toLowerCase();
    if (!normalized) return false;
    if (normalized.includes('your_') || normalized.includes('your-')) return false;
    if (normalized.includes('placeholder')) return false;
    if (normalized === '...') return false;
    return true;
};

const parseCloudinaryUrl = (value) => {
    const normalized = String(value || '').trim();
    if (!normalized) return null;

    try {
        const parsed = new URL(normalized);
        const cloudName = parsed.hostname;
        const apiKey = decodeURIComponent(parsed.username || '');
        const apiSecret = decodeURIComponent(parsed.password || '');

        if (!cloudName || !apiKey || !apiSecret) return null;

        return { cloudName, apiKey, apiSecret };
    } catch (error) {
        return null;
    }
};

const cloudinaryUrlConfig = parseCloudinaryUrl(process.env.CLOUDINARY_URL);
const cloudinaryCloudName = isRealValue(process.env.CLOUDINARY_CLOUD_NAME)
    ? process.env.CLOUDINARY_CLOUD_NAME
    : cloudinaryUrlConfig?.cloudName;
const cloudinaryApiKey = isRealValue(process.env.CLOUDINARY_API_KEY)
    ? process.env.CLOUDINARY_API_KEY
    : cloudinaryUrlConfig?.apiKey;
const cloudinaryApiSecret = isRealValue(process.env.CLOUDINARY_API_SECRET)
    ? process.env.CLOUDINARY_API_SECRET
    : cloudinaryUrlConfig?.apiSecret;

const hasCloudinaryConfig = isRealValue(cloudinaryCloudName)
    && isRealValue(cloudinaryApiKey)
    && isRealValue(cloudinaryApiSecret);

if (hasCloudinaryConfig) {
    cloudinary.config({
        cloud_name: cloudinaryCloudName,
        api_key: cloudinaryApiKey,
        api_secret: cloudinaryApiSecret,
    });
}

const uploadsRoot = path.join(__dirname, '..', 'uploads');
const productsDir = path.join(uploadsRoot, 'products');
const vendorsDir = path.join(uploadsRoot, 'vendors');
const avatarsDir = path.join(uploadsRoot, 'avatars');

const ensureDir = (dir) => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
};

[uploadsRoot, productsDir, vendorsDir, avatarsDir].forEach(ensureDir);

const sanitizePathSegment = (value, fallback = 'asset') => {
    const sanitized = String(value || '')
        .trim()
        .replace(/[^a-zA-Z0-9_-]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/(^-|-$)/g, '');
    return sanitized || fallback;
};

const normalizeFolderPath = (folder, fallback = 'misc') => {
    const segments = String(folder || fallback)
        .split('/')
        .map((segment) => sanitizePathSegment(segment))
        .filter(Boolean);

    return path.posix.join(...(segments.length > 0 ? segments : [fallback]));
};

const sanitizePublicId = (value, fallback = 'image') => sanitizePathSegment(value, fallback).toLowerCase();

const localDiskStorage = (destination) => multer.diskStorage({
    destination,
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname) || '.jpg';
        const name = `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext.toLowerCase()}`;
        cb(null, name);
    },
});

const isAllowedImageFile = (file) => {
    const mime = String(file?.mimetype || '').toLowerCase();
    const extension = path.extname(file?.originalname || '').toLowerCase();
    return Boolean(IMAGE_MIME_TO_EXTENSION[mime] || PRODUCT_IMAGE_ALLOWED_FORMATS.includes(extension.replace('.', '')));
};

const imageFileFilter = (req, file, cb) => {
    if (isAllowedImageFile(file)) {
        cb(null, true);
        return;
    }
    cb(new Error('Only JPG, JPEG, PNG, and WEBP images are allowed.'), false);
};

const productStorage = hasCloudinaryConfig
    ? new CloudinaryStorage({
        cloudinary,
        params: {
            folder: 'zomitron/products',
            allowed_formats: PRODUCT_IMAGE_ALLOWED_FORMATS,
            transformation: [PRODUCT_IMAGE_TRANSFORMATION],
        },
    })
    : localDiskStorage(productsDir);

const vendorStorage = hasCloudinaryConfig
    ? new CloudinaryStorage({
        cloudinary,
        params: {
            folder: 'zomitron/vendors',
            allowed_formats: PRODUCT_IMAGE_ALLOWED_FORMATS,
            transformation: [
                { width: 400, height: 400, crop: 'fill', quality: 'auto:good', fetch_format: 'auto' },
            ],
        },
    })
    : localDiskStorage(vendorsDir);

const avatarStorage = hasCloudinaryConfig
    ? new CloudinaryStorage({
        cloudinary,
        params: {
            folder: 'zomitron/avatars',
            allowed_formats: PRODUCT_IMAGE_ALLOWED_FORMATS,
            transformation: [
                { width: 200, height: 200, crop: 'fill', quality: 'auto:good', fetch_format: 'auto' },
            ],
        },
    })
    : localDiskStorage(avatarsDir);

const uploadProduct = multer({
    storage: productStorage,
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: imageFileFilter,
});

const uploadVendor = multer({
    storage: vendorStorage,
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: imageFileFilter,
});

const uploadAvatar = multer({
    storage: avatarStorage,
    limits: { fileSize: 2 * 1024 * 1024 },
    fileFilter: imageFileFilter,
});

const csvStorage = multer.memoryStorage();
const uploadCSV = multer({
    storage: csvStorage,
    fileFilter: (req, file, cb) => {
        const allowedMimes = ['text/csv', 'application/vnd.ms-excel', 'application/csv', 'text/plain'];
        if (allowedMimes.includes(file.mimetype) || file.originalname.toLowerCase().endsWith('.csv')) {
            cb(null, true);
            return;
        }
        cb(new Error('Only CSV files are allowed.'), false);
    },
});

const inferAssetProvider = (url) => {
    const normalized = String(url || '');
    if (normalized.includes('res.cloudinary.com')) return 'cloudinary';
    if (normalized.startsWith('/uploads/')) return 'local';
    return 'external';
};

const buildOptimizedImageUrl = (publicId) => {
    if (!publicId || !hasCloudinaryConfig) return '';
    return cloudinary.url(publicId, {
        secure: true,
        ...PRODUCT_IMAGE_TRANSFORMATION,
    });
};

const toUploadUrl = (file) => {
    if (!file) return null;
    if (file.path && /^https?:\/\//i.test(file.path)) return file.path;
    if (file.secure_url) return file.secure_url;
    if (file.filename && file.destination) {
        const relative = path.relative(path.join(__dirname, '..'), path.join(file.destination, file.filename));
        return `/${relative.replace(/\\/g, '/')}`;
    }
    if (file.path) {
        const normalized = String(file.path).replace(/\\/g, '/');
        const uploadsIndex = normalized.indexOf('/uploads/');
        if (uploadsIndex >= 0) return normalized.slice(uploadsIndex);
    }
    return null;
};

const createImageAsset = (source) => {
    if (!source) return null;
    if (typeof source === 'string') {
        const url = source.trim();
        if (!url) return null;
        return {
            url,
            publicId: '',
            provider: inferAssetProvider(url),
            resourceType: 'image',
        };
    }

    const url = source.deliveryUrl || source.url || source.secure_url || toUploadUrl(source);
    if (!url) return null;

    return {
        url,
        publicId: source.public_id || source.publicId || '',
        provider: source.provider || (source.public_id ? 'cloudinary' : inferAssetProvider(url)),
        resourceType: source.resource_type || source.resourceType || 'image',
        width: source.width,
        height: source.height,
        bytes: source.bytes,
        format: source.format,
    };
};

const uploadBufferImage = async ({
    buffer,
    folder,
    publicIdPrefix = 'image',
    mimetype,
    resourceType = 'image',
    context,
    requireCloudinary = false,
}) => {
    if (!buffer) {
        throw new Error('Cannot upload an empty image buffer.');
    }

    if (requireCloudinary && !hasCloudinaryConfig) {
        const configurationError = new Error('Cloudinary product image uploads are not configured on the server.');
        configurationError.statusCode = 500;
        throw configurationError;
    }

    const normalizedFolder = normalizeFolderPath(folder, 'products');
    const normalizedPublicId = `${sanitizePublicId(publicIdPrefix)}-${Date.now()}-${Math.round(Math.random() * 1e6)}`;

    if (hasCloudinaryConfig) {
        return new Promise((resolve, reject) => {
            const stream = cloudinary.uploader.upload_stream(
                {
                    folder: normalizedFolder,
                    public_id: normalizedPublicId,
                    resource_type: resourceType,
                    overwrite: false,
                    invalidate: true,
                    transformation: [PRODUCT_IMAGE_TRANSFORMATION],
                    context,
                    allowed_formats: PRODUCT_IMAGE_ALLOWED_FORMATS,
                },
                (error, result) => {
                    if (error) {
                        reject(error);
                        return;
                    }

                    resolve({
                        ...result,
                        deliveryUrl: buildOptimizedImageUrl(result.public_id) || result.secure_url,
                    });
                },
            );

            stream.end(buffer);
        });
    }

    const extension = IMAGE_MIME_TO_EXTENSION[String(mimetype || '').toLowerCase()] || '.jpg';
    const localRelativeFolder = path.posix.join('uploads', normalizedFolder);
    const absoluteFolder = path.join(__dirname, '..', localRelativeFolder);
    ensureDir(absoluteFolder);

    const filename = `${normalizedPublicId}${extension}`;
    const absolutePath = path.join(absoluteFolder, filename);
    await fs.promises.writeFile(absolutePath, buffer);

    return {
        url: `/${path.posix.join(localRelativeFolder, filename)}`,
        secure_url: `/${path.posix.join(localRelativeFolder, filename)}`,
        deliveryUrl: `/${path.posix.join(localRelativeFolder, filename)}`,
        public_id: '',
        resource_type: resourceType,
        bytes: buffer.length,
        format: extension.replace('.', ''),
    };
};

const deleteStoredImageAsset = async (asset) => {
    const normalizedAsset = typeof asset === 'string'
        ? { publicId: asset, provider: 'cloudinary', resourceType: 'image' }
        : asset;

    if (!normalizedAsset) return null;

    if (normalizedAsset.publicId && hasCloudinaryConfig) {
        return cloudinary.uploader.destroy(normalizedAsset.publicId, {
            resource_type: normalizedAsset.resourceType || 'image',
            invalidate: true,
        });
    }

    const url = normalizedAsset.url || normalizedAsset.secure_url || '';
    if (!url.startsWith('/uploads/')) return null;

    const absolutePath = path.join(__dirname, '..', url.replace(/^\/+/, ''));
    try {
        await fs.promises.unlink(absolutePath);
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
    return null;
};

const createSignedUploadSignature = (paramsToSign = {}) => {
    if (!hasCloudinaryConfig) {
        throw new Error('Cloudinary is not configured.');
    }

    const timestamp = paramsToSign.timestamp || Math.floor(Date.now() / 1000);
    const payload = { ...paramsToSign, timestamp };
    const signature = cloudinary.utils.api_sign_request(payload, cloudinaryApiSecret);

    return {
        timestamp,
        signature,
        apiKey: cloudinaryApiKey,
        cloudName: cloudinaryCloudName,
    };
};

module.exports = {
    PRODUCT_IMAGE_ALLOWED_FORMATS,
    PRODUCT_IMAGE_TRANSFORMATION,
    cloudinary,
    createImageAsset,
    createSignedUploadSignature,
    deleteStoredImageAsset,
    hasCloudinaryConfig,
    uploadAvatar,
    uploadBufferImage,
    uploadCSV,
    uploadProduct,
    uploadVendor,
    toUploadUrl,
};
