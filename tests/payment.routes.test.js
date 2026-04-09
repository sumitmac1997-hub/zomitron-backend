const ORIGINAL_ENV = { ...process.env };

const buildPaymentTestHarness = () => {
    jest.resetModules();
    process.env = {
        ...ORIGINAL_ENV,
        RAZORPAY_KEY_ID: '  rzp_test_trimmed  ',
        RAZORPAY_KEY_SECRET: '  secret_trimmed  ',
    };

    const ordersCreate = jest.fn();
    const Razorpay = jest.fn(() => ({
        orders: {
            create: ordersCreate,
        },
    }));
    const Order = {
        findById: jest.fn(),
    };

    jest.doMock('stripe', () => jest.fn());
    jest.doMock('razorpay', () => Razorpay);
    jest.doMock('../models/Order', () => Order);
    jest.doMock('../middleware/auth', () => ({
        protect: (req, res, next) => next(),
        optionalAuth: (req, res, next) => next(),
    }));
    jest.doMock('../utils/orderPlacement', () => ({
        finalizeOrderPlacement: jest.fn(),
        abortOrderDraft: jest.fn(),
    }));

    const paymentRouter = require('../routes/payment');

    return { paymentRouter, Order, Razorpay, ordersCreate };
};

const getRouteHandlers = (router, path, method) => {
    const layer = router.stack.find((entry) => entry.route?.path === path && entry.route?.methods?.[method]);
    if (!layer) throw new Error(`Route ${method.toUpperCase()} ${path} not found`);
    return layer.route.stack.map((entry) => entry.handle);
};

const invokeRoute = async (router, { path, method, body = {}, params = {}, query = {} }) => {
    const handlers = getRouteHandlers(router, path, method);

    return new Promise((resolve, reject) => {
        const req = {
            method: method.toUpperCase(),
            body,
            params,
            query,
            headers: {},
            app: { get: jest.fn() },
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
            send(payload) {
                this.body = payload;
                resolve(this);
                return this;
            },
        };

        const resolveError = (error) => {
            res.status(error?.statusCode || 500).json({
                success: false,
                message: error?.message || 'Internal Server Error',
            });
        };

        const run = (index) => {
            if (index >= handlers.length) {
                resolve(res);
                return;
            }

            try {
                Promise.resolve(handlers[index](req, res, (error) => {
                    if (error) {
                        resolveError(error);
                        return;
                    }
                    run(index + 1);
                })).catch(resolveError);
            } catch (error) {
                reject(error);
            }
        };

        run(0);
    });
};

describe('Payment Routes', () => {
    afterEach(() => {
        jest.clearAllMocks();
        process.env = { ...ORIGINAL_ENV };
    });

    afterAll(() => {
        process.env = ORIGINAL_ENV;
    });

    test('GET /api/payments/config exposes a trimmed Razorpay key id', async () => {
        const { paymentRouter, Razorpay } = buildPaymentTestHarness();

        const res = await invokeRoute(paymentRouter, {
            path: '/config',
            method: 'get',
        });

        expect(res.statusCode).toBe(200);
        expect(res.body.available.razorpay).toBe(true);
        expect(res.body.razorpay.keyId).toBe('rzp_test_trimmed');
        expect(Razorpay).toHaveBeenCalledWith({
            key_id: 'rzp_test_trimmed',
            key_secret: 'secret_trimmed',
        });
    });

    test('POST /api/payments/razorpay/order returns the upstream Razorpay error description', async () => {
        const { paymentRouter, Order, ordersCreate } = buildPaymentTestHarness();
        const save = jest.fn();

        Order.findById.mockResolvedValue({
            _id: 'order-1',
            total: 1300,
            orderNumber: 'ZOM1775733906965TTCM',
            paymentMethod: 'razorpay',
            isPlaced: false,
            stockReserved: true,
            paymentStatus: 'pending',
            orderStatus: 'pending',
            save,
        });
        ordersCreate.mockRejectedValue({
            statusCode: 401,
            error: {
                description: 'The key_id/key_secret provided is invalid.',
            },
        });

        const res = await invokeRoute(paymentRouter, {
            path: '/razorpay/order',
            method: 'post',
            body: { orderId: 'order-1' },
        });

        expect(res.statusCode).toBe(401);
        expect(res.body).toEqual({
            success: false,
            message: 'The key_id/key_secret provided is invalid.',
        });
        expect(save).not.toHaveBeenCalled();
    });
});
