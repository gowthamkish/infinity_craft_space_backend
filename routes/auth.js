const router = require("express").Router();
const User = require("../models/User");
const { protect, isAdmin } = require("../middlewares/authMiddleware");
const { userValidation, handleValidationErrors } = require("../middlewares/validation");
const securityUtils = require("../utils/security");

router.post("/register", userValidation.register, handleValidationErrors, async (req, res) => {
  try {
    const { username, email, password } = req.body;

    // Check if user already exists
    const existingUser = await User.findOne({ 
      $or: [{ email }, { username }] 
    });

    if (existingUser) {
      const field = existingUser.email === email ? 'email' : 'username';
      return res.status(400).json({
        success: false,
        error: 'User already exists',
        message: `A user with this ${field} already exists`
      });
    }

    // Create new user (password hashing handled by User model middleware)
    const newUser = new User({ username, email, password });
    await newUser.save();

    // Generate email verification token (if email verification is implemented)
    const verificationToken = newUser.getEmailVerificationToken();
    await newUser.save();

    // Generate auth tokens
    const tokens = newUser.generateAuthTokens();

    // Log successful registration
    console.log('User registered successfully:', {
      userId: newUser._id,
      email: newUser.email,
      ip: req.ip,
      timestamp: new Date().toISOString()
    });

    res.status(201).json({
      success: true,
      message: "User registered successfully",
      user: {
        id: newUser._id,
        username: newUser.username,
        email: newUser.email,
        isAdmin: newUser.isAdmin,
        emailVerified: newUser.emailVerified
      },
      tokens,
      // Note: In production, send verification email instead of returning token
      verificationRequired: !newUser.emailVerified
    });

  } catch (error) {
    console.error('Registration error:', {
      error: error.message,
      email: req.body.email,
      ip: req.ip,
      timestamp: new Date().toISOString()
    });

    // Handle specific errors
    if (error.name === 'ValidationError') {
      const errors = Object.values(error.errors).map(err => err.message);
      return res.status(400).json({
        success: false,
        error: 'Validation failed',
        messages: errors
      });
    }

    res.status(500).json({
      success: false,
      error: 'Registration failed',
      message: 'An error occurred during registration'
    });
  }
});

router.post("/login", userValidation.login, handleValidationErrors, async (req, res) => {
  try {
    const { email, password } = req.body;

    // Use the enhanced findByCredentials method
    const user = await User.findByCredentials(email, password);
    
    // Generate new auth tokens
    const tokens = user.generateAuthTokens();
    
    // Update last login info
    user.lastLogin = new Date();
    user.lastLoginIP = req.ip;
    await user.save();

    // Log successful login
    console.log('User logged in successfully:', {
      userId: user._id,
      email: user.email,
      ip: req.ip,
      timestamp: new Date().toISOString()
    });

    res.json({
      success: true,
      message: "Login successful",
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
        isAdmin: user.isAdmin,
        role: user.role,
        lastLogin: user.lastLogin,
        emailVerified: user.emailVerified
      },
      tokens
    });

  } catch (error) {
    console.error('Login attempt failed:', {
      email: req.body.email,
      error: error.message,
      ip: req.ip,
      userAgent: req.get('User-Agent'),
      timestamp: new Date().toISOString()
    });

    // Generic error message to prevent username enumeration
    res.status(401).json({
      success: false,
      error: 'Authentication failed',
      message: error.message === 'Account temporarily locked due to too many failed login attempts' 
        ? error.message 
        : 'Invalid email or password'
    });
  }
});

// Get user profile
router.get("/profile", protect, async (req, res) => {
  res.json(req.user);
});

// Admin-only route
router.get("/admin/users", protect, isAdmin, async (req, res) => {
  const users = await User.find({});
  res.json(users);
});

module.exports = router;
