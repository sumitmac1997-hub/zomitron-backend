const mongoose = require('mongoose');
const dotenv = require('dotenv');
const path = require('path');
dotenv.config({ path: path.join(__dirname, '../.env') });

const User = require('../models/User');
const Vendor = require('../models/Vendor');
const Product = require('../models/Product');
const Category = require('../models/Category');
const Pincode = require('../models/Pincode');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/zomitron';

// ─── Helper: generate slug ────────────────────────────────────────────────────
const slugify = (text) =>
    text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') +
    '-' + Date.now() + '-' + Math.floor(Math.random() * 1000);

// ─── SEED DATA ───────────────────────────────────────────────────────────────

const pincodeData = [
    { pincode: '211001', city: 'Prayagraj', district: 'Prayagraj', state: 'Uttar Pradesh', lat: 25.4358, lng: 81.8463 },
    { pincode: '211002', city: 'Prayagraj', district: 'Prayagraj', state: 'Uttar Pradesh', lat: 25.4484, lng: 81.8322 },
    { pincode: '211003', city: 'Prayagraj', district: 'Prayagraj', state: 'Uttar Pradesh', lat: 25.4670, lng: 81.8679 },
    { pincode: '211004', city: 'Prayagraj', district: 'Prayagraj', state: 'Uttar Pradesh', lat: 25.4218, lng: 81.8558 },
    { pincode: '211006', city: 'Prayagraj', district: 'Prayagraj', state: 'Uttar Pradesh', lat: 25.4522, lng: 81.9034 },
    { pincode: '226001', city: 'Lucknow', district: 'Lucknow', state: 'Uttar Pradesh', lat: 26.8467, lng: 80.9462 },
    { pincode: '226002', city: 'Lucknow', district: 'Lucknow', state: 'Uttar Pradesh', lat: 26.8350, lng: 80.9280 },
    { pincode: '226016', city: 'Lucknow', district: 'Lucknow', state: 'Uttar Pradesh', lat: 26.7606, lng: 80.8897 },
    { pincode: '221001', city: 'Varanasi', district: 'Varanasi', state: 'Uttar Pradesh', lat: 25.3176, lng: 82.9739 },
    { pincode: '221002', city: 'Varanasi', district: 'Varanasi', state: 'Uttar Pradesh', lat: 25.3301, lng: 83.0027 },
    { pincode: '560001', city: 'Bangalore', district: 'Bangalore Urban', state: 'Karnataka', lat: 12.9716, lng: 77.5946 },
    { pincode: '560002', city: 'Bangalore', district: 'Bangalore Urban', state: 'Karnataka', lat: 12.9849, lng: 77.5864 },
    { pincode: '560034', city: 'Bangalore', district: 'Bangalore Urban', state: 'Karnataka', lat: 12.9352, lng: 77.6244 },
    { pincode: '560068', city: 'Bangalore', district: 'Bangalore Urban', state: 'Karnataka', lat: 12.9279, lng: 77.5880 },
    { pincode: '400001', city: 'Mumbai', district: 'Mumbai', state: 'Maharashtra', lat: 18.9388, lng: 72.8354 },
    { pincode: '400051', city: 'Mumbai', district: 'Mumbai', state: 'Maharashtra', lat: 19.0596, lng: 72.8295 },
    { pincode: '110001', city: 'New Delhi', district: 'New Delhi', state: 'Delhi', lat: 28.6139, lng: 77.2090 },
    { pincode: '110011', city: 'New Delhi', district: 'New Delhi', state: 'Delhi', lat: 28.6100, lng: 77.1800 },
    { pincode: '208001', city: 'Kanpur', district: 'Kanpur Nagar', state: 'Uttar Pradesh', lat: 26.4499, lng: 80.3319 },
    { pincode: '208012', city: 'Kanpur', district: 'Kanpur Nagar', state: 'Uttar Pradesh', lat: 26.4670, lng: 80.3490 },
];

const categoryData = [
    { name: 'Electronics', slug: 'electronics', icon: '📱', sortOrder: 1 },
    { name: 'Fashion', slug: 'fashion', icon: '👗', sortOrder: 2 },
    { name: 'Furniture', slug: 'furniture', icon: '🛋️', sortOrder: 3 },
    { name: 'Appliances', slug: 'appliances', icon: '🏠', sortOrder: 4 },
    { name: 'Groceries', slug: 'groceries', icon: '🛒', sortOrder: 5 },
    { name: 'Mobiles', slug: 'mobiles', icon: '📱', sortOrder: 6, parent: 'Electronics' },
    { name: 'Laptops', slug: 'laptops', icon: '💻', sortOrder: 7, parent: 'Electronics' },
    { name: "Men's Wear", slug: 'mens-wear', icon: '👔', sortOrder: 8, parent: 'Fashion' },
    { name: "Women's Wear", slug: 'womens-wear', icon: '👗', sortOrder: 9, parent: 'Fashion' },
    { name: 'Kitchen', slug: 'kitchen', icon: '🍳', sortOrder: 10, parent: 'Appliances' },
];

const adminData = { name: 'Zomitron Admin', email: 'admin@zomitron.com', password: 'admin123', role: 'admin', isVerified: true };
const customerData = { name: 'Test Customer', email: 'customer@zomitron.com', password: 'customer123', role: 'customer', isVerified: true };
const vendorUsersData = [
    { name: 'TechZone Prayagraj', email: 'vendor1@zomitron.com', password: 'vendor123', role: 'vendor', isVerified: true },
    { name: 'FashionHub Prayagraj', email: 'vendor2@zomitron.com', password: 'vendor123', role: 'vendor', isVerified: true },
    { name: 'ElectroBangalore', email: 'vendor3@zomitron.com', password: 'vendor123', role: 'vendor', isVerified: true },
];

// ─── SEED FUNCTION ───────────────────────────────────────────────────────────

const seed = async () => {
    try {
        await mongoose.connect(MONGO_URI);
        console.log('✅ Connected to MongoDB');

        // Drop all collections cleanly (avoids stale indexes)
        console.log('🗑️  Clearing existing data...');
        await Promise.all([
            User.deleteMany({}),
            Vendor.deleteMany({}),
            Product.deleteMany({}),
            Category.deleteMany({}),
            Pincode.deleteMany({}),
        ]);

        // Seed pincodes
        console.log('📍 Seeding pincodes...');
        const pincodes = pincodeData.map(p => ({
            ...p, location: { type: 'Point', coordinates: [p.lng, p.lat] }
        }));
        await Pincode.insertMany(pincodes, { ordered: false });
        console.log(`✅ ${pincodes.length} pincodes seeded`);

        // Seed users
        const admin = await User.create(adminData);
        console.log(`✅ Admin created: ${admin.email}`);
        const customer = await User.create(customerData);
        console.log(`✅ Customer created: ${customer.email}`);
        const vendorUsers = [];
        for (const vud of vendorUsersData) {
            vendorUsers.push(await User.create(vud));
        }

        // Seed categories
        const parentCategories = await Category.insertMany(
            categoryData.filter(c => !c.parent).map(({ parent, ...c }) => c)
        );
        const catMap = {};
        parentCategories.forEach(c => { catMap[c.name] = c._id; });
        const subCategories = await Category.insertMany(
            categoryData.filter(c => c.parent).map(c => ({ ...c, parent: catMap[c.parent] }))
        );
        subCategories.forEach(c => { catMap[c.name] = c._id; });
        console.log(`✅ ${categoryData.length} categories seeded`);

        // Seed vendors
        const vendorDefs = [
            {
                userId: vendorUsers[0]._id,
                storeName: 'TechZone Prayagraj',
                storeDescription: 'Best electronics and gadgets in Prayagraj. Authorized dealer for Samsung, Apple & more.',
                address: { line1: 'Civil Lines', city: 'Prayagraj', state: 'Uttar Pradesh', pincode: '211001' },
                pincode: '211001', city: 'Prayagraj', state: 'Uttar Pradesh',
                location: { type: 'Point', coordinates: [81.8463, 25.4358] },
                phone: '9876543210', email: 'vendor1@zomitron.com',
                approved: true, commissionRate: 0.10, balance: 5000, totalEarnings: 25000,
            },
            {
                userId: vendorUsers[1]._id,
                storeName: 'FashionHub Prayagraj',
                storeDescription: 'Trendy fashion for men & women. Latest styles at affordable prices.',
                address: { line1: 'Hazratganj', city: 'Prayagraj', state: 'Uttar Pradesh', pincode: '211002' },
                pincode: '211002', city: 'Prayagraj', state: 'Uttar Pradesh',
                location: { type: 'Point', coordinates: [81.8322, 25.4484] },
                phone: '9876543211', email: 'vendor2@zomitron.com',
                approved: true, commissionRate: 0.12, balance: 3000, totalEarnings: 18000,
            },
            {
                userId: vendorUsers[2]._id,
                storeName: 'ElectroBangalore',
                storeDescription: 'Premier electronics retailer in Bangalore. Laptops, phones, accessories.',
                address: { line1: 'MG Road', city: 'Bangalore', state: 'Karnataka', pincode: '560001' },
                pincode: '560001', city: 'Bangalore', state: 'Karnataka',
                location: { type: 'Point', coordinates: [77.5946, 12.9716] },
                phone: '9876543212', email: 'vendor3@zomitron.com',
                approved: true, commissionRate: 0.10, balance: 8000, totalEarnings: 45000,
            },
        ];
        const vendors = await Vendor.insertMany(vendorDefs);
        console.log(`✅ ${vendors.length} vendors seeded`);

        // Seed products — use create() (not insertMany) so pre('save') slug hook runs
        console.log('🛍️  Seeding products...');
        const productDefs = [
            {
                vendorId: vendors[0]._id, title: 'Samsung Galaxy S23 Ultra 256GB',
                slug: slugify('samsung-galaxy-s23-ultra-256gb'),
                description: 'Latest Samsung flagship with 200MP camera, S Pen, and 5000mAh battery.',
                price: 124999, discountPrice: 109999,
                images: ['https://images.unsplash.com/photo-1676404407079-96b8b9a7d0e9?w=800'],
                category: catMap['Mobiles'], categoryName: 'Mobiles',
                stock: 15, pincode: '211001', city: 'Prayagraj', state: 'Uttar Pradesh',
                location: { type: 'Point', coordinates: [81.8463, 25.4358] },
                tags: ['samsung', 'smartphone', '5g', 'android'], isFeatured: true, isApproved: true,
            },
            {
                vendorId: vendors[0]._id, title: 'Apple iPhone 15 Pro 128GB',
                slug: slugify('apple-iphone-15-pro-128gb'),
                description: 'Apple iPhone 15 Pro with A17 Pro chip, titanium design, and ProMotion display.',
                price: 134900, discountPrice: 124999,
                images: ['https://images.unsplash.com/photo-1697565979219-2e47ac4f7c77?w=800'],
                category: catMap['Mobiles'], categoryName: 'Mobiles',
                stock: 8, pincode: '211001', city: 'Prayagraj', state: 'Uttar Pradesh',
                location: { type: 'Point', coordinates: [81.8463, 25.4358] },
                tags: ['apple', 'iphone', 'ios', 'smartphone'], isFeatured: true, isApproved: true,
            },
            {
                vendorId: vendors[0]._id, title: 'Boat Rockerz 450 Wireless Headphone',
                slug: slugify('boat-rockerz-450-wireless-headphone'),
                description: 'Premium wireless headphones with 15hr battery, 40mm drivers, and foldable design.',
                price: 2999, discountPrice: 1499,
                images: ['https://images.unsplash.com/photo-1505740420928-5e560c06d30e?w=800'],
                category: catMap['Electronics'], categoryName: 'Electronics',
                stock: 50, pincode: '211001', city: 'Prayagraj', state: 'Uttar Pradesh',
                location: { type: 'Point', coordinates: [81.8463, 25.4358] },
                tags: ['headphones', 'wireless', 'audio', 'boat'], isApproved: true,
            },
            {
                vendorId: vendors[0]._id, title: 'Dell Inspiron 15 3520 Laptop',
                slug: slugify('dell-inspiron-15-3520-laptop'),
                description: 'Intel Core i5 12th Gen, 8GB RAM, 512GB SSD, Windows 11, 15.6" FHD display.',
                price: 52990, discountPrice: 45999,
                images: ['https://images.unsplash.com/photo-1496181133206-80ce9b88a853?w=800'],
                category: catMap['Laptops'], categoryName: 'Laptops',
                stock: 5, pincode: '211001', city: 'Prayagraj', state: 'Uttar Pradesh',
                location: { type: 'Point', coordinates: [81.8463, 25.4358] },
                tags: ['laptop', 'dell', 'intel', 'windows'], isFeatured: true, isApproved: true,
            },
            {
                vendorId: vendors[1]._id, title: "Men's Cotton Formal Shirt",
                slug: slugify('mens-cotton-formal-shirt'),
                description: 'Premium cotton formal shirt, slim fit, available in multiple colors. Perfect for office.',
                price: 1299, discountPrice: 699,
                images: ['https://images.unsplash.com/photo-1598033129183-c4f50c736f10?w=800'],
                category: catMap["Men's Wear"], categoryName: "Men's Wear",
                stock: 100, pincode: '211002', city: 'Prayagraj', state: 'Uttar Pradesh',
                location: { type: 'Point', coordinates: [81.8322, 25.4484] },
                tags: ['shirt', 'formal', 'cotton', 'mens'], isApproved: true,
            },
            {
                vendorId: vendors[1]._id, title: "Women's Floral Kurti",
                slug: slugify('womens-floral-kurti'),
                description: 'Beautiful floral print kurti in soft cotton fabric. Ideal for daily wear.',
                price: 799, discountPrice: 499,
                images: ['https://images.unsplash.com/photo-1564423756733-3b15a4e5e71f?w=800'],
                category: catMap["Women's Wear"], categoryName: "Women's Wear",
                stock: 200, pincode: '211002', city: 'Prayagraj', state: 'Uttar Pradesh',
                location: { type: 'Point', coordinates: [81.8322, 25.4484] },
                tags: ['kurti', 'floral', 'cotton', 'ethnic', 'women'], isFeatured: true, isApproved: true,
            },
            {
                vendorId: vendors[1]._id, title: 'Nike Air Max 270 Running Shoes',
                slug: slugify('nike-air-max-270-running-shoes'),
                description: 'Iconic Nike Air Max with Max Air cushioning. Comfortable and stylish.',
                price: 8995, discountPrice: 6999,
                images: ['https://images.unsplash.com/photo-1542291026-7eec264c27ff?w=800'],
                category: catMap['Fashion'], categoryName: 'Fashion',
                stock: 30, pincode: '211002', city: 'Prayagraj', state: 'Uttar Pradesh',
                location: { type: 'Point', coordinates: [81.8322, 25.4484] },
                tags: ['nike', 'shoes', 'running', 'sports'], isApproved: true,
            },
            {
                vendorId: vendors[2]._id, title: 'MacBook Air M2 8GB 256GB',
                slug: slugify('macbook-air-m2-8gb-256gb'),
                description: 'Apple M2 chip, 8GB RAM, 256GB SSD, 13.6" Liquid Retina display. Ultralight.',
                price: 114900, discountPrice: 99900,
                images: ['https://images.unsplash.com/photo-1611186871525-7f0f6b29c3ba?w=800'],
                category: catMap['Laptops'], categoryName: 'Laptops',
                stock: 12, pincode: '560001', city: 'Bangalore', state: 'Karnataka',
                location: { type: 'Point', coordinates: [77.5946, 12.9716] },
                tags: ['apple', 'macbook', 'laptop', 'm2'], isFeatured: true, isApproved: true,
            },
            {
                vendorId: vendors[2]._id, title: 'OnePlus 12 256GB Flowy Emerald',
                slug: slugify('oneplus-12-256gb-flowy-emerald'),
                description: 'OnePlus 12 with Snapdragon 8 Gen 3, 50MP Hasselblad camera, Supervooc 100W.',
                price: 64999, discountPrice: 59999,
                images: ['https://images.unsplash.com/photo-1511707171634-5f897ff02aa9?w=800'],
                category: catMap['Mobiles'], categoryName: 'Mobiles',
                stock: 25, pincode: '560001', city: 'Bangalore', state: 'Karnataka',
                location: { type: 'Point', coordinates: [77.5946, 12.9716] },
                tags: ['oneplus', 'smartphone', 'android', '5g'], isApproved: true,
            },
            {
                vendorId: vendors[2]._id, title: 'Sony WH-1000XM5 Noise Cancelling Headphones',
                slug: slugify('sony-wh-1000xm5-noise-cancelling'),
                description: 'Industry-leading noise cancellation, 30hr battery, multipoint connect.',
                price: 29990, discountPrice: 24990,
                images: ['https://images.unsplash.com/photo-1618366712010-f4ae9c647dcb?w=800'],
                category: catMap['Electronics'], categoryName: 'Electronics',
                stock: 20, pincode: '560001', city: 'Bangalore', state: 'Karnataka',
                location: { type: 'Point', coordinates: [77.5946, 12.9716] },
                tags: ['sony', 'headphones', 'noise-cancelling', 'wireless'], isFeatured: true, isApproved: true,
            },
        ];

        // Insert products one-by-one via create so pre-save slug hook runs
        for (const pd of productDefs) {
            await Product.create(pd);
        }

        // Update vendor product counts
        await Vendor.updateOne({ _id: vendors[0]._id }, { totalProducts: 4 });
        await Vendor.updateOne({ _id: vendors[1]._id }, { totalProducts: 3 });
        await Vendor.updateOne({ _id: vendors[2]._id }, { totalProducts: 3 });

        console.log(`✅ ${productDefs.length} products seeded`);
        console.log('\n🎉 Database seeded successfully!\n');
        console.log('═══════════════════════════════════════');
        console.log('Demo Credentials:');
        console.log('  Admin:    admin@zomitron.com / admin123');
        console.log('  Customer: customer@zomitron.com / customer123');
        console.log('  Vendor 1: vendor1@zomitron.com / vendor123  (Prayagraj)');
        console.log('  Vendor 2: vendor2@zomitron.com / vendor123  (Prayagraj)');
        console.log('  Vendor 3: vendor3@zomitron.com / vendor123  (Bangalore)');
        console.log('═══════════════════════════════════════\n');

        process.exit(0);
    } catch (err) {
        console.error('❌ Seed failed:', err.message || err);
        process.exit(1);
    }
};

seed();
