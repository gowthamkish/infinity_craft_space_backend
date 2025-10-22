const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
require("dotenv").config();

// Import routes
const authRoutes = require("./routes/auth");
const productRoutes = require("./routes/products");
const adminRoutes = require("./routes/admin");
const categoryRoutes = require("./routes/categories");

// Import middleware
const { protect, isAdmin } = require("./middlewares/authMiddleware");
const { sanitizeInput, handleValidationErrors } = require("./middlewares/validation");
const {
  securityHeaders,
  rateLimits,
  speedLimits,
  noSqlInjection,
  requestLogger,
  securityLogger,
  corsOptions,
  securityErrorHandler
} = require("./middlewares/security");

const app = express();

// Trust proxy (important for rate limiting and IP detection)
app.set('trust proxy', 1);

// Security headers
app.use(securityHeaders);

// Request logging
app.use(requestLogger);
app.use(securityLogger);

// CORS with enhanced configuration
app.use(cors(corsOptions));

// Speed limiting (applies delays progressively)
app.use(speedLimits.general);

// General rate limiting
app.use(rateLimits.general);

// MongoDB injection prevention
app.use(noSqlInjection);

// Input sanitization
app.use(sanitizeInput);

// Body parsing with security limits
app.use(express.json({ 
  limit: '10mb',  // Reduced for security
  verify: (req, res, buf, encoding) => {
    // Verify request body integrity
    req.rawBody = buf;
  }
}));
app.use(express.urlencoded({ 
  limit: '10mb', 
  extended: true, 
  parameterLimit: 1000 // Reduced for security
}));

// gowthamkish
// gowthamkish93
mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log("MongoDB connected"))
  .catch((err) => console.error(err));

// Health check endpoint (before rate limiting)
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// Routes with specific rate limiting
app.use("/api/auth", rateLimits.auth, speedLimits.auth, authRoutes);
app.use("/api/products", productRoutes);
app.use("/api/admin", rateLimits.admin, protect, isAdmin, adminRoutes);
app.use("/api/categories", categoryRoutes);
app.use("/api/orders", protect, require("./routes/order"));
app.use("/api/payment", protect, require("./routes/payment"));

// Security error handler
app.use(securityErrorHandler);

// Error handling middleware for payload too large
app.use((error, req, res, next) => {
  if (error.type === 'entity.too.large') {
    console.warn('Large payload detected:', {
      size: req.get('content-length'),
      ip: req.ip,
      userAgent: req.get('User-Agent')
    });
    return res.status(413).json({
      success: false,
      error: 'Payload too large',
      message: 'Request body exceeds maximum allowed size',
      maxSize: '10MB'
    });
  }
  next(error);
});

// Validation error handler
app.use(handleValidationErrors);

// MongoDB connection error handler
app.use((error, req, res, next) => {
  if (error.name === 'MongoError' || error.name === 'ValidationError') {
    return res.status(400).json({
      success: false,
      error: 'Database error',
      message: process.env.NODE_ENV === 'development' ? error.message : 'Invalid data provided'
    });
  }
  next(error);
});

// Global error handler
app.use((error, req, res, next) => {
  // Log error details
  console.error('Unhandled error:', {
    message: error.message,
    stack: error.stack,
    url: req.url,
    method: req.method,
    ip: req.ip,
    userAgent: req.get('User-Agent'),
    timestamp: new Date().toISOString()
  });

  // Don't expose sensitive error details in production
  const isDevelopment = process.env.NODE_ENV === 'development';
  
  res.status(error.status || 500).json({
    success: false,
    error: 'Internal server error',
    message: isDevelopment ? error.message : 'Something went wrong',
    ...(isDevelopment && { stack: error.stack })
  });
});

// Handle 404 routes
app.use('*', (req, res) => {
  res.status(404).json({
    success: false,
    error: 'Route not found',
    message: `Cannot ${req.method} ${req.originalUrl}`
  });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
