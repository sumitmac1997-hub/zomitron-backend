const Sentry = require('@sentry/node');

let monitoringEnabled = false;

const parseNumber = (value, fallback) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
};

const initMonitoring = () => {
    if (monitoringEnabled) return Sentry;

    if (!process.env.SENTRY_DSN) {
        return null;
    }

    Sentry.init({
        dsn: process.env.SENTRY_DSN,
        environment: process.env.NODE_ENV || 'development',
        release: process.env.SENTRY_RELEASE || process.env.APP_RELEASE,
        tracesSampleRate: parseNumber(process.env.SENTRY_TRACES_SAMPLE_RATE, 0.1),
        profilesSampleRate: parseNumber(process.env.SENTRY_PROFILES_SAMPLE_RATE, 0.05),
        sendDefaultPii: false,
        integrations: [
            Sentry.httpIntegration(),
            Sentry.expressIntegration(),
            Sentry.mongooseIntegration(),
        ],
    });

    monitoringEnabled = true;
    return Sentry;
};

const captureException = (error, context = {}) => {
    if (!monitoringEnabled) return;

    Sentry.withScope((scope) => {
        Object.entries(context).forEach(([key, value]) => {
            scope.setExtra(key, value);
        });
        Sentry.captureException(error);
    });
};

const captureMessage = (message, level = 'info', context = {}) => {
    if (!monitoringEnabled) return;

    Sentry.withScope((scope) => {
        scope.setLevel(level);
        Object.entries(context).forEach(([key, value]) => {
            scope.setExtra(key, value);
        });
        Sentry.captureMessage(message);
    });
};

module.exports = {
    initMonitoring,
    captureException,
    captureMessage,
};
