jest.mock('../models/Pincode', () => ({
    findOne: jest.fn(),
    find: jest.fn(),
}));

jest.mock('../utils/geocode', () => ({
    geocodePincode: jest.fn(),
}));

jest.mock('../utils/cache', () => ({
    buildCacheKey: jest.fn((prefix, payload) => `${prefix}:${JSON.stringify(payload)}`),
    getCacheEntry: jest.fn(() => undefined),
    setCacheEntry: jest.fn(),
}));

const Pincode = require('../models/Pincode');
const { geocodePincode } = require('../utils/geocode');
const pincodeRouter = require('../routes/pincode');

const makeLeanChain = (result) => ({
    limit: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue(result),
});

const getRouteHandlers = (path, method) => {
    const layer = pincodeRouter.stack.find((entry) => entry.route?.path === path && entry.route?.methods?.[method]);
    if (!layer) throw new Error(`Route ${method.toUpperCase()} ${path} not found`);
    return layer.route.stack.map((entry) => entry.handle);
};

const invokeRoute = async ({ path, method, query = {}, body = {}, params = {} }) => {
    const handlers = getRouteHandlers(path, method);

    return new Promise((resolve, reject) => {
        const req = {
            method: method.toUpperCase(),
            query,
            body,
            params,
        };

        const res = {
            statusCode: 200,
            body: undefined,
            status(code) {
                this.statusCode = code;
                return this;
            },
            json(payload) {
                this.body = payload;
                resolve(this);
                return this;
            },
        };

        const run = (index) => {
            if (index >= handlers.length) {
                resolve(res);
                return;
            }

            Promise.resolve(handlers[index](req, res, (error) => {
                if (error) {
                    reject(error);
                    return;
                }
                run(index + 1);
            })).catch(reject);
        };

        run(0);
    });
};

describe('Pincode routes', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('GET /api/pincode/search returns city matches without being shadowed by /:code', async () => {
        Pincode.find.mockReturnValueOnce(makeLeanChain([
            { pincode: '221001', city: 'Varanasi', state: 'Uttar Pradesh' },
        ]));

        const res = await invokeRoute({
            path: '/search',
            method: 'get',
            query: { q: 'Varanasi', limit: '5' },
        });

        expect(res.statusCode).toBe(200);
        expect(Pincode.find).toHaveBeenCalled();
        expect(res.body).toEqual({
            success: true,
            pincodes: [{ pincode: '221001', city: 'Varanasi', state: 'Uttar Pradesh' }],
        });
    });

    test('POST /api/pincode/validate-delivery falls back to geocoding when DB misses', async () => {
        Pincode.findOne
            .mockReturnValueOnce({ lean: jest.fn().mockResolvedValue(null) })
            .mockReturnValueOnce({ lean: jest.fn().mockResolvedValue(null) });

        geocodePincode
            .mockResolvedValueOnce({ city: 'Prayagraj', state: 'Uttar Pradesh', lat: 25.4358, lng: 81.8463 })
            .mockResolvedValueOnce({ city: 'Varanasi', state: 'Uttar Pradesh', lat: 25.3176, lng: 82.9739 });

        const res = await invokeRoute({
            path: '/validate-delivery',
            method: 'post',
            body: { fromPincode: '999991', toPincode: '999992' },
        });

        expect(res.statusCode).toBe(200);
        expect(geocodePincode).toHaveBeenCalledTimes(2);
        expect(res.body).toEqual(expect.objectContaining({
            success: true,
            from: { pincode: '999991', city: 'Prayagraj', state: 'Uttar Pradesh' },
            to: { pincode: '999992', city: 'Varanasi', state: 'Uttar Pradesh' },
            deliveryAvailable: false,
        }));
    });
});
