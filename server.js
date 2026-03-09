const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const dotenv = require('dotenv');
const rateLimit = require('express-rate-limit');
const path = require('path');
const { syncDefaultCategories } = require('./utils/syncDefaultCategories');

// Load env
dotenv.config();

const connectDB = require('./config/db');
const { initSocket } = require('./config/socket');

const app = express();
const server = http.createServer(app);

// Socket.io setup
const io = socketIo(server, {
  cors: {
    origin: process.env.CLIENT_URL || 'http://localhost:5173',
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

// CORS
app.use(cors({
  origin: [
    process.env.CLIENT_URL || 'http://localhost:5173',
    'http://localhost:3000',
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// Rate Limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 200,
  message: { success: false, message: 'Too many requests, please try again later.' },
});
app.use('/api/', limiter);

// Auth rate limit (stricter)
const authLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 20,
  message: { success: false, message: 'Too many auth attempts, try again in an hour.' },
});

// Body Parsers
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Logging
if (process.env.NODE_ENV !== 'test') {
  app.use(morgan('dev'));
}

// Health Check
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString(), service: 'Zomitron API' });
});

// API Routes
app.use('/api/auth', authLimiter, require('./routes/auth'));
app.use('/api/vendors', require('./routes/vendor'));
app.use('/api/products', require('./routes/product'));
app.use('/api/orders', require('./routes/order'));
app.use('/api/categories', require('./routes/category'));
app.use('/api/reviews', require('./routes/review'));
app.use('/api/payments', require('./routes/payment'));
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
  console.error('Error:', err.stack);
  const statusCode = err.statusCode || 500;
  res.status(statusCode).json({
    success: false,
    message: err.message || 'Internal Server Error',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
});

const PORT = Number(process.env.PORT) || 5000;
const HOST = process.env.HOST || '127.0.0.1';

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
  });
};

if (process.env.NODE_ENV !== 'test') {
  const bootstrap = async () => {
    try {
      await connectDB();
      try {
        await syncDefaultCategories();
      } catch (err) {
        console.error('Category sync failed on startup:', err.message);
      }
      startServer();
    } catch (err) {
      console.error('Startup failed:', err.message);
      process.exit(1);
    }
  };

  bootstrap();
}

module.exports = { app, server };
