const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const User = require('../models/User');
const Vendor = require('../models/Vendor');
const Product = require('../models/Product');
const Category = require('../models/Category');
const Pincode = require('../models/Pincode');

const connectDB = async () => {
    const primaryUri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/zomitron';
    const fallbackUri = process.env.MONGO_URI_FALLBACK || 'mongodb://127.0.0.1:27017/zomitron';

    const connectWithUri = async (uri, label) => {
        const conn = await mongoose.connect(uri, {
            useNewUrlParser: true,
            useUnifiedTopology: true,
        });
        console.log(`✅ MongoDB Connected${label ? ` (${label})` : ''}: ${conn.connection.host}`);
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

        const pincode = await Pincode.create({
            pincode: '211001', city: 'Prayagraj', district: 'Prayagraj', state: 'Uttar Pradesh',
            location: { type: 'Point', coordinates: [81.8463, 25.4358] },
        });

        const category = await Category.create({ name: 'Electronics', slug: 'electronics', icon: '📱' });
        const vendorUser = await User.create({
            name: 'Demo Vendor', email: 'vendor@demo.com', password: 'vendor123', role: 'vendor', isVerified: true,
        });
        const vendor = await Vendor.create({
            userId: vendorUser._id,
            storeName: 'Demo Tech Store',
            address: { line1: 'Civil Lines', city: 'Prayagraj', state: 'Uttar Pradesh', pincode: pincode.pincode },
            pincode: pincode.pincode,
            city: 'Prayagraj', state: 'Uttar Pradesh',
            location: { type: 'Point', coordinates: [81.8463, 25.4358] },
            approved: true,
        });

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

        console.log('✅ Demo product seeded');
    };

    try {
        await connectWithUri(primaryUri, 'primary');
        await ensureIndexesAndDefaults();
    } catch (error) {
        console.error(`❌ MongoDB connection error (primary): ${error.message}`);
        try {
            await connectWithUri(fallbackUri, 'fallback');
            await ensureIndexesAndDefaults();
            return;
        } catch (err) {
            console.error(`❌ MongoDB connection error (fallback): ${err.message}`);
            console.log('🚧 Falling back to in-memory MongoDB (mongodb-memory-server)');
            const mem = await MongoMemoryServer.create({ instance: { dbName: 'zomitron' } });
            const memUri = mem.getUri();
            await connectWithUri(memUri, 'in-memory');
            await ensureIndexesAndDefaults();
        }
    }
};

module.exports = connectDB;
