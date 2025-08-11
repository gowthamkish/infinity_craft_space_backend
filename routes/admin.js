const express = require("express");
// const { protect, isAdmin } = require("../middlewares/authMiddleware");
const router = express.Router();
const User = require("../models/User");
const Product = require("../models/Product");

// Protect all admin routes
// router.use(protect, isAdmin);

router.get("/dashboard", async (req, res) => {
  const userCount = await User.countDocuments();

  res.json({ userCount });
});

// Example route
router.get("/users", async (req, res) => {
  const users = await User.find();
  console.log("USERS", users);
  res.json(users);
});


module.exports = router;
