const { haversineDistance, isWithinRadius, filterByRadius } = require('../utils/haversine');
const { getDeliveryInfo } = require('../utils/deliveryETA');

describe('Haversine Distance', () => {
    test('Distance between same points should be 0', () => {
        expect(haversineDistance(25.4358, 81.8463, 25.4358, 81.8463)).toBe(0);
    });

    test('Distance Prayagraj to Kanpur (~130km)', () => {
        const dist = haversineDistance(25.4358, 81.8463, 26.4499, 80.3319);
        expect(dist).toBeGreaterThan(120);
        expect(dist).toBeLessThan(160);
    });

    test('Distance Prayagraj to Varanasi (~130km)', () => {
        const dist = haversineDistance(25.4358, 81.8463, 25.3176, 82.9739);
        expect(dist).toBeGreaterThan(100);
        expect(dist).toBeLessThan(150);
    });

    test('Distance Prayagraj to Bangalore (~1600km)', () => {
        const dist = haversineDistance(25.4358, 81.8463, 12.9716, 77.5946);
        expect(dist).toBeGreaterThan(1500);
        expect(dist).toBeLessThan(1800);
    });

    test('isWithinRadius - nearby vendor (true)', () => {
        // Civil Lines to Hazratganj Prayagraj (~2km)
        expect(isWithinRadius(25.4358, 81.8463, 25.4484, 81.8322, 10)).toBe(true);
    });

    test('isWithinRadius - far-away vendor (false)', () => {
        // Prayagraj to Bangalore (~1600km), radius 100km
        expect(isWithinRadius(25.4358, 81.8463, 12.9716, 77.5946, 100)).toBe(false);
    });
});

describe('Geo-filtering', () => {
    const mockProducts = [
        // ~2km from Prayagraj center — WITHIN 100km
        { _id: '1', title: 'Near Product', location: { coordinates: [81.8322, 25.4484] } },
        // Varanasi ~130km — OUTSIDE 100km
        { _id: '2', title: 'Varanasi Product', location: { coordinates: [82.9739, 25.3176] } },
        // Kanpur ~130km — OUTSIDE 100km
        { _id: '3', title: 'Kanpur Product', location: { coordinates: [80.3319, 26.4499] } },
        // Prayagraj ~5km — WITHIN 100km
        { _id: '4', title: 'Close Product', location: { coordinates: [81.8679, 25.4670] } },
        // Bangalore ~1600km — OUTSIDE 100km
        { _id: '5', title: 'Bangalore Product', location: { coordinates: [77.5946, 12.9716] } },
    ];

    test('filterByRadius returns only products within 100km of Prayagraj', () => {
        const customerLat = 25.4358;
        const customerLng = 81.8463;
        const nearby = filterByRadius(mockProducts, customerLat, customerLng, 100);
        expect(nearby.length).toBe(2); // Products 1 and 4
        expect(nearby.some(p => p._id === '1')).toBe(true);
        expect(nearby.some(p => p._id === '4')).toBe(true);
        expect(nearby.some(p => p._id === '2')).toBe(false);
        expect(nearby.some(p => p._id === '5')).toBe(false);
    });

    test('filterByRadius results are sorted by distance (nearest first)', () => {
        const nearby = filterByRadius(mockProducts, 25.4358, 81.8463, 100);
        expect(nearby[0].distance).toBeLessThanOrEqual(nearby[1].distance);
    });

    test('filterByRadius returns empty array for remote customer', () => {
        // Customer in USA — no Indian vendors within 100km
        const nearby = filterByRadius(mockProducts, 40.7128, -74.0060, 100);
        expect(nearby.length).toBe(0);
    });
});

describe('Delivery ETA', () => {
    test('0-5km: 1 hour delivery', () => {
        const info = getDeliveryInfo(3);
        expect(info.badge).toBe('1hr');
        expect(info.etaType).toBe('express');
        expect(info.deliveryCharge).toBe(0);
    });

    test('5-60km: 2 hour delivery', () => {
        const info = getDeliveryInfo(30);
        expect(info.badge).toBe('2hr');
        expect(info.etaType).toBe('fast');
    });

    test('60-100km: 1 day delivery', () => {
        const info = getDeliveryInfo(80);
        expect(info.badge).toBe('1day');
        expect(info.etaType).toBe('standard');
    });

    test('100-500km: 2-3 days delivery', () => {
        const info = getDeliveryInfo(200);
        expect(info.badge).toBe('2-3days');
        expect(info.etaType).toBe('normal');
    });

    test('>500km: 5-7 days delivery', () => {
        const info = getDeliveryInfo(1600);
        expect(info.badge).toBe('5-7days');
        expect(info.etaType).toBe('slow');
    });
});
