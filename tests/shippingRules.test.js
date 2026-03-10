const {
    parsePincodeRanges,
    isPincodeInRanges,
    calculateShippingQuote,
} = require('../utils/shippingRules');

describe('shipping rule utilities', () => {
    test('parses pincode ranges and single pincodes', () => {
        expect(parsePincodeRanges('221001-221108, 221120')).toEqual([
            { start: '221001', end: '221108' },
            { start: '221120', end: '221120' },
        ]);
    });

    test('matches a pincode inside a configured range', () => {
        expect(isPincodeInRanges('221050', [{ start: '221001', end: '221108' }])).toBe(true);
        expect(isPincodeInRanges('221200', [{ start: '221001', end: '221108' }])).toBe(false);
    });

    test('charges shipping only below the configured threshold', () => {
        const quote = calculateShippingQuote(
            { city: 'Varanasi', pincode: '221005', subtotal: 180, discount: 0 },
            [{ _id: 'rule-1', city: 'Varanasi', cityNormalized: 'varanasi', shippingCharge: 50, freeShippingThreshold: 200 }]
        );

        expect(quote).toEqual(expect.objectContaining({
            matched: true,
            shippingCharge: 50,
            freeShippingThreshold: 200,
            matchingMode: 'city',
        }));

        const freeQuote = calculateShippingQuote(
            { city: 'Varanasi', pincode: '221005', subtotal: 250, discount: 0 },
            [{ _id: 'rule-1', city: 'Varanasi', cityNormalized: 'varanasi', shippingCharge: 50, freeShippingThreshold: 200 }]
        );

        expect(freeQuote.shippingCharge).toBe(0);
    });

    test('marks city as unavailable when the spelling does not match an admin rule', () => {
        const quote = calculateShippingQuote(
            { city: 'Varanas', pincode: '221005', subtotal: 180, discount: 0 },
            [{ _id: 'rule-1', city: 'Varanasi', cityNormalized: 'varanasi', shippingCharge: 50, freeShippingThreshold: 200 }]
        );

        expect(quote).toEqual(expect.objectContaining({
            matched: false,
            serviceAvailable: false,
            shippingCharge: 0,
            message: 'Service is not available in this city',
        }));
    });

    test('prefers a matching pincode rule over a city-wide rule', () => {
        const quote = calculateShippingQuote(
            { city: 'Varanasi', pincode: '221050', subtotal: 150, discount: 0 },
            [
                { _id: 'city-rule', city: 'Varanasi', cityNormalized: 'varanasi', shippingCharge: 40, freeShippingThreshold: 300 },
                {
                    _id: 'range-rule',
                    city: 'Varanasi',
                    cityNormalized: 'varanasi',
                    shippingCharge: 60,
                    freeShippingThreshold: 250,
                    pincodeRanges: [{ start: '221001', end: '221108' }],
                },
            ]
        );

        expect(quote).toEqual(expect.objectContaining({
            ruleId: 'range-rule',
            shippingCharge: 60,
            matchingMode: 'pincode',
        }));
    });
});
