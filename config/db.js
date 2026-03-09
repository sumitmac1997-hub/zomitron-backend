const mongoose = require('mongoose');
const User = require('../models/User');
const Vendor = require('../models/Vendor');
const Product = require('../models/Product');
const Category = require('../models/Category');
const Pincode = require('../models/Pincode');

const isEnabled = (value) => String(value || '').toLowerCase() === 'true';

const getMongoMemoryServer = () => {
    try {
        return require('mongodb-memory-server').MongoMemoryServer;
    } catch (error) {
        throw new Error('mongodb-memory-server is unavailable. Disable USE_MEMORY_DB/FALLBACK_MEMORY_DB or install dev dependencies.');
    }
};

const connectDB = async () => {
    let uri = process.env.MONGO_URI;
    const isProduction = process.env.NODE_ENV === 'production';
    const allowMemoryInProduction = isEnabled(process.env.ALLOW_MEMORY_DB_IN_PRODUCTION);
    const canUseMemory = !isProduction || allowMemoryInProduction;
    const requestedMemory = isEnabled(process.env.USE_MEMORY_DB);
    const requestedFallbackMemory = isEnabled(process.env.FALLBACK_MEMORY_DB);
    const useMemory = canUseMemory && requestedMemory;
    const allowMemoryFallback = canUseMemory && requestedFallbackMemory;
    const memoryServerVersion = process.env.MONGOMS_VERSION || '7.0.3'; // >=7.0.3 required on Debian 12 (Render)
    let memServer;

    if (isProduction && !allowMemoryInProduction && (!uri || requestedMemory || requestedFallbackMemory)) {
        console.warn('In-memory MongoDB is disabled in production. Set MONGO_URI to Atlas and keep USE_MEMORY_DB/FALLBACK_MEMORY_DB off.');
    }

    const resolveUri = async () => {
        if (!uri && !useMemory) {
            throw new Error('MONGO_URI is required when in-memory MongoDB is disabled.');
        }

        if (!uri || useMemory) {
            const MongoMemoryServer = getMongoMemoryServer();
            memServer = await MongoMemoryServer.create({
                instance: {
                    dbName: process.env.MONGO_DB_NAME || 'zomitron',
                    port: process.env.MONGO_MEMORY_PORT ? Number(process.env.MONGO_MEMORY_PORT) : undefined,
                },
                binary: {
                    // Debian 12 images (Render) need MongoDB >=7.0.3; make override configurable
                    version: memoryServerVersion,
                },
            });
            uri = memServer.getUri();
            console.log(`🧠 Using in-memory MongoDB at ${uri}`);
        }
        return uri;
    };

    const dbName = process.env.MONGO_DB_NAME || 'zomitron';
    const connectWithUri = async (label = 'primary') => {
        const mongoUri = await resolveUri();
        const conn = await mongoose.connect(mongoUri, {
            dbName,
            serverSelectionTimeoutMS: Number(process.env.MONGO_TIMEOUT_MS) || 15000,
            socketTimeoutMS: Number(process.env.MONGO_SOCKET_TIMEOUT_MS) || 20000,
            maxPoolSize: Number(process.env.MONGO_MAX_POOL_SIZE) || 20,
            appName: process.env.MONGO_APP_NAME || 'zomitron-api',
        });
        console.log(`✅ MongoDB Connected (${label}): ${conn.connection.host}/${conn.connection.name}`);
    };

    const ensureIndexesAndDefaults = async () => {
        const db = mongoose.connection.db;

        const safeCreateIndex = async (collection, spec, options = {}) => {
            try {
                await db.collection(collection).createIndex(spec, options);
            } catch (err) {
                // Ignore duplicate index errors so dev envs don't crash
                if (err.codeName !== 'IndexOptionsConflict' && err.codeName !== 'IndexKeySpecsConflict') {
                    throw err;
                }
            }
        };

        await safeCreateIndex('products', { location: '2dsphere' });
        await safeCreateIndex('vendors', { location: '2dsphere' });
        await safeCreateIndex('pincodes', { pincode: 1 }, { unique: true });
        console.log('📍 Geospatial indexes ensured');

        if (process.env.NODE_ENV !== 'production' && process.env.AUTO_CREATE_ADMIN !== 'false') {
            const adminEmail = (process.env.ADMIN_EMAIL || 'admin@zomitron.com').toLowerCase();
            const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';
            const existingAdmin = await User.findOne({ email: adminEmail });
            if (!existingAdmin) {
                await User.create({
                    name: 'Zomitron Admin',
                    email: adminEmail,
                    password: adminPassword,
                    role: 'admin',
                    isVerified: true,
                });
                console.log(`👑 Default admin created: ${adminEmail}`);
            }
        }

        await ensureDemoSeed();
    };

    const ensureDemoSeed = async () => {
        const productCount = await Product.countDocuments();
        console.log(`ℹ️  Product count at startup: ${productCount}`);
        if (productCount > 0) return;

        console.log('🌱 No products found — seeding demo data in-memory');

        try {
            let pincode = await Pincode.findOne({ pincode: '211001' });
            if (!pincode) {
                pincode = await Pincode.create({
                    pincode: '211001',
                    city: 'Prayagraj',
                    district: 'Prayagraj',
                    state: 'Uttar Pradesh',
                    lat: 25.4358,
                    lng: 81.8463,
                    location: { type: 'Point', coordinates: [81.8463, 25.4358] },
                });
            }

            let category = await Category.findOne({ slug: 'electronics' });
            if (!category) {
                category = await Category.create({ name: 'Electronics', slug: 'electronics', icon: '📱' });
            }

            let vendorUser = await User.findOne({ email: 'vendor@demo.com' });
            if (!vendorUser) {
                vendorUser = await User.create({
                    name: 'Demo Vendor',
                    email: 'vendor@demo.com',
                    password: 'vendor123',
                    role: 'vendor',
                    isVerified: true,
                });
            }

            let vendor = await Vendor.findOne({ userId: vendorUser._id });
            if (!vendor) {
                vendor = await Vendor.create({
                    userId: vendorUser._id,
                    storeName: 'Demo Tech Store',
                    address: { line1: 'Civil Lines', city: 'Prayagraj', state: 'Uttar Pradesh', pincode: pincode.pincode },
                    pincode: pincode.pincode,
                    city: 'Prayagraj',
                    state: 'Uttar Pradesh',
                    location: { type: 'Point', coordinates: [81.8463, 25.4358] },
                    approved: true,
                });
            }

            const existingProduct = await Product.findOne({ title: 'Demo Smartphone' });
            if (!existingProduct) {
                await Product.create({
                    vendorId: vendor._id,
                    title: 'Demo Smartphone',
                    slug: `demo-smartphone-${Date.now()}`,
                    description: 'Sample product seeded automatically because the database was empty.',
                    price: 9999,
                    discountPrice: 7999,
                    images: ['https://via.placeholder.com/800x600.png?text=Demo+Phone'],
                    category: category._id,
                    categoryName: 'Electronics',
                    stock: 20,
                    pincode: pincode.pincode,
                    city: 'Prayagraj',
                    state: 'Uttar Pradesh',
                    location: { type: 'Point', coordinates: [81.8463, 25.4358] },
                    isApproved: true,
                    isFeatured: true,
                    tags: ['demo', 'phone'],
                });
            }

            console.log('✅ Demo product seeded or already present');
        } catch (seedErr) {
            console.warn('⚠️  Demo seed skipped:', seedErr.message);
        }
    };

    try {
        await connectWithUri();
        await ensureIndexesAndDefaults();
    } catch (error) {
        if (!useMemory && allowMemoryFallback) {
            console.warn('⚠️  Primary Mongo connection failed, falling back to in-memory MongoDB.');
            uri = null; // force re-resolve to memory
            await connectWithUri('memory-fallback');
            await ensureIndexesAndDefaults();
            return;
        }

        console.error(`❌ MongoDB connection error: ${error.message}`);
        console.error('Halting startup. Please verify MONGO_URI points to your Atlas cluster and network access is open.');
        throw error;
    }
};

module.exports = connectDB;
