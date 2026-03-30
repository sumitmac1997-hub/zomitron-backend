describe('Email Utility', () => {
    const originalEnv = process.env;

    beforeEach(() => {
        jest.resetModules();
        process.env = {
            ...originalEnv,
            NODE_ENV: 'development',
            SMTP_HOST: 'smtp.hostinger.com',
            SMTP_PORT: '465',
            SMTP_SECURE: 'true',
            SMTP_USER: 'mailer@example.com',
            SMTP_PASS: 'supersecret',
            EMAIL_FROM: 'Zomitron <mailer@example.com>',
            SMTP_CONNECTION_TIMEOUT_MS: '5000',
            SMTP_GREETING_TIMEOUT_MS: '5000',
            SMTP_SOCKET_TIMEOUT_MS: '10000',
            SMTP_SEND_TIMEOUT_MS: '8000',
        };
    });

    afterEach(() => {
        process.env = originalEnv;
        jest.restoreAllMocks();
    });

    test('buildEmailConfig keeps send timeout above the SMTP socket budget', () => {
        jest.doMock('nodemailer', () => ({
            createTransport: jest.fn(() => ({ sendMail: jest.fn(), close: jest.fn() })),
        }));

        const email = require('../utils/email');
        const config = email.__private__.buildEmailConfig();

        expect(config.dnsTimeoutMs).toBe(15000);
        expect(config.sendTimeoutMs).toBe(30000);
    });

    test('sendEmail retries once when the SMTP connection times out', async () => {
        const firstTransporter = {
            sendMail: jest.fn().mockRejectedValue(Object.assign(new Error('Connection timeout'), { code: 'ETIMEDOUT' })),
            close: jest.fn(),
        };
        const secondTransporter = {
            sendMail: jest.fn().mockResolvedValue({ messageId: 'message-1' }),
            close: jest.fn(),
        };
        const createTransport = jest
            .fn()
            .mockReturnValueOnce(firstTransporter)
            .mockReturnValueOnce(secondTransporter);

        jest.doMock('nodemailer', () => ({ createTransport }));

        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const email = require('../utils/email');

        await expect(email.sendEmail('user@example.com', 'Reset your password', '<p>Hello</p>'))
            .resolves
            .toEqual({ messageId: 'message-1' });

        expect(createTransport).toHaveBeenCalledTimes(2);
        expect(createTransport).toHaveBeenNthCalledWith(1, expect.objectContaining({
            host: 'smtp.hostinger.com',
            port: 465,
            secure: true,
            connectionTimeout: 5000,
            greetingTimeout: 5000,
            dnsTimeout: 15000,
            socketTimeout: 10000,
        }));
        expect(createTransport).toHaveBeenNthCalledWith(2, expect.objectContaining({
            host: 'smtp.hostinger.com',
            port: 465,
            secure: true,
            connectionTimeout: 15000,
            greetingTimeout: 15000,
            dnsTimeout: 30000,
            socketTimeout: 60000,
        }));
        expect(firstTransporter.sendMail).toHaveBeenCalledTimes(1);
        expect(secondTransporter.sendMail).toHaveBeenCalledTimes(1);
        expect(secondTransporter.close).toHaveBeenCalledTimes(1);
        expect(warnSpy).toHaveBeenCalledTimes(1);
    });
});
