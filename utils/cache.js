const { getRedisClient, isRedisReady } = require('../redis');

const defaultTtlSeconds = Number(process.env.REDIS_CACHE_TTL_SECONDS) || 60;

const sortObject = (value) => {
    if (Array.isArray(value)) {
        return value.map(sortObject);
    }
    if (value && typeof value === 'object') {
        return Object.keys(value)
            .sort()
            .reduce((acc, key) => {
                acc[key] = sortObject(value[key]);
                return acc;
            }, {});
    }
    return value;
};

const buildCacheKey = (prefix, payload) => {
    if (!payload || (typeof payload === 'object' && Object.keys(payload).length === 0)) {
        return prefix;
    }

    return `${prefix}:${JSON.stringify(sortObject(payload))}`;
};

const getCacheEntry = async (key) => {
    if (!isRedisReady()) return null;

    try {
        const cached = await getRedisClient().get(key);
        return cached ? JSON.parse(cached) : null;
    } catch (error) {
        console.error(`Redis read failed for ${key}: ${error.message}`);
        return null;
    }
};

const setCacheEntry = async (key, value, ttlSeconds = defaultTtlSeconds) => {
    if (!isRedisReady()) return false;

    try {
        await getRedisClient().set(key, JSON.stringify(value), { EX: ttlSeconds });
        return true;
    } catch (error) {
        console.error(`Redis write failed for ${key}: ${error.message}`);
        return false;
    }
};

const deleteCacheKey = async (key) => {
    if (!isRedisReady()) return 0;

    try {
        const deletedCount = await getRedisClient().del(key);
        console.log(`🧹 Cache invalidated ${key}`);
        return deletedCount;
    } catch (error) {
        console.error(`Redis delete failed for ${key}: ${error.message}`);
        return 0;
    }
};

const clearCacheByPrefix = async (prefix) => {
    if (!isRedisReady()) return 0;

    try {
        const client = getRedisClient();
        const keys = [];

        for await (const key of client.scanIterator({ MATCH: `${prefix}*`, COUNT: 100 })) {
            keys.push(key);
        }

        if (keys.length === 0) {
            console.log(`🧹 Cache invalidated ${prefix}*`);
            return 0;
        }

        const deletedCount = await client.del(keys);
        console.log(`🧹 Cache invalidated ${prefix}*`);
        return deletedCount;
    } catch (error) {
        console.error(`Redis prefix delete failed for ${prefix}: ${error.message}`);
        return 0;
    }
};

module.exports = {
    buildCacheKey,
    deleteCacheKey,
    clearCacheByPrefix,
    getCacheEntry,
    setCacheEntry,
};
