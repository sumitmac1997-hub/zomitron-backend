const { createClient } = require('redis');

const REDIS_URL = process.env.REDIS_URL || `redis://${process.env.REDIS_HOST || '127.0.0.1'}:${Number(process.env.REDIS_PORT) || 6379}`;

let redisClient;
let connectPromise;

const getRedisClient = () => {
    if (redisClient) return redisClient;

    redisClient = createClient({
        url: REDIS_URL,
        socket: {
            reconnectStrategy(retries) {
                return Math.min(retries * 200, 5000);
            },
        },
    });

    redisClient.on('error', (error) => {
        console.error(`Redis error: ${error.message}`);
    });

    return redisClient;
};

const isRedisReady = () => Boolean(redisClient?.isOpen && redisClient?.isReady);

const connectRedis = async () => {
    const client = getRedisClient();

    if (client.isOpen || client.isReady) return client;
    if (connectPromise) return connectPromise;

    connectPromise = client.connect()
        .then(() => {
            console.log('✅ Redis connected');
            return client;
        })
        .catch((error) => {
            console.error(`Redis connection failed: ${error.message}`);
            return null;
        })
        .finally(() => {
            connectPromise = null;
        });

    return connectPromise;
};

const disconnectRedis = async () => {
    if (!redisClient?.isOpen) return;

    try {
        await redisClient.quit();
    } catch (error) {
        console.error(`Redis shutdown failed: ${error.message}`);
        redisClient.disconnect();
    }
};

module.exports = {
    connectRedis,
    disconnectRedis,
    getRedisClient,
    isRedisReady,
};
