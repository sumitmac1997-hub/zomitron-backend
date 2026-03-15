const normalizeCity = (city = '') => String(city).trim().toLowerCase().replace(/\s+/g, ' ');

const normalizePincode = (pincode = '') => String(pincode).replace(/\D/g, '').slice(0, 6);

const parsePincodeRanges = (input) => {
    const rawEntries = Array.isArray(input)
        ? input
        : String(input || '')
            .split(',')
            .map((entry) => entry.trim())
            .filter(Boolean);

    return rawEntries
        .map((entry) => {
            if (!entry) return null;

            const source = typeof entry === 'string'
                ? (() => {
                    const [startRaw, endRaw] = entry.split('-').map((value) => value.trim());
                    return { start: startRaw, end: endRaw || startRaw };
                })()
                : {
                    start: entry.start,
                    end: entry.end || entry.start,
                };

            const start = normalizePincode(source.start);
            const end = normalizePincode(source.end);
            if (!start || start.length !== 6 || !end || end.length !== 6) return null;

            return start <= end ? { start, end } : { start: end, end: start };
        })
        .filter(Boolean);
};

const formatPincodeRanges = (ranges = []) => parsePincodeRanges(ranges)
    .map((range) => (range.start === range.end ? range.start : `${range.start}-${range.end}`))
    .join(', ');

const isPincodeInRanges = (pincode, ranges = []) => {
    const normalizedPincode = normalizePincode(pincode);
    if (!normalizedPincode || normalizedPincode.length !== 6) return false;

    return parsePincodeRanges(ranges).some((range) => (
        normalizedPincode >= range.start && normalizedPincode <= range.end
    ));
};

// Matcher: only match on exact city name or a wildcard ('*') rule.
// Returns null if the entered city is not covered by any active rule.
const pickShippingRule = ({ city, pincode }, rules = []) => {
    const cityNormalized = normalizeCity(city);
    const activeRules = rules.filter((rule) => rule?.isActive !== false);

    // Filter rules by city
    const cityRules = activeRules.filter((rule) => normalizeCity(rule.cityNormalized || rule.city) === cityNormalized);

    // 1) Exact city match + Pincode match
    const exactPincodeRule = cityRules.find((rule) => isPincodeInRanges(pincode, rule.pincodeRanges));
    if (exactPincodeRule) return { rule: exactPincodeRule, ranges: parsePincodeRanges(exactPincodeRule.pincodeRanges), priority: 4 };

    // 2) Exact city match (general city-wide rule without pincode requirements)
    // A rule with empty pincode ranges is considered city-wide
    const cityWideRule = cityRules.find((rule) => {
        const parsed = parsePincodeRanges(rule.pincodeRanges);
        return parsed.length === 0;
    });
    if (cityWideRule) return { rule: cityWideRule, ranges: [], priority: 3 };

    // 3) Wildcard rule — covers all cities (used in fresh DBs / open-delivery setups)
    const wildcardRule = activeRules.find((rule) => normalizeCity(rule.cityNormalized || rule.city) === '*');
    if (wildcardRule) return { rule: wildcardRule, ranges: parsePincodeRanges(wildcardRule.pincodeRanges), priority: 1 };

    // No match — delivery not available at this location
    return null;
};

const calculateShippingQuote = ({ city, pincode, subtotal = 0, discount = 0 }, rules = []) => {
    const orderValue = Math.max(0, Number(subtotal || 0) - Number(discount || 0));
    const matched = pickShippingRule({ city, pincode }, rules);

    if (!matched) {
        // No active shipping rule covers this city — block the order.
        return {
            shippingCharge: 0,
            baseShippingCharge: 0,
            freeShippingThreshold: 0,
            orderValue,
            isChargeApplied: false,
            matched: false,
            serviceAvailable: false,
            matchingMode: 'none',
            ruleId: null,
            city: normalizeCity(city),
            pincodeRangesText: '',
            message: 'Service is not available in this city',
        };
    }

    const baseShippingCharge = Math.max(0, Number(matched.rule.shippingCharge || 0));
    const freeShippingThreshold = Math.max(0, Number(matched.rule.freeShippingThreshold || 0));
    const isChargeApplied = orderValue < freeShippingThreshold;

    return {
        shippingCharge: isChargeApplied ? baseShippingCharge : 0,
        baseShippingCharge,
        freeShippingThreshold,
        orderValue,
        isChargeApplied,
        matched: true,
        serviceAvailable: true,
        matchingMode: matched.priority >= 4 ? 'pincode' : matched.priority >= 2 ? 'city' : 'fallback',
        ruleId: matched.rule._id || null,
        city: matched.rule.city,
        pincodeRangesText: formatPincodeRanges(matched.ranges),
        message: '',
    };
};

const serializeShippingRule = (rule) => ({
    ...rule,
    pincodeRanges: parsePincodeRanges(rule.pincodeRanges),
    pincodeRangesText: formatPincodeRanges(rule.pincodeRanges),
});

module.exports = {
    normalizeCity,
    normalizePincode,
    parsePincodeRanges,
    formatPincodeRanges,
    isPincodeInRanges,
    pickShippingRule,
    calculateShippingQuote,
    serializeShippingRule,
};
