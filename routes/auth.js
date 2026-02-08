const router = require("express").Router();
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const User = require("../models/User");
const {
  protect,
  isAdmin,
  generateTokens,
  refreshAccessToken,
} = require("../middlewares/authMiddleware");
const {
  registerValidation,
  loginValidation,
  addressValidation,
  passwordChangeValidation,
  mongoIdValidation,
} = require("../middlewares/validators");
const { loginLimiter, registerLimiter } = require("../middlewares/rateLimiter");

// Token refresh endpoint
router.post("/refresh-token", refreshAccessToken);

router.post(
  "/register",
  registerLimiter,
  registerValidation,
  async (req, res) => {
    try {
      // Check if user already exists
      const existingUser = await User.findOne({
        $or: [{ email: req.body.email }, { username: req.body.username }],
      });

      if (existingUser) {
        if (existingUser.email === req.body.email) {
          return res.status(400).json({ error: "Email already registered" });
        }
        return res.status(400).json({ error: "Username already taken" });
      }

      const hashed = await bcrypt.hash(req.body.password, 12); // Increased from 10 to 12 rounds
      const newUser = new User({ ...req.body, password: hashed });
      await newUser.save();

      // Generate tokens for immediate login after registration
      const tokens = generateTokens(newUser._id);

      res.status(201).json({
        message: "User registered successfully",
        token: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        user: {
          id: newUser._id,
          username: newUser.username,
          email: newUser.email,
          isAdmin: newUser.isAdmin,
        },
      });
    } catch (error) {
      console.error("Registration error:", error);
      res.status(500).json({ error: "Registration failed" });
    }
  },
);

router.post("/login", loginLimiter, loginValidation, async (req, res) => {
  try {
    const user = await User.findOne({ email: req.body.email });

    if (!user) {
      return res.status(400).json({ error: "Invalid email or password" }); // Don't reveal which field is wrong
    }

    const match = await bcrypt.compare(req.body.password, user.password);

    if (!match) {
      return res.status(400).json({ error: "Invalid email or password" }); // Don't reveal which field is wrong
    }

    // Generate tokens with expiry
    const tokens = generateTokens(user._id);

    res.json({
      token: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
        isAdmin: user.isAdmin,
      },
    });
  } catch (error) {
    console.error("💥 Login error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Get user profile
router.get("/profile", protect, async (req, res) => {
  res.json(req.user);
});

// Addresses: GET, POST, DELETE for authenticated users
router.get("/addresses", protect, async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select("addresses");
    res.json({ addresses: user.addresses || [] });
  } catch (err) {
    console.error("Error fetching addresses", err);
    res.status(500).json({ error: "Failed to fetch addresses" });
  }
});

router.post("/addresses", protect, addressValidation, async (req, res) => {
  try {
    const { label, street, city, state, zipCode, country, phone, isDefault } =
      req.body;

    const user = await User.findById(req.user._id);
    // if this address should be default, clear other defaults
    if (isDefault) {
      user.addresses.forEach((a) => {
        a.isDefault = false;
      });
    }
    user.addresses.unshift({
      label,
      street,
      city,
      state,
      zipCode,
      country,
      phone,
      isDefault: !!isDefault,
    });
    // cap at 20 addresses to avoid unbounded growth
    if (user.addresses.length > 20)
      user.addresses = user.addresses.slice(0, 20);
    await user.save();
    res.status(201).json({ addresses: user.addresses });
  } catch (err) {
    console.error("Error saving address", err);
    res.status(500).json({ error: "Failed to save address" });
  }
});

router.delete("/addresses/:addressId", protect, async (req, res) => {
  try {
    const { addressId } = req.params;
    const user = await User.findById(req.user._id);
    user.addresses = user.addresses.filter(
      (a) => String(a._id) !== String(addressId),
    );
    await user.save();
    res.json({ addresses: user.addresses });
  } catch (err) {
    console.error("Error deleting address", err);
    res.status(500).json({ error: "Failed to delete address" });
  }
});

// Update address
router.put("/addresses/:addressId", protect, async (req, res) => {
  try {
    const { addressId } = req.params;
    const { label, street, city, state, zipCode, country, phone, isDefault } =
      req.body;
    const user = await User.findById(req.user._id);
    const addr = user.addresses.id(addressId);
    if (!addr) return res.status(404).json({ error: "Address not found" });

    // Update fields
    addr.label = label ?? addr.label;
    addr.street = street ?? addr.street;
    addr.city = city ?? addr.city;
    addr.state = state ?? addr.state;
    addr.zipCode = zipCode ?? addr.zipCode;
    addr.country = country ?? addr.country;
    addr.phone = phone ?? addr.phone;
    if (typeof isDefault !== "undefined" && isDefault) {
      user.addresses.forEach((a) => {
        a.isDefault = false;
      });
      addr.isDefault = true;
    } else if (typeof isDefault !== "undefined") {
      addr.isDefault = !!isDefault;
    }

    await user.save();
    res.json({ addresses: user.addresses });
  } catch (err) {
    console.error("Error updating address", err);
    res.status(500).json({ error: "Failed to update address" });
  }
});

// Set default address
router.post("/addresses/:addressId/default", protect, async (req, res) => {
  try {
    const { addressId } = req.params;
    const user = await User.findById(req.user._id);
    const addr = user.addresses.id(addressId);
    if (!addr) return res.status(404).json({ error: "Address not found" });
    user.addresses.forEach((a) => {
      a.isDefault = false;
    });
    addr.isDefault = true;
    await user.save();
    res.json({ addresses: user.addresses });
  } catch (err) {
    console.error("Error setting default address", err);
    res.status(500).json({ error: "Failed to set default address" });
  }
});

// Wishlist endpoints
router.get("/wishlist", protect, async (req, res) => {
  try {
    const user = await User.findById(req.user._id).populate({
      path: "wishlist",
      model: "Product",
    });
    res.json({ wishlist: user.wishlist || [] });
  } catch (err) {
    console.error("Error fetching wishlist", err);
    res.status(500).json({ error: "Failed to fetch wishlist" });
  }
});

router.post("/wishlist", protect, async (req, res) => {
  try {
    const { productId } = req.body;
    if (!productId)
      return res.status(400).json({ error: "productId required" });
    const user = await User.findById(req.user._id);
    if (!user.wishlist.some((id) => String(id) === String(productId))) {
      user.wishlist.push(productId);
      await user.save();
    }
    const populated = await User.findById(req.user._id).populate({
      path: "wishlist",
      model: "Product",
    });
    res.status(201).json({ wishlist: populated.wishlist });
  } catch (err) {
    console.error("Error adding to wishlist", err);
    res.status(500).json({ error: "Failed to add to wishlist" });
  }
});

router.delete("/wishlist/:productId", protect, async (req, res) => {
  try {
    const { productId } = req.params;
    const user = await User.findById(req.user._id);
    user.wishlist = user.wishlist.filter(
      (id) => String(id) !== String(productId),
    );
    await user.save();
    const populated = await User.findById(req.user._id).populate({
      path: "wishlist",
      model: "Product",
    });
    res.json({ wishlist: populated.wishlist });
  } catch (err) {
    console.error("Error removing from wishlist", err);
    res.status(500).json({ error: "Failed to remove from wishlist" });
  }
});

// Admin-only route
router.get("/admin/users", protect, isAdmin, async (req, res) => {
  const users = await User.find({});
  res.json(users);
});

module.exports = router;
