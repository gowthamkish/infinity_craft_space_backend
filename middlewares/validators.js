const { body, param, query, validationResult } = require("express-validator");

// Password validation regex
// At least 8 characters, 1 uppercase, 1 lowercase, 1 number, 1 special character
const passwordRegex =
  /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/;

// Validation middleware to check for errors
const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      errors: errors.array().map((err) => ({
        field: err.path,
        message: err.msg,
      })),
    });
  }
  next();
};

// User registration validation
const registerValidation = [
  body("username")
    .trim()
    .isLength({ min: 3, max: 30 })
    .withMessage("Username must be between 3 and 30 characters")
    .matches(/^[a-zA-Z0-9_]+$/)
    .withMessage("Username can only contain letters, numbers, and underscores")
    .escape(),

  body("email")
    .trim()
    .isEmail()
    .withMessage("Please provide a valid email address")
    .normalizeEmail()
    .isLength({ max: 100 })
    .withMessage("Email must not exceed 100 characters"),

  body("password")
    .isLength({ min: 8 })
    .withMessage("Password must be at least 8 characters long")
    .matches(passwordRegex)
    .withMessage(
      "Password must contain at least one uppercase letter, one lowercase letter, one number, and one special character (@$!%*?&)",
    ),

  body("phone")
    .optional()
    .trim()
    .matches(/^[0-9]{10}$/)
    .withMessage("Phone number must be 10 digits"),

  validate,
];

// User login validation
const loginValidation = [
  body("email")
    .trim()
    .isEmail()
    .withMessage("Please provide a valid email address")
    .normalizeEmail(),

  body("password").notEmpty().withMessage("Password is required"),

  validate,
];

// Product validation
const productValidation = [
  body("name")
    .trim()
    .isLength({ min: 2, max: 200 })
    .withMessage("Product name must be between 2 and 200 characters")
    .escape(),

  body("description")
    .optional()
    .trim()
    .isLength({ max: 5000 })
    .withMessage("Description must not exceed 5000 characters"),

  body("price")
    .isFloat({ min: 0.01, max: 1000000 })
    .withMessage("Price must be a positive number between 0.01 and 1,000,000"),

  body("category")
    .trim()
    .notEmpty()
    .withMessage("Category is required")
    .isLength({ max: 100 })
    .withMessage("Category must not exceed 100 characters"),

  body("subCategory")
    .trim()
    .notEmpty()
    .withMessage("Subcategory is required")
    .isLength({ max: 100 })
    .withMessage("Subcategory must not exceed 100 characters"),

  validate,
];

// Product update validation (all fields optional)
const productUpdateValidation = [
  body("name")
    .optional()
    .trim()
    .isLength({ min: 2, max: 200 })
    .withMessage("Product name must be between 2 and 200 characters")
    .escape(),

  body("description")
    .optional()
    .trim()
    .isLength({ max: 5000 })
    .withMessage("Description must not exceed 5000 characters"),

  body("price")
    .optional()
    .isFloat({ min: 0.01, max: 1000000 })
    .withMessage("Price must be a positive number between 0.01 and 1,000,000"),

  body("category")
    .optional()
    .trim()
    .isLength({ max: 100 })
    .withMessage("Category must not exceed 100 characters"),

  body("subCategory")
    .optional()
    .trim()
    .isLength({ max: 100 })
    .withMessage("Subcategory must not exceed 100 characters"),

  validate,
];

// Address validation
const addressValidation = [
  body("street")
    .trim()
    .notEmpty()
    .withMessage("Street address is required")
    .isLength({ max: 500 })
    .withMessage("Street address must not exceed 500 characters"),

  body("city")
    .trim()
    .notEmpty()
    .withMessage("City is required")
    .isLength({ max: 100 })
    .withMessage("City must not exceed 100 characters"),

  body("state")
    .trim()
    .notEmpty()
    .withMessage("State is required")
    .isLength({ max: 100 })
    .withMessage("State must not exceed 100 characters"),

  body("zipCode")
    .trim()
    .notEmpty()
    .withMessage("ZIP code is required")
    .matches(/^[0-9]{5,10}$/)
    .withMessage("ZIP code must be 5-10 digits"),

  body("country")
    .trim()
    .notEmpty()
    .withMessage("Country is required")
    .isLength({ max: 100 })
    .withMessage("Country must not exceed 100 characters"),

  body("phone")
    .optional()
    .trim()
    .matches(/^[0-9]{10}$/)
    .withMessage("Phone number must be 10 digits"),

  body("label")
    .optional()
    .trim()
    .isLength({ max: 50 })
    .withMessage("Label must not exceed 50 characters"),

  body("isDefault")
    .optional()
    .isBoolean()
    .withMessage("isDefault must be a boolean"),

  validate,
];

// Review validation
const reviewValidation = [
  body("rating")
    .isInt({ min: 1, max: 5 })
    .withMessage("Rating must be between 1 and 5"),

  body("title")
    .optional()
    .trim()
    .isLength({ max: 200 })
    .withMessage("Review title must not exceed 200 characters"),

  body("comment")
    .optional()
    .trim()
    .isLength({ max: 2000 })
    .withMessage("Review comment must not exceed 2000 characters"),

  validate,
];

// MongoDB ObjectId validation
const mongoIdValidation = (paramName = "id") => [
  param(paramName).isMongoId().withMessage(`Invalid ${paramName} format`),

  validate,
];

// Pagination validation
const paginationValidation = [
  query("page")
    .optional()
    .isInt({ min: 1 })
    .withMessage("Page must be a positive integer"),

  query("limit")
    .optional()
    .isInt({ min: 1, max: 100 })
    .withMessage("Limit must be between 1 and 100"),

  validate,
];

// Order validation
const orderValidation = [
  body("items")
    .isArray({ min: 1 })
    .withMessage("Order must contain at least one item"),

  body("items.*.product").isMongoId().withMessage("Invalid product ID"),

  body("items.*.quantity")
    .isInt({ min: 1, max: 100 })
    .withMessage("Quantity must be between 1 and 100"),

  body("shippingAddress")
    .notEmpty()
    .withMessage("Shipping address is required"),

  validate,
];

// Password change validation
const passwordChangeValidation = [
  body("currentPassword")
    .notEmpty()
    .withMessage("Current password is required"),

  body("newPassword")
    .isLength({ min: 8 })
    .withMessage("New password must be at least 8 characters long")
    .matches(passwordRegex)
    .withMessage(
      "New password must contain at least one uppercase letter, one lowercase letter, one number, and one special character (@$!%*?&)",
    ),

  body("confirmPassword").custom((value, { req }) => {
    if (value !== req.body.newPassword) {
      throw new Error("Password confirmation does not match");
    }
    return true;
  }),

  validate,
];

// Sanitize input - remove potentially dangerous characters
const sanitizeInput = (req, res, next) => {
  // Recursively sanitize object
  const sanitize = (obj) => {
    if (typeof obj === "string") {
      // Remove null bytes and trim
      return obj.replace(/\0/g, "").trim();
    }
    if (Array.isArray(obj)) {
      return obj.map(sanitize);
    }
    if (obj && typeof obj === "object") {
      const sanitized = {};
      for (const key of Object.keys(obj)) {
        // Skip potentially dangerous keys
        if (key.startsWith("$") || key.includes(".")) {
          continue;
        }
        sanitized[key] = sanitize(obj[key]);
      }
      return sanitized;
    }
    return obj;
  };

  if (req.body) {
    req.body = sanitize(req.body);
  }
  if (req.query) {
    req.query = sanitize(req.query);
  }
  if (req.params) {
    req.params = sanitize(req.params);
  }

  next();
};

module.exports = {
  validate,
  registerValidation,
  loginValidation,
  productValidation,
  productUpdateValidation,
  addressValidation,
  reviewValidation,
  mongoIdValidation,
  paginationValidation,
  orderValidation,
  passwordChangeValidation,
  sanitizeInput,
  passwordRegex,
};
