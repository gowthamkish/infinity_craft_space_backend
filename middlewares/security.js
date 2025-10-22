const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const slowDown = require('express-slow-down');
const mongoSanitize = require('express-mongo-sanitize');
const morgan = require('morgan');

// Security headers middleware
const securityHeaders = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "https:"],
      scriptSrc: ["'self'"],
      connectSrc: ["'self'"],
      frameSrc: ["'none'"],
      objectSrc: ["'none'"],
      mediaSrc: ["'self'"],
      workerSrc: ["'none'"]
    }
  },
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: "cross-origin" },
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true
  }
});

// Rate limiting configurations
const createRateLimit = (windowMs, max, message, skipSuccessfulRequests = false) => {
  return rateLimit({
    windowMs,
    max,
    message: {
      success: false,
      error: message,
      retryAfter: Math.ceil(windowMs / 1000)
    },
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests,
    handler: (req, res) => {
      res.status(429).json({
        success: false,
        error: message,
        retryAfter: Math.ceil(windowMs / 1000)
      });
    }
  });
};

// Different rate limits for different endpoints
const rateLimits = {
  // General API rate limit
  general: createRateLimit(
    15 * 60 * 1000, // 15 minutes
    100, // 100 requests per 15 minutes
    'Too many requests from this IP, please try again later.'
  ),

  // Authentication endpoints - stricter limits
  auth: createRateLimit(
    15 * 60 * 1000, // 15 minutes
    5, // 5 login attempts per 15 minutes
    'Too many authentication attempts, please try again later.',
    true // Skip successful requests
  ),

  // Registration - prevent spam accounts
  register: createRateLimit(
    60 * 60 * 1000, // 1 hour
    3, // 3 registrations per hour
    'Too many registration attempts, please try again later.'
  ),

  // Password reset - prevent abuse
  passwordReset: createRateLimit(
    60 * 60 * 1000, // 1 hour
    3, // 3 password reset attempts per hour
    'Too many password reset attempts, please try again later.'
  ),

  // File uploads - prevent abuse
  upload: createRateLimit(
    60 * 60 * 1000, // 1 hour
    10, // 10 uploads per hour
    'Too many file uploads, please try again later.'
  ),

  // Admin endpoints - very strict
  admin: createRateLimit(
    15 * 60 * 1000, // 15 minutes
    20, // 20 requests per 15 minutes
    'Too many admin requests, please try again later.'
  )
};

// Speed limiting (progressive delay)
const speedLimits = {
  // Slow down requests after hitting certain thresholds
  general: slowDown({
    windowMs: 15 * 60 * 1000, // 15 minutes
    delayAfter: 50, // Allow 50 requests per windowMs without delay
    delayMs: () => 500, // Fixed delay of 500ms per request after delayAfter
    maxDelayMs: 20000, // Maximum delay of 20 seconds
    skipFailedRequests: true,
    skipSuccessfulRequests: false,
    validate: { delayMs: false } // Disable warning
  }),

  auth: slowDown({
    windowMs: 15 * 60 * 1000, // 15 minutes
    delayAfter: 2, // Start slowing down after 2 attempts
    delayMs: () => 1000, // Fixed delay of 1 second per attempt
    maxDelayMs: 30000, // Maximum delay of 30 seconds
    skipFailedRequests: false,
    skipSuccessfulRequests: true,
    validate: { delayMs: false } // Disable warning
  })
};

// MongoDB injection prevention
const noSqlInjection = mongoSanitize({
  replaceWith: '_',
  onSanitize: ({ req, key }) => {
    console.warn(`NoSQL injection attempt detected: ${key} in ${req.path}`);
  }
});

// Request logging middleware
const requestLogger = morgan('combined', {
  skip: (req, res) => {
    // Skip logging for health checks and static files
    return req.url === '/health' || req.url.startsWith('/static/');
  },
  stream: {
    write: (message) => {
      // Log to console or your preferred logging service
      console.log(message.trim());
    }
  }
});

// Security logging middleware
const securityLogger = (req, res, next) => {
  const startTime = Date.now();
  
  // Log security-relevant information
  const logData = {
    timestamp: new Date().toISOString(),
    method: req.method,
    url: req.url,
    ip: req.ip || req.connection.remoteAddress,
    userAgent: req.get('User-Agent'),
    referer: req.get('Referer'),
    userId: req.user?.id || 'anonymous'
  };

  // Log suspicious patterns
  const suspiciousPatterns = [
    /script.*>/i,
    /javascript:/i,
    /vbscript:/i,
    /onload=/i,
    /onerror=/i,
    /\.\.\/\.\.\//,
    /union.*select/i,
    /drop.*table/i,
    /'.*or.*'.*=/i
  ];

  const requestString = JSON.stringify(req.body) + req.url + JSON.stringify(req.query);
  const isSuspicious = suspiciousPatterns.some(pattern => pattern.test(requestString));

  if (isSuspicious) {
    console.warn('Suspicious request detected:', {
      ...logData,
      body: req.body,
      query: req.query,
      params: req.params
    });
  }

  // Override res.json to log response data
  const originalJson = res.json;
  res.json = function(data) {
    const responseTime = Date.now() - startTime;
    
    // Log failed authentication attempts
    if (res.statusCode === 401 || res.statusCode === 403) {
      console.warn('Authentication/Authorization failure:', {
        ...logData,
        statusCode: res.statusCode,
        responseTime
      });
    }

    // Log server errors
    if (res.statusCode >= 500) {
      console.error('Server error:', {
        ...logData,
        statusCode: res.statusCode,
        responseTime,
        error: data.error || data.message
      });
    }

    return originalJson.call(this, data);
  };

  next();
};

// CORS configuration
const corsOptions = {
  origin: function (origin, callback) {
    const allowedOrigins = [
      'http://localhost:3000',
      'http://127.0.0.1:3000',
      'https://infinitycraftspace.com',
      'https://www.infinitycraftspace.com'
    ];
    
    // Allow requests with no origin (mobile apps, Postman, etc.)
    if (!origin) return callback(null, true);
    
    if (allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      console.warn('CORS violation from origin:', origin);
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Origin',
    'X-Requested-With',
    'Content-Type',
    'Accept',
    'Authorization',
    'X-CSRF-Token'
  ],
  exposedHeaders: ['X-Total-Count'],
  maxAge: 86400 // 24 hours
};

// Error handling for security middleware
const securityErrorHandler = (err, req, res, next) => {
  // CORS errors
  if (err.message === 'Not allowed by CORS') {
    return res.status(403).json({
      success: false,
      error: 'CORS policy violation',
      message: 'This origin is not allowed to access this resource'
    });
  }

  // Rate limit errors
  if (err.status === 429) {
    return res.status(429).json({
      success: false,
      error: 'Rate limit exceeded',
      message: 'Too many requests, please try again later',
      retryAfter: err.retryAfter
    });
  }

  // Validation errors from helmet
  if (err.code === 'EBADCSRFTOKEN') {
    return res.status(403).json({
      success: false,
      error: 'Invalid CSRF token',
      message: 'CSRF token validation failed'
    });
  }

  next(err);
};

// IP whitelist middleware (for admin operations)
const createIPWhitelist = (allowedIPs) => {
  return (req, res, next) => {
    const clientIP = req.ip || req.connection.remoteAddress;
    
    if (!allowedIPs.includes(clientIP)) {
      console.warn('IP not whitelisted for admin access:', clientIP);
      return res.status(403).json({
        success: false,
        error: 'Access denied',
        message: 'Your IP address is not authorized for this operation'
      });
    }
    
    next();
  };
};

module.exports = {
  securityHeaders,
  rateLimits,
  speedLimits,
  noSqlInjection,
  requestLogger,
  securityLogger,
  corsOptions,
  securityErrorHandler,
  createIPWhitelist
};