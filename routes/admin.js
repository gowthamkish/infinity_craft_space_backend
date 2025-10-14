const express = require("express");
// const { protect, isAdmin } = require("../middlewares/authMiddleware");
const router = express.Router();
const User = require("../models/User");
const Product = require("../models/Product");
const Order = require("../models/Order");

// Protect all admin routes
// router.use(protect, isAdmin);

router.get("/dashboard", async (req, res) => {
  try {
    const userCount = await User.countDocuments();
    const productCount = await Product.countDocuments();
    const orderCount = await Order.countDocuments();
    
    res.json({ 
      userCount, 
      productCount, 
      orderCount 
    });
  } catch (error) {
    console.error("Dashboard counts error:", error);
    res.status(500).json({ 
      success: false, 
      error: "Failed to fetch dashboard counts",
      userCount: 0,
      productCount: 0,
      orderCount: 0
    });
  }
});

// Example route
router.get("/users", async (req, res) => {
  const users = await User.find();
  res.json(users);
});


module.exports = router;
