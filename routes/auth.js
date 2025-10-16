const router = require("express").Router();
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const User = require("../models/User");
const { protect, isAdmin } = require("../middlewares/authMiddleware");

router.post("/register", async (req, res) => {
  const hashed = await bcrypt.hash(req.body.password, 10);
  const newUser = new User({ ...req.body, password: hashed });
  await newUser.save();
  res.status(201).json({ message: "User registered" });
});

router.post("/login", async (req, res) => {
  try {

    const user = await User.findOne({ email: req.body.email });
    
    if (!user) {
      return res.status(400).json({ error: "Invalid email" });
    }
    
    const match = await bcrypt.compare(req.body.password, user.password);
    
    if (!match) {
      return res.status(400).json({ error: "Invalid password" });
    }
    
    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET);
    
    res.json({
      token,
      user: { id: user._id, username: user.username, isAdmin: user.isAdmin },
    });
  } catch (error) {
    console.error('💥 Login error:', error);
    res.status(500).json({ error: "Internal server error" });
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
