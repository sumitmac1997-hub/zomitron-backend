const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const compression = require('compression');
const dotenv = require('dotenv');
const rateLimit = require('express-rate-limit');
const path = require('path');
const mongoose = require('mongoose');
const { randomUUID } = require('crypto');

dotenv.config();

const { syncDefaultCategories } = require('./utils/syncDefaultCategories');
const { initMonitoring, captureException, captureMessage } = require('./utils/monitoring');
const { connectRedis, disconnectRedis } = require('./redis');
const { hasCloudinaryConfig } = require('./config/cloudinary');

initMonitoring();

const parseBoolean = (value) => ['true', '1', 'yes', 'on'].includes(String(value || '').toLowerCase());
const parseNumber = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};
const parseList = (value) => String(value || '')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);

const connectDB = require('./config/db');
const { initSocket } = require('./config/socket');

const app = express();
const server = http.createServer(app);
const isProduction = process.env.NODE_ENV === 'production';
const requestSlowLogThresholdMs = parseNumber(process.env.SLOW_REQUEST_THRESHOLD_MS, 1500);
const configuredOrigins = [...new Set([
  ...parseList(process.env.ALLOWED_ORIGINS),
  ...(process.env.CLIENT_URL ? [process.env.CLIENT_URL.trim()] : []),
])];
const isAllowedOrigin = (origin) => {
  if (!origin) return true;
  if (configuredOrigins.length === 0) {
    return !isProduction || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
  }
  return configuredOrigins.includes(origin);
};
const corsOptions = {
  origin(origin, callback) {
    if (isAllowedOrigin(origin)) {
      return callback(null, true);
    }
    const error = new Error('Origin not allowed by CORS policy');
    error.statusCode = 403;
    return callback(error);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
  optionsSuccessStatus: 200,
};

app.disable('x-powered-by');
app.set('trust proxy', 1);

// Socket.io setup (mirror origin to avoid CORS blocks in production)
const io = socketIo(server, {
  cors: {
    origin: (origin, callback) => callback(null, isAllowedOrigin(origin)),
    methods: ['GET', 'POST'],
    credentials: true,
  },
});
initSocket(io);
app.set('io', io);

// Security Middleware
app.use(helmet({
  crossOriginEmbedderPolicy: false,
  contentSecurityPolicy: false,
}));

app.use((req, res, next) => {
  req.requestId = req.headers['x-request-id'] || randomUUID();
  req.requestStart = process.hrtime.bigint();
  res.setHeader('X-Request-Id', req.requestId);
  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - req.requestStart) / 1e6;
    if (durationMs >= requestSlowLogThresholdMs) {
      console.warn(`[slow-request] ${req.requestId} ${req.method} ${req.originalUrl} ${res.statusCode} ${durationMs.toFixed(1)}ms`);
      captureMessage('slow_request_detected', 'warning', {
        requestId: req.requestId,
        method: req.method,
        path: req.originalUrl,
        statusCode: res.statusCode,
        durationMs,
      });
    }
  });
  next();
});

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

// Rate Limiting
const apiRateLimitDisabled = parseBoolean(process.env.DISABLE_API_RATE_LIMIT);
const apiRateLimitWindowMs = parseNumber(process.env.API_RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000);
const apiRateLimitMax = parseNumber(process.env.API_RATE_LIMIT_MAX, 200);
const authRateLimitWindowMs = parseNumber(process.env.AUTH_RATE_LIMIT_WINDOW_MS, 60 * 60 * 1000);
const authRateLimitMax = parseNumber(process.env.AUTH_RATE_LIMIT_MAX, 20);
const orderRateLimitWindowMs = parseNumber(process.env.ORDER_RATE_LIMIT_WINDOW_MS, 5 * 60 * 1000);
const orderRateLimitMax = parseNumber(process.env.ORDER_RATE_LIMIT_MAX, 40);
const paymentRateLimitWindowMs = parseNumber(process.env.PAYMENT_RATE_LIMIT_WINDOW_MS, 10 * 60 * 1000);
const paymentRateLimitMax = parseNumber(process.env.PAYMENT_RATE_LIMIT_MAX, 30);
const createLimiter = ({ windowMs, max, message }) => rateLimit({
  windowMs,
  max,
  standardHeaders: true,
  legacyHeaders: false,
  message,
});

if (apiRateLimitDisabled) {
  console.warn('API rate limiter disabled via DISABLE_API_RATE_LIMIT.');
} else {
  const limiter = createLimiter({
    windowMs: apiRateLimitWindowMs,
    max: apiRateLimitMax,
    message: { success: false, message: 'Too many requests, please try again later.' },
  });
  app.use('/api/', limiter);
}

// Auth rate limit (stricter)
const authLimiter = createLimiter({
  windowMs: authRateLimitWindowMs,
  max: authRateLimitMax,
  message: { success: false, message: 'Too many auth attempts, try again in an hour.' },
});
const orderLimiter = createLimiter({
  windowMs: orderRateLimitWindowMs,
  max: orderRateLimitMax,
  message: { success: false, message: 'Too many checkout attempts. Please wait a moment and try again.' },
});
const paymentLimiter = createLimiter({
  windowMs: paymentRateLimitWindowMs,
  max: paymentRateLimitMax,
  message: { success: false, message: 'Too many payment requests. Please try again shortly.' },
});

// Body Parsers
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(compression({
  threshold: Number(process.env.COMPRESSION_THRESHOLD_BYTES) || 1024,
  filter: (req, res) => {
    if (req.headers['x-no-compression']) return false;
    return compression.filter(req, res);
  },
}));

// Logging
if (process.env.NODE_ENV !== 'test') {
  morgan.token('requestId', (req) => req.requestId);
  app.use(morgan(':requestId :method :url :status :response-time ms'));
}

// Health Check
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    service: 'Zomitron API',
    uptimeSeconds: Math.round(process.uptime()),
    mongoState: mongoose.connection.readyState,
    uploads: {
      cloudinaryConfigured: hasCloudinaryConfig,
    },
  });
});

// API Routes
app.use('/api/auth', authLimiter, require('./routes/auth'));
app.use('/api/vendors', require('./routes/vendor'));
app.use('/api/products', require('./routes/product'));
app.use('/api/orders', orderLimiter, require('./routes/order'));
app.use('/api/categories', require('./routes/category'));
app.use('/api/reviews', require('./routes/review'));
app.use('/api/payments', paymentLimiter, require('./routes/payment'));
app.use('/api/taxes', require('./routes/tax'));
app.use('/api/shipping', require('./routes/shipping'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/pincode', require('./routes/pincode'));
app.use('/api/notifications', require('./routes/notification'));
app.use('/api/coupons', require('./routes/coupon'));

// 404 Handler
app.use((req, res) => {
  res.status(404).json({ success: false, message: 'Route not found' });
});

// Global Error Handler
app.use((err, req, res, next) => {
  const validationMessage = err?.name === 'ValidationError'
    ? Object.values(err.errors || {})[0]?.message || err.message
    : null;
  const duplicateKeyMessage = err?.code === 11000
    ? `${Object.keys(err.keyPattern || {})[0] || 'Field'} already exists`
    : null;
  const statusCode = err.statusCode
    || (err?.name === 'ValidationError' ? 400 : undefined)
    || (err?.code === 11000 ? 400 : undefined)
    || 500;
  const responseMessage = validationMessage || duplicateKeyMessage || err.message || 'Internal Server Error';

  if (statusCode >= 500) {
    captureException(err, {
      requestId: req.requestId,
      method: req.method,
      path: req.originalUrl,
      query: req.query,
    });
  }
  console.error(`Error [${req.requestId || 'n/a'}]:`, err.stack || err.message);
  res.status(statusCode).json({
    success: false,
    message: responseMessage,
    requestId: req.requestId,
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
});

const PORT = Number(process.env.PORT) || 5000;
const HOST = process.env.HOST || '0.0.0.0';

const startServer = () => {
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${PORT} is already in use. Stop the process using this port or change PORT in backend/.env.`);
      process.exit(1);
    }
    if (err.code === 'EPERM') {
      console.error(`Permission denied while binding ${HOST}:${PORT}. Try HOST=127.0.0.1 or use a different PORT.`);
      process.exit(1);
    }
    console.error('Server failed to start:', err.message);
    process.exit(1);
  });

  server.listen(PORT, HOST, () => {
    console.log(`🚀 Zomitron API running on http://${HOST}:${PORT} in ${process.env.NODE_ENV || 'development'} mode`);
    console.log(hasCloudinaryConfig ? '🖼️ Cloudinary uploads enabled' : '⚠️ Cloudinary uploads disabled: product image saves will fail until Cloudinary env vars are loaded');
  });
};

const registerShutdownHandlers = () => {
  let shuttingDown = false;

  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Received ${signal}. Shutting down gracefully...`);

    server.close(async () => {
      try {
        await disconnectRedis();
      } catch (error) {
        console.error('Error while closing Redis connection:', error.message);
      }
      try {
        await mongoose.connection.close(false);
      } catch (error) {
        console.error('Error while closing Mongo connection:', error.message);
      }
      process.exit(0);
    });

    setTimeout(() => {
      console.error('Forced shutdown after timeout.');
      process.exit(1);
    }, parseNumber(process.env.SHUTDOWN_TIMEOUT_MS, 10000)).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
};

if (process.env.NODE_ENV !== 'test') {
  const bootstrap = async () => {
    try {
      await connectDB();
      await connectRedis();
      try {
        await syncDefaultCategories();
      } catch (err) {
        console.error('Category sync failed on startup:', err.message);
      }
      startServer();
      registerShutdownHandlers();
    } catch (err) {
      console.error('Startup failed:', err.message);
      process.exit(1);
    }
  };

  bootstrap();
}

module.exports = { app, server };
