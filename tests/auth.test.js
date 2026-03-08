const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { app } = require('../server');

let mongod;

beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
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
        expect(res.body.token).toBeDefined();
        expect(res.body.user.email).toBe('test@zomitron.com');
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
