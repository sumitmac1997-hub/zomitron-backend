const axios = require('axios');

/**
 * Get approximate location from IP address
 * Primary: ipapi.co (free tier: 1000 req/day)
 * Fallback: ip-api.com (free, no HTTPS on free tier)
 */
const getLocationFromIP = async (ip) => {
    // Skip for localhost
    if (!ip || ip === '127.0.0.1' || ip === '::1' || ip.startsWith('192.168') || ip.startsWith('10.')) {
        // Return Prayagraj as default for development
        return {
            lat: 25.4358,
            lng: 81.8463,
            city: 'Prayagraj',
            state: 'Uttar Pradesh',
            country: 'India',
            pincode: '211001',
            source: 'default_dev',
        };
    }

    // Try ipapi.co
    try {
        const key = process.env.IPAPI_KEY ? `?key=${process.env.IPAPI_KEY}` : '';
        const res = await axios.get(`https://ipapi.co/${ip}/json/${key}`, { timeout: 3000 });
        if (res.data && res.data.latitude) {
            return {
                lat: res.data.latitude,
                lng: res.data.longitude,
                city: res.data.city,
                state: res.data.region,
                country: res.data.country_name,
                pincode: res.data.postal,
                source: 'ipapi.co',
            };
        }
    } catch (err) {
        console.log('ipapi.co failed, trying fallback');
    }

    // Try ip-api.com fallback
    try {
        const res = await axios.get(`http://ip-api.com/json/${ip}?fields=status,city,regionName,lat,lon,zip,country`, { timeout: 3000 });
        if (res.data?.status === 'success') {
            return {
                lat: res.data.lat,
                lng: res.data.lon,
                city: res.data.city,
                state: res.data.regionName,
                country: res.data.country,
                pincode: res.data.zip,
                source: 'ip-api.com',
            };
        }
    } catch (err) {
        console.log('ip-api.com also failed');
    }

    // Final fallback: New Delhi
    return {
        lat: 28.6139,
        lng: 77.2090,
        city: 'New Delhi',
        state: 'Delhi',
        country: 'India',
        pincode: '110001',
        source: 'default',
    };
};

/**
 * Extract real IP from request (handles proxies/load balancers)
 */
const getRealIP = (req) => {
    return (
        req.headers['x-forwarded-for']?.split(',')[0].trim() ||
        req.headers['x-real-ip'] ||
        req.connection?.remoteAddress ||
        req.socket?.remoteAddress ||
        '127.0.0.1'
    );
};

module.exports = { getLocationFromIP, getRealIP };
