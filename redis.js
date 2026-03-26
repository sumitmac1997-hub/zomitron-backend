const { createClient } = require('redis');

let redisClient;
let connectPromise;
let redisDisabledLogged = false;

const parseBoolean = (value) => ['true', '1', 'yes', 'on'].includes(String(value || '').toLowerCase());

const getRedisConfig = () => {
    const hasExplicitConfig = Boolean(process.env.REDIS_URL || process.env.REDIS_HOST || process.env.REDIS_PORT);
    const enabled = parseBoolean(process.env.REDIS_ENABLED) || hasExplicitConfig;
    const required = parseBoolean(process.env.REDIS_REQUIRED);
    const url = process.env.REDIS_URL || (enabled
        ? `redis://${process.env.REDIS_HOST || '127.0.0.1'}:${Number(process.env.REDIS_PORT) || 6379}`
        : null);
    const connectTimeoutMs = Number(process.env.REDIS_CONNECT_TIMEOUT_MS) || 5000;
    const maxRetries = Number(process.env.REDIS_MAX_RETRIES) || 3;

    return {
        enabled,
        required,
        url,
        connectTimeoutMs,
        maxRetries,
    };
};

const logRedisDisabled = () => {
    if (redisDisabledLogged) return;
    redisDisabledLogged = true;
    console.warn('Redis is disabled. Set REDIS_URL or REDIS_ENABLED=true to enable cache-backed features.');
};

const getRedisClient = () => {
    const { enabled, url, connectTimeoutMs, maxRetries, required } = getRedisConfig();

    if (!enabled || !url) {
        logRedisDisabled();
        return null;
    }

    if (redisClient) return redisClient;

    redisClient = createClient({
        url,
        socket: {
            connectTimeout: connectTimeoutMs,
            reconnectStrategy(retries) {
                if (!required && retries >= maxRetries) {
                    console.warn(`Redis reconnect limit reached (${maxRetries}). Continuing without Redis.`);
                    return false;
                }
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
    const { required } = getRedisConfig();
    const client = getRedisClient();
    if (!client) return null;

    if (client.isOpen || client.isReady) return client;
    if (connectPromise) return connectPromise;

    connectPromise = client.connect()
        .then(() => {
            console.log('✅ Redis connected');
            return client;
        })
        .catch(async (error) => {
            console.error(`Redis connection failed: ${error.message}`);
            if (client.isOpen) {
                try {
                    await client.quit();
                } catch (quitError) {
                    console.error(`Redis shutdown failed after connection error: ${quitError.message}`);
                    client.disconnect();
                }
            }
            redisClient = null;
            if (required) throw error;
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
