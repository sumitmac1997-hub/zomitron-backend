const MOBILE_NUMBER_REGEX = /^[6-9]\d{9}$/;

const normalizeIndianMobileNumber = (value) => {
    if (value === undefined || value === null) return undefined;

    const digits = String(value).replace(/\D/g, '');
    if (!digits) return undefined;

    if (digits.length === 10 && MOBILE_NUMBER_REGEX.test(digits)) {
        return digits;
    }

    if (digits.length === 12 && digits.startsWith('91')) {
        const localNumber = digits.slice(2);
        return MOBILE_NUMBER_REGEX.test(localNumber) ? localNumber : undefined;
    }

    return undefined;
};

const isValidIndianMobileNumber = (value) => Boolean(normalizeIndianMobileNumber(value));

const toIndianE164 = (value) => {
    const normalized = normalizeIndianMobileNumber(value);
    return normalized ? `+91${normalized}` : undefined;
};

module.exports = {
    MOBILE_NUMBER_REGEX,
    normalizeIndianMobileNumber,
    isValidIndianMobileNumber,
    toIndianE164,
};
