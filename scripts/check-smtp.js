require('dotenv').config();

const { __private__ } = require('../utils/email');

const maskEmail = (value) => {
    const [localPart = '', domain = ''] = String(value || '').split('@');
    if (!domain) return value || '<missing>';
    const localPreview = localPart.length <= 2
        ? `${localPart[0] || '*'}*`
        : `${localPart.slice(0, 2)}***`;
    return `${localPreview}@${domain}`;
};

const verifyTransport = async (label, config) => {
    console.log(`\n[${label}] ${__private__.describeTransport(config)}`);
    console.log(`user=${maskEmail(config.user)}`);

    const transporter = __private__.createTransporter(config);
    if (!transporter) {
        throw new Error('SMTP transporter could not be created. Check SMTP_USER/SMTP_PASS and SMTP_HOST/SMTP_SERVICE.');
    }

    try {
        await transporter.verify();
        console.log(`[ok] ${label} connection verified`);
        return true;
    } catch (error) {
        console.error(`[fail] ${label} ${error.code || 'ERROR'}: ${error.message}`);
        return false;
    } finally {
        __private__.closeTransporter(transporter);
    }
};

const main = async () => {
    const primaryConfig = __private__.buildEmailConfig();
    __private__.assertEmailConfig(primaryConfig);

    const retryConfig = __private__.buildRetryConfig(primaryConfig);
    const primaryOk = await verifyTransport('primary', primaryConfig);

    if (retryConfig.port !== primaryConfig.port || retryConfig.secure !== primaryConfig.secure) {
        const fallbackOk = await verifyTransport('fallback', retryConfig);
        process.exitCode = primaryOk || fallbackOk ? 0 : 1;
        return;
    }

    process.exitCode = primaryOk ? 0 : 1;
};

main().catch((error) => {
    console.error(`[error] ${error.message}`);
    process.exitCode = 1;
});
