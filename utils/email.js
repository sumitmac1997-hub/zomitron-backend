const nodemailer = require('nodemailer');

const TRUE_VALUES = new Set(['true', '1', 'yes', 'on']);
const RETRYABLE_MAIL_CODES = new Set([
    'ECONNECTION',
    'ECONNRESET',
    'EDNS',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'ESOCKET',
    'ETIMEDOUT',
]);

let cachedTransporter = null;
let cachedTransportKey = null;

const normalizeOptionalString = (value) => {
    if (value === undefined || value === null) return undefined;
    const normalized = String(value).trim();
    return normalized ? normalized : undefined;
};

const parseBoolean = (value) => TRUE_VALUES.has(String(value || '').trim().toLowerCase());

const parsePositiveNumber = (value, fallback) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const withTimeout = (promise, timeoutMs, message) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);

    promise
        .then((value) => {
            clearTimeout(timer);
            resolve(value);
        })
        .catch((error) => {
            clearTimeout(timer);
            reject(error);
        });
});

const buildEmailConfig = () => {
    const user = normalizeOptionalString(process.env.SMTP_USER || process.env.SMTP_USERNAME || process.env.EMAIL_USER);
    const pass = normalizeOptionalString(process.env.SMTP_PASS || process.env.SMTP_PASSWORD || process.env.EMAIL_PASS);
    const host = normalizeOptionalString(process.env.SMTP_HOST || process.env.EMAIL_HOST);
    const service = normalizeOptionalString(process.env.SMTP_SERVICE || process.env.EMAIL_SERVICE);
    const from = normalizeOptionalString(process.env.EMAIL_FROM || process.env.SMTP_FROM || user);
    const port = parsePositiveNumber(process.env.SMTP_PORT || process.env.EMAIL_PORT, 587);
    const secure = process.env.SMTP_SECURE !== undefined
        ? parseBoolean(process.env.SMTP_SECURE)
        : port === 465;
    const connectionTimeoutMs = parsePositiveNumber(process.env.SMTP_CONNECTION_TIMEOUT_MS, 15000);
    const greetingTimeoutMs = parsePositiveNumber(process.env.SMTP_GREETING_TIMEOUT_MS, 15000);
    const dnsTimeoutMs = parsePositiveNumber(process.env.SMTP_DNS_TIMEOUT_MS, 15000);
    const socketTimeoutMs = parsePositiveNumber(process.env.SMTP_SOCKET_TIMEOUT_MS, 60000);
    const minimumSendTimeoutMs = Math.max(socketTimeoutMs, connectionTimeoutMs + greetingTimeoutMs + 5000, 30000);
    const sendTimeoutMs = Math.max(
        parsePositiveNumber(process.env.SMTP_SEND_TIMEOUT_MS, minimumSendTimeoutMs),
        minimumSendTimeoutMs
    );

    return {
        user,
        pass,
        host,
        port,
        service,
        from,
        secure,
        ignoreTlsErrors: parseBoolean(process.env.SMTP_IGNORE_TLS_ERRORS),
        requireTls: parseBoolean(process.env.SMTP_REQUIRE_TLS),
        ignoreTls: parseBoolean(process.env.SMTP_IGNORE_TLS),
        connectionTimeoutMs,
        greetingTimeoutMs,
        dnsTimeoutMs,
        socketTimeoutMs,
        sendTimeoutMs,
        retryConnectionTimeoutMs: parsePositiveNumber(
            process.env.SMTP_RETRY_CONNECTION_TIMEOUT_MS,
            Math.max(connectionTimeoutMs * 2, 15000)
        ),
        retryGreetingTimeoutMs: parsePositiveNumber(
            process.env.SMTP_RETRY_GREETING_TIMEOUT_MS,
            Math.max(greetingTimeoutMs * 2, 15000)
        ),
        retryDnsTimeoutMs: parsePositiveNumber(
            process.env.SMTP_RETRY_DNS_TIMEOUT_MS,
            Math.max(dnsTimeoutMs * 2, 15000)
        ),
        retrySocketTimeoutMs: parsePositiveNumber(
            process.env.SMTP_RETRY_SOCKET_TIMEOUT_MS,
            Math.max(socketTimeoutMs * 2, 60000)
        ),
        retrySendTimeoutMs: parsePositiveNumber(
            process.env.SMTP_RETRY_SEND_TIMEOUT_MS,
            Math.max(sendTimeoutMs * 2, 60000)
        ),
    };
};

const buildTransportKey = (config) => JSON.stringify({
    user: config.user,
    pass: config.pass,
    host: config.host,
    port: config.port,
    service: config.service,
    secure: config.secure,
    ignoreTlsErrors: config.ignoreTlsErrors,
    requireTls: config.requireTls,
    ignoreTls: config.ignoreTls,
    connectionTimeoutMs: config.connectionTimeoutMs,
    greetingTimeoutMs: config.greetingTimeoutMs,
    dnsTimeoutMs: config.dnsTimeoutMs,
    socketTimeoutMs: config.socketTimeoutMs,
});

const buildMailTransportOptions = (config, overrides = {}) => {
    const transportOptions = {
        auth: { user: config.user, pass: config.pass },
        connectionTimeout: overrides.connectionTimeoutMs ?? config.connectionTimeoutMs,
        greetingTimeout: overrides.greetingTimeoutMs ?? config.greetingTimeoutMs,
        dnsTimeout: overrides.dnsTimeoutMs ?? config.dnsTimeoutMs,
        socketTimeout: overrides.socketTimeoutMs ?? config.socketTimeoutMs,
    };

    if (config.requireTls) {
        transportOptions.requireTLS = true;
    }

    if (config.ignoreTls) {
        transportOptions.ignoreTLS = true;
    }

    const tlsOptions = {};
    if (config.host) {
        tlsOptions.servername = config.host;
    }
    if (config.ignoreTlsErrors) {
        tlsOptions.rejectUnauthorized = false;
    }
    if (Object.keys(tlsOptions).length > 0) {
        transportOptions.tls = tlsOptions;
    }

    return transportOptions;
};

const createTransporter = (config, overrides = {}) => {
    if (process.env.NODE_ENV === 'test') {
        return nodemailer.createTransport({ jsonTransport: true });
    }

    if (!config.user || !config.pass) {
        return null;
    }

    if (config.service) {
        return nodemailer.createTransport({
            service: config.service,
            ...buildMailTransportOptions(config, overrides),
        });
    }

    if (config.host) {
        return nodemailer.createTransport({
            host: config.host,
            port: config.port,
            secure: overrides.secure ?? config.secure,
            ...buildMailTransportOptions(config, overrides),
        });
    }

    return null;
};

const closeTransporter = (transporter) => {
    if (!transporter || typeof transporter.close !== 'function') return;
    transporter.close();
};

const getTransporter = (config) => {
    if (process.env.NODE_ENV === 'test') {
        return createTransporter(config);
    }

    const transportKey = buildTransportKey(config);
    if (!cachedTransporter || cachedTransportKey !== transportKey) {
        closeTransporter(cachedTransporter);
        cachedTransporter = createTransporter(config);
        cachedTransportKey = transportKey;
    }

    return cachedTransporter;
};

const resetEmailTransporterCache = () => {
    closeTransporter(cachedTransporter);
    cachedTransporter = null;
    cachedTransportKey = null;
};

const assertEmailConfig = (config) => {
    if (process.env.NODE_ENV === 'test') return;

    if (!config.user || !config.pass) {
        throw new Error('Email credentials are missing. Set SMTP_USER/SMTP_PASS or EMAIL_USER/EMAIL_PASS.');
    }

    if (!config.host && !config.service) {
        throw new Error('Email server is missing. Set SMTP_HOST or SMTP_SERVICE in backend .env.');
    }
};

const isRetryableMailError = (error) => {
    const code = String(error?.code || '').toUpperCase();
    if (RETRYABLE_MAIL_CODES.has(code)) {
        return true;
    }

    const message = String(error?.message || '').toLowerCase();
    return (
        message.includes('connection timeout') ||
        message.includes('greeting never received') ||
        message.includes('getaddrinfo enotfound') ||
        message.includes('temporary failure in name resolution') ||
        message.includes('querya etimedout')
    );
};

const sendWithTimeout = (transporter, config, mailOptions) => withTimeout(
    transporter.sendMail(mailOptions),
    config.sendTimeoutMs,
    `Email sending timed out after ${config.sendTimeoutMs}ms.`
);

const sendEmail = async (to, subject, html) => {
    const config = buildEmailConfig();
    assertEmailConfig(config);

    const transporter = getTransporter(config);
    if (!transporter) {
        throw new Error('Email transport is not configured.');
    }

    const mailOptions = {
        from: config.from,
        to,
        subject,
        html,
    };

    try {
        return await sendWithTimeout(transporter, config, mailOptions);
    } catch (error) {
        if (process.env.NODE_ENV === 'test' || !isRetryableMailError(error)) {
            throw error;
        }

        const retryConfig = {
            ...config,
            connectionTimeoutMs: config.retryConnectionTimeoutMs,
            greetingTimeoutMs: config.retryGreetingTimeoutMs,
            dnsTimeoutMs: config.retryDnsTimeoutMs,
            socketTimeoutMs: config.retrySocketTimeoutMs,
            sendTimeoutMs: Math.max(config.retrySendTimeoutMs, config.retrySocketTimeoutMs),
        };

        console.warn(
            `[email] SMTP send failed via ${config.service || config.host || 'configured SMTP'}${config.port ? `:${config.port}` : ''} (${error.code || error.message}). Retrying once with extended timeouts.`
        );

        const retryTransporter = createTransporter(retryConfig);
        if (!retryTransporter) {
            throw error;
        }

        try {
            return await sendWithTimeout(retryTransporter, retryConfig, mailOptions);
        } finally {
            closeTransporter(retryTransporter);
        }
    }
};

module.exports = {
    sendEmail,
    __private__: {
        assertEmailConfig,
        buildEmailConfig,
        buildMailTransportOptions,
        createTransporter,
        isRetryableMailError,
        resetEmailTransporterCache,
        withTimeout,
    },
};
