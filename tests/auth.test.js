jest.mock('../config/firebaseAdmin', () => ({
    isFirebaseAdminConfigured: jest.fn(() => true),
    verifyFirebaseIdToken: jest.fn(async (idToken) => {
        if (idToken === 'bad-token') {
            throw new Error('Invalid token');
        }

        return {
            uid: 'firebase-uid-123',
            phone_number: '+919876543210',
        };
    }),
}));

const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { app } = require('../server');
const User = require('../models/User');
const { verifyFirebaseIdToken } = require('../config/firebaseAdmin');

let mongod;

beforeAll(async () => {
    mongod = await MongoMemoryServer.create({
        instance: {
            ip: '127.0.0.1',
            port: 27027,
        },
    });
    const uri = mongod.getUri();
    await mongoose.connect(uri);
});

afterAll(async () => {
    await mongoose.disconnect();
    await mongod.stop();
});

describe('Auth Routes', () => {
    test('POST /api/auth/register - should register a new user', async () => {
        const res = await request(app).post('/api/auth/register').send({
            name: 'Test User',
            email: 'test@zomitron.com',
            password: 'password123',
            mobileNumber: '9876543210',
            role: 'customer',
        });
        expect(res.status).toBe(201);
        expect(res.body.success).toBe(true);
        expect(res.body.emailQueued).toBe(true);
        expect(res.body.token).toBeDefined();
        expect(res.body.user.email).toBe('test@zomitron.com');
        expect(res.body.user.mobileNumber).toBe('9876543210');
    });

    test('POST /api/auth/register - should accept legacy phone field and normalize it', async () => {
        const res = await request(app).post('/api/auth/register').send({
            name: 'Legacy Phone',
            email: 'legacy-phone@zomitron.com',
            password: 'password123',
            phone: '+91 98765 43211',
            role: 'customer',
        });
        expect(res.status).toBe(201);
        expect(res.body.success).toBe(true);
        expect(res.body.user.mobileNumber).toBe('9876543211');
        expect(res.body.user.phone).toBe('9876543211');
    });

    test('POST /api/auth/register - should require mobile number', async () => {
        const res = await request(app).post('/api/auth/register').send({
            name: 'No Mobile',
            email: 'nomobile@zomitron.com',
            password: 'password123',
            role: 'customer',
        });
        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
    });

    test('POST /api/auth/register - should fail with duplicate email', async () => {
        await request(app).post('/api/auth/register').send({
            name: 'Test User',
            email: 'dup@zomitron.com',
            password: 'password123',
            mobileNumber: '9876543212',
        });
        const res = await request(app).post('/api/auth/register').send({
            name: 'Test User 2',
            email: 'dup@zomitron.com',
            password: 'password123',
            mobileNumber: '9876543213',
        });
        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
    });

    test('POST /api/auth/register - should fail with duplicate mobile number', async () => {
        const res = await request(app).post('/api/auth/register').send({
            name: 'Duplicate Mobile',
            email: 'duplicate-mobile@zomitron.com',
            password: 'password123',
            mobileNumber: '9876543210',
        });
        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
    });

    test('POST /api/auth/login - should login successfully', async () => {
        await request(app).post('/api/auth/register').send({
            name: 'Login Test',
            email: 'login@zomitron.com',
            password: 'mypassword',
            mobileNumber: '9876543214',
        });
        const res = await request(app).post('/api/auth/login').send({
            email: 'login@zomitron.com',
            password: 'mypassword',
        });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.token).toBeDefined();
    });

    test('POST /api/auth/login - should fail with wrong password', async () => {
        const res = await request(app).post('/api/auth/login').send({
            email: 'login@zomitron.com',
            password: 'wrongpassword',
        });
        expect(res.status).toBe(401);
        expect(res.body.success).toBe(false);
    });

    test('POST /api/auth/mobile-login - should create a new user from verified mobile auth', async () => {
        verifyFirebaseIdToken.mockResolvedValueOnce({
            uid: 'firebase-uid-new-user',
            phone_number: '+919876543215',
        });

        const res = await request(app).post('/api/auth/mobile-login').send({
            mobileNumber: '9876543215',
            firebaseUid: 'firebase-uid-new-user',
            firebaseIdToken: 'valid-token',
        });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.user.mobileNumber).toBe('9876543215');
        expect(res.body.user.authProvider).toBe('mobile');

        const user = await User.findOne({ mobileNumber: '9876543215' });
        expect(user).toBeTruthy();
        expect(user.firebaseUid).toBe('firebase-uid-new-user');
    });

    test('POST /api/auth/mobile-login - should login an existing local user by mobile number', async () => {
        const user = await User.create({
            name: 'Existing Local User',
            email: 'existing-mobile@zomitron.com',
            password: 'password123',
            mobileNumber: '9876543216',
            phone: '9876543216',
            authProvider: 'local',
            isVerified: true,
        });

        verifyFirebaseIdToken.mockResolvedValueOnce({
            uid: 'firebase-uid-existing',
            phone_number: '+919876543216',
        });

        const res = await request(app).post('/api/auth/mobile-login').send({
            mobileNumber: '9876543216',
            firebaseUid: 'firebase-uid-existing',
            firebaseIdToken: 'valid-token-existing',
        });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.user._id).toBe(String(user._id));
        expect(res.body.user.authProvider).toBe('local+mobile');
    });

    test('POST /api/auth/mobile-login - should reject mismatched verified mobile numbers', async () => {
        verifyFirebaseIdToken.mockResolvedValueOnce({
            uid: 'firebase-uid-mismatch',
            phone_number: '+919876543217',
        });

        const res = await request(app).post('/api/auth/mobile-login').send({
            mobileNumber: '9876543218',
            firebaseUid: 'firebase-uid-mismatch',
            firebaseIdToken: 'valid-token-mismatch',
        });

        expect(res.status).toBe(401);
        expect(res.body.success).toBe(false);
    });

    test('POST /api/auth/forgot-password and /reset-password - should reset the password', async () => {
        await request(app).post('/api/auth/register').send({
            name: 'Reset Test',
            email: 'reset@zomitron.com',
            password: 'oldpassword123',
            mobileNumber: '9876543219',
        });

        const forgotRes = await request(app).post('/api/auth/forgot-password').send({
            email: 'reset@zomitron.com',
        });
        expect(forgotRes.status).toBe(200);
        expect(forgotRes.body.success).toBe(true);

        const user = await User.findOne({ email: 'reset@zomitron.com' });
        expect(user.otp).toBeDefined();

        const resetRes = await request(app).post('/api/auth/reset-password').send({
            email: 'reset@zomitron.com',
            token: user.otp,
            password: 'newpassword123',
        });
        expect(resetRes.status).toBe(200);
        expect(resetRes.body.success).toBe(true);

        const loginRes = await request(app).post('/api/auth/login').send({
            email: 'reset@zomitron.com',
            password: 'newpassword123',
        });
        expect(loginRes.status).toBe(200);
        expect(loginRes.body.success).toBe(true);
    });

    test('POST /api/auth/register - should not allow admin role', async () => {
        const res = await request(app).post('/api/auth/register').send({
            name: 'Fake Admin',
            email: 'fakeadmin@zomitron.com',
            password: 'password123',
            mobileNumber: '9876543220',
            role: 'admin',
        });
        expect(res.status).toBe(403);
    });

    test('GET /api/auth/me - should return user with valid token', async () => {
        const loginRes = await request(app).post('/api/auth/login').send({
            email: 'login@zomitron.com',
            password: 'mypassword',
        });
        const token = loginRes.body.token;
        const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
        expect(res.status).toBe(200);
        expect(res.body.user.email).toBe('login@zomitron.com');
        expect(res.body.user.mobileNumber).toBe('9876543214');
    });
});
