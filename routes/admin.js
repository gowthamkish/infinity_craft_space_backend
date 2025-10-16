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

// Get all users
router.get("/users", async (req, res) => {
  try {
    const users = await User.find().select('-password');
    res.json(users);
  } catch (error) {
    console.error("Get users error:", error);
    res.status(500).json({ 
      success: false, 
      error: "Failed to fetch users" 
    });
  }
});

// Update user role (make admin/user)
router.put("/users/:id/role", async (req, res) => {
  try {
    const { id } = req.params;
    const { isAdmin } = req.body;

    // Validate input
    if (typeof isAdmin !== 'boolean') {
      return res.status(400).json({
        success: false,
        error: "isAdmin field must be a boolean"
      });
    }

    // Find and update user
    const user = await User.findById(id);
    if (!user) {
      return res.status(404).json({
        success: false,
        error: "User not found"
      });
    }

    // Update user role
    user.isAdmin = isAdmin;
    await user.save();

    // Return updated user (without password)
    const updatedUser = await User.findById(id).select('-password');

    res.json({
      success: true,
      message: `User ${isAdmin ? 'promoted to admin' : 'role changed to user'}`,
      user: updatedUser
    });

  } catch (error) {
    console.error("Update user role error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to update user role"
    });
  }
});

module.exports = router;
