const router = require("express").Router();
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const passport = require("passport");
const User = require("../models/User");
const { protect, isAdmin } = require("../middlewares/authMiddleware");

// Traditional login/register
router.post("/register", async (req, res) => {
  try {
    const hashed = await bcrypt.hash(req.body.password, 10);
    const newUser = new User({ 
      ...req.body, 
      password: hashed,
      provider: 'local'
    });
    await newUser.save();
    res.status(201).json({ message: "User registered" });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: "Registration failed" });
  }
});

router.post("/login", async (req, res) => {
  try {
    const user = await User.findOne({ email: req.body.email });
    
    if (!user) {
      return res.status(400).json({ error: "Invalid email" });
    }
    
    // Check if user is SSO user trying to login with password
    if (user.provider !== 'local' && !user.password) {
      return res.status(400).json({ 
        error: `Please login using ${user.provider.charAt(0).toUpperCase() + user.provider.slice(1)}` 
      });
    }
    
    const match = await bcrypt.compare(req.body.password, user.password);
    
    if (!match) {
      return res.status(400).json({ error: "Invalid password" });
    }
    
    // Update last login
    user.lastLogin = new Date();
    await user.save();
    
    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET);
    
    res.json({
      token,
      user: { 
        id: user._id, 
        username: user.username, 
        email: user.email,
        isAdmin: user.isAdmin,
        avatar: user.avatar,
        provider: user.provider
      },
    });
  } catch (error) {
    console.error('💥 Login error:', error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Google OAuth routes
router.get('/google',
  passport.authenticate('google', { scope: ['profile', 'email'] })
);

router.get('/google/callback',
  passport.authenticate('google', { failureRedirect: '/login' }),
  (req, res) => {
    try {
      // Generate JWT token
      const token = jwt.sign(
        { id: req.user._id },
        process.env.JWT_SECRET,
        { expiresIn: '24h' }
      );
      
      // Redirect to frontend with token
      const frontendURL = process.env.FRONTEND_APP_URL || 'http://localhost:3000';
      res.redirect(`${frontendURL}/auth/success?token=${token}`);
    } catch (error) {
      console.error('OAuth callback error:', error);
      res.redirect(`${process.env.FRONTEND_APP_URL || 'http://localhost:3000'}/login?error=oauth_failed`);
    }
  }
);

// SSO logout
router.post('/logout', (req, res) => {
  req.logout((err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ message: 'Logged out successfully' });
  });
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
