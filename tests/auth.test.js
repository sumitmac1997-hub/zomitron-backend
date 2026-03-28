const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { app } = require('../server');
const User = require('../models/User');

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
            role: 'customer',
        });
        expect(res.status).toBe(201);
        expect(res.body.success).toBe(true);
        expect(res.body.emailSent).toBe(true);
        expect(res.body.token).toBeDefined();
        expect(res.body.user.email).toBe('test@zomitron.com');
    });

    test('POST /api/auth/register - should allow blank optional phone', async () => {
        const res = await request(app).post('/api/auth/register').send({
            name: 'Phone Optional',
            email: 'optional-phone@zomitron.com',
            password: 'password123',
            phone: '   ',
            role: 'customer',
        });
        expect(res.status).toBe(201);
        expect(res.body.success).toBe(true);
        expect(res.body.user.email).toBe('optional-phone@zomitron.com');
    });

    test('POST /api/auth/register - should fail with duplicate email', async () => {
        await request(app).post('/api/auth/register').send({
            name: 'Test User', email: 'dup@zomitron.com', password: 'password123',
        });
        const res = await request(app).post('/api/auth/register').send({
            name: 'Test User 2', email: 'dup@zomitron.com', password: 'password123',
        });
        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
    });

    test('POST /api/auth/login - should login successfully', async () => {
        await request(app).post('/api/auth/register').send({
            name: 'Login Test', email: 'login@zomitron.com', password: 'mypassword',
        });
        const res = await request(app).post('/api/auth/login').send({
            email: 'login@zomitron.com', password: 'mypassword',
        });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.token).toBeDefined();
    });

    test('POST /api/auth/login - should fail with wrong password', async () => {
        const res = await request(app).post('/api/auth/login').send({
            email: 'login@zomitron.com', password: 'wrongpassword',
        });
        expect(res.status).toBe(401);
        expect(res.body.success).toBe(false);
    });

    test('POST /api/auth/forgot-password and /reset-password - should reset the password', async () => {
        await request(app).post('/api/auth/register').send({
            name: 'Reset Test',
            email: 'reset@zomitron.com',
            password: 'oldpassword123',
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
            name: 'Fake Admin', email: 'fakeadmin@zomitron.com', password: 'password123', role: 'admin',
        });
        expect(res.status).toBe(403);
    });

    test('GET /api/auth/me - should return user with valid token', async () => {
        const loginRes = await request(app).post('/api/auth/login').send({
            email: 'login@zomitron.com', password: 'mypassword',
        });
        const token = loginRes.body.token;
        const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
        expect(res.status).toBe(200);
        expect(res.body.user.email).toBe('login@zomitron.com');
    });
});
