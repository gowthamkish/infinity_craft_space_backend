const { body, param, query, validationResult } = require('express-validator');
const mongoSanitize = require('express-mongo-sanitize');
const securityUtils = require('../utils/security');

// Input sanitization middleware
const sanitizeInput = (req, res, next) => {
  // Sanitize body
  if (req.body) {
    req.body = sanitizeObject(req.body);
  }

  // Sanitize query parameters
  if (req.query) {
    req.query = sanitizeObject(req.query);
  }

  // Sanitize URL parameters
  if (req.params) {
    req.params = sanitizeObject(req.params);
  }

  next();
};

// Recursive sanitization helper
const sanitizeObject = (obj) => {
  if (typeof obj === 'string') {
    return securityUtils.sanitizeInput(obj);
  } else if (Array.isArray(obj)) {
    return obj.map(item => sanitizeObject(item));
  } else if (typeof obj === 'object' && obj !== null) {
    const sanitized = {};
    for (const [key, value] of Object.entries(obj)) {
      sanitized[key] = sanitizeObject(value);
    }
    return sanitized;
  }
  return obj;
};

// Validation error handler
const handleValidationErrors = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    const errorMessages = errors.array().map(error => ({
      field: error.path,
      message: error.msg,
      value: error.value
    }));
    
    return res.status(400).json({
      success: false,
      error: 'Validation failed',
      details: errorMessages
    });
  }
  next();
};

// User validation rules
const userValidation = {
  register: [
    body('username')
      .isLength({ min: 3, max: 30 })
      .withMessage('Username must be between 3 and 30 characters')
      .matches(/^[a-zA-Z0-9_-]+$/)
      .withMessage('Username can only contain letters, numbers, underscores, and hyphens')
      .trim()
      .escape(),
    
    body('email')
      .isEmail()
      .withMessage('Please provide a valid email address')
      .normalizeEmail()
      .isLength({ max: 100 })
      .withMessage('Email must be less than 100 characters'),
    
    body('password')
      .isLength({ min: 8, max: 128 })
      .withMessage('Password must be between 8 and 128 characters')
      .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]/)
      .withMessage('Password must contain at least one uppercase letter, one lowercase letter, one number, and one special character')
  ],

  login: [
    body('email')
      .isEmail()
      .withMessage('Please provide a valid email address')
      .normalizeEmail(),
    
    body('password')
      .notEmpty()
      .withMessage('Password is required')
      .isLength({ max: 128 })
      .withMessage('Password must be less than 128 characters')
  ]
};

// Product validation rules
const productValidation = {
  create: [
    body('name')
      .isLength({ min: 1, max: 200 })
      .withMessage('Product name must be between 1 and 200 characters')
      .trim()
      .escape(),
    
    body('description')
      .isLength({ min: 10, max: 2000 })
      .withMessage('Description must be between 10 and 2000 characters')
      .trim(),
    
    body('price')
      .isFloat({ min: 0.01, max: 999999 })
      .withMessage('Price must be a positive number between 0.01 and 999999'),
    
    body('category')
      .notEmpty()
      .withMessage('Category is required')
      .isLength({ max: 100 })
      .withMessage('Category must be less than 100 characters')
      .trim()
      .escape(),
    
    body('stock')
      .optional()
      .isInt({ min: 0 })
      .withMessage('Stock must be a non-negative integer')
  ],

  update: [
    param('id')
      .isMongoId()
      .withMessage('Invalid product ID format'),
    
    body('name')
      .optional()
      .isLength({ min: 1, max: 200 })
      .withMessage('Product name must be between 1 and 200 characters')
      .trim()
      .escape(),
    
    body('description')
      .optional()
      .isLength({ min: 10, max: 2000 })
      .withMessage('Description must be between 10 and 2000 characters')
      .trim(),
    
    body('price')
      .optional()
      .isFloat({ min: 0.01, max: 999999 })
      .withMessage('Price must be a positive number between 0.01 and 999999'),
    
    body('category')
      .optional()
      .isLength({ max: 100 })
      .withMessage('Category must be less than 100 characters')
      .trim()
      .escape(),
    
    body('stock')
      .optional()
      .isInt({ min: 0 })
      .withMessage('Stock must be a non-negative integer')
  ]
};

// Order validation rules
const orderValidation = {
  create: [
    body('items')
      .isArray({ min: 1 })
      .withMessage('Order must contain at least one item'),
    
    body('items.*.product')
      .isMongoId()
      .withMessage('Invalid product ID in order items'),
    
    body('items.*.quantity')
      .isInt({ min: 1, max: 100 })
      .withMessage('Quantity must be between 1 and 100'),
    
    body('shippingAddress.street')
      .isLength({ min: 5, max: 200 })
      .withMessage('Street address must be between 5 and 200 characters')
      .trim(),
    
    body('shippingAddress.city')
      .isLength({ min: 2, max: 100 })
      .withMessage('City must be between 2 and 100 characters')
      .trim()
      .escape(),
    
    body('shippingAddress.state')
      .isLength({ min: 2, max: 100 })
      .withMessage('State must be between 2 and 100 characters')
      .trim()
      .escape(),
    
    body('shippingAddress.zipCode')
      .matches(/^[0-9]{5,10}$/)
      .withMessage('ZIP code must be 5-10 digits'),
    
    body('shippingAddress.country')
      .isLength({ min: 2, max: 100 })
      .withMessage('Country must be between 2 and 100 characters')
      .trim()
      .escape()
  ]
};

// Review validation rules
const reviewValidation = {
  create: [
    body('product')
      .isMongoId()
      .withMessage('Invalid product ID'),
    
    body('rating')
      .isInt({ min: 1, max: 5 })
      .withMessage('Rating must be between 1 and 5'),
    
    body('title')
      .optional()
      .isLength({ max: 100 })
      .withMessage('Review title must be less than 100 characters')
      .trim()
      .escape(),
    
    body('comment')
      .isLength({ min: 10, max: 1000 })
      .withMessage('Review comment must be between 10 and 1000 characters')
      .trim()
  ]
};

// General MongoDB ID validation
const validateMongoId = (field = 'id') => [
  param(field)
    .isMongoId()
    .withMessage(`Invalid ${field} format`)
];

// Pagination validation
const paginationValidation = [
  query('page')
    .optional()
    .isInt({ min: 1 })
    .withMessage('Page must be a positive integer'),
  
  query('limit')
    .optional()
    .isInt({ min: 1, max: 100 })
    .withMessage('Limit must be between 1 and 100'),
  
  query('sort')
    .optional()
    .isIn(['name', 'price', 'createdAt', 'rating', '-name', '-price', '-createdAt', '-rating'])
    .withMessage('Invalid sort parameter')
];

// Search validation
const searchValidation = [
  query('search')
    .optional()
    .isLength({ min: 1, max: 100 })
    .withMessage('Search term must be between 1 and 100 characters')
    .trim()
    .escape(),
  
  query('category')
    .optional()
    .isLength({ max: 100 })
    .withMessage('Category must be less than 100 characters')
    .trim()
    .escape(),
  
  query('minPrice')
    .optional()
    .isFloat({ min: 0 })
    .withMessage('Minimum price must be a non-negative number'),
  
  query('maxPrice')
    .optional()
    .isFloat({ min: 0 })
    .withMessage('Maximum price must be a non-negative number')
];

module.exports = {
  sanitizeInput,
  handleValidationErrors,
  userValidation,
  productValidation,
  orderValidation,
  reviewValidation,
  validateMongoId,
  paginationValidation,
  searchValidation
};