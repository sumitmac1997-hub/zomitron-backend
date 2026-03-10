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

const pickShippingRule = ({ city, pincode }, rules = []) => {
    const cityNormalized = normalizeCity(city);
    const normalizedPincode = normalizePincode(pincode);

    const matches = rules
        .filter((rule) => rule?.isActive !== false)
        .map((rule) => {
            const ruleCity = normalizeCity(rule.cityNormalized || rule.city);
            const ranges = parsePincodeRanges(rule.pincodeRanges);
            const hasRanges = ranges.length > 0;

            if (cityNormalized && ruleCity && ruleCity !== cityNormalized) return null;
            if (!cityNormalized && !hasRanges) return null;
            if (hasRanges && !isPincodeInRanges(normalizedPincode, ranges)) return null;

            return {
                rule,
                ranges,
                priority: hasRanges ? 2 : 1,
            };
        })
        .filter(Boolean)
        .sort((a, b) => {
            if (b.priority !== a.priority) return b.priority - a.priority;

            const aUpdated = new Date(a.rule.updatedAt || a.rule.createdAt || 0).getTime();
            const bUpdated = new Date(b.rule.updatedAt || b.rule.createdAt || 0).getTime();
            return bUpdated - aUpdated;
        });

    return matches[0] || null;
};

const calculateShippingQuote = ({ city, pincode, subtotal = 0, discount = 0 }, rules = []) => {
    const orderValue = Math.max(0, Number(subtotal || 0) - Number(discount || 0));
    const matched = pickShippingRule({ city, pincode }, rules);

    if (!matched) {
        return {
            shippingCharge: 0,
            baseShippingCharge: 0,
            freeShippingThreshold: 0,
            orderValue,
            isChargeApplied: false,
            matched: false,
            serviceAvailable: false,
            matchingMode: null,
            ruleId: null,
            city: normalizeCity(city),
            pincodeRangesText: '',
            message: 'Service is not available in this city',
        };
    }

    const baseShippingCharge = Math.max(0, Number(matched.rule.shippingCharge || 0));
    const freeShippingThreshold = Math.max(0, Number(matched.rule.freeShippingThreshold || 0));
    const isChargeApplied = freeShippingThreshold > 0
        ? orderValue < freeShippingThreshold
        : baseShippingCharge > 0;

    return {
        shippingCharge: isChargeApplied ? baseShippingCharge : 0,
        baseShippingCharge,
        freeShippingThreshold,
        orderValue,
        isChargeApplied,
        matched: true,
        serviceAvailable: true,
        matchingMode: matched.priority === 2 ? 'pincode' : 'city',
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
