const NodeCache = require('node-cache');

const defaultTtlSeconds = Number(process.env.CACHE_TTL_SECONDS) || 15;
const checkPeriodSeconds = Number(process.env.CACHE_CHECK_PERIOD_SECONDS) || Math.max(defaultTtlSeconds, 30);

const responseCache = new NodeCache({
    stdTTL: defaultTtlSeconds,
    checkperiod: checkPeriodSeconds,
    useClones: false,
});

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

const buildCacheKey = (prefix, payload) => `${prefix}:${JSON.stringify(sortObject(payload))}`;

const getCacheEntry = (key) => responseCache.get(key);

const setCacheEntry = (key, value, ttlSeconds) => responseCache.set(key, value, ttlSeconds);

const clearCacheByPrefix = (prefix) => {
    const keys = responseCache.keys().filter((key) => key.startsWith(prefix));
    if (keys.length > 0) responseCache.del(keys);
};

module.exports = {
    buildCacheKey,
    clearCacheByPrefix,
    getCacheEntry,
    setCacheEntry,
};
