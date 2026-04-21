const bcrypt = require("bcryptjs");
const User = require("../models/User");
const { generateTokens, setAuthCookies, clearAuthCookies } = require("../middlewares/authMiddleware");

const register = async (req, res) => {
  try {
    const existingUser = await User.findOne({
      $or: [{ email: req.body.email }, { username: req.body.username }],
    });

    if (existingUser) {
      if (existingUser.email === req.body.email) {
        return res.status(400).json({ error: "Email already registered" });
      }
      return res.status(400).json({ error: "Username already taken" });
    }

    const hashed = await bcrypt.hash(req.body.password, 12);
    const newUser = new User({ ...req.body, password: hashed });
    await newUser.save();

    const tokens = generateTokens(newUser._id);
    setAuthCookies(res, tokens);

    res.status(201).json({
      message: "User registered successfully",
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
};

const MAX_LOGIN_ATTEMPTS = 5;
const LOCK_TIME_MS = 15 * 60 * 1000; // 15 minutes

const login = async (req, res) => {
  try {
    const user = await User.findOne({ email: req.body.email });

    if (!user) {
      return res.status(400).json({ error: "Invalid email or password" });
    }

    // Check account lock
    if (user.lockUntil && user.lockUntil > Date.now()) {
      const remainingMs = user.lockUntil - Date.now();
      const remainingMins = Math.ceil(remainingMs / 60000);
      return res.status(423).json({
        error: `Account temporarily locked. Try again in ${remainingMins} minute${remainingMins !== 1 ? "s" : ""}.`,
      });
    }

    const match = await bcrypt.compare(req.body.password, user.password);
    if (!match) {
      // Increment failed attempts
      user.loginAttempts = (user.loginAttempts || 0) + 1;
      if (user.loginAttempts >= MAX_LOGIN_ATTEMPTS) {
        user.lockUntil = new Date(Date.now() + LOCK_TIME_MS);
        await user.save();
        return res.status(423).json({
          error: "Too many failed attempts. Account locked for 15 minutes.",
        });
      }
      await user.save();
      const remaining = MAX_LOGIN_ATTEMPTS - user.loginAttempts;
      return res.status(400).json({
        error: `Invalid email or password. ${remaining} attempt${remaining !== 1 ? "s" : ""} remaining.`,
      });
    }

    // Successful login — reset lockout
    if (user.loginAttempts > 0 || user.lockUntil) {
      user.loginAttempts = 0;
      user.lockUntil = null;
      await user.save();
    }

    const tokens = generateTokens(user._id);
    setAuthCookies(res, tokens);

    res.json({
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
        isAdmin: user.isAdmin,
      },
    });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

const logout = (req, res) => {
  clearAuthCookies(res);
  res.json({ message: "Logged out successfully" });
};

const getProfile = (req, res) => {
  res.json(req.user);
};

const getAddresses = async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select("addresses");
    res.json({ addresses: user.addresses || [] });
  } catch (err) {
    console.error("Error fetching addresses", err);
    res.status(500).json({ error: "Failed to fetch addresses" });
  }
};

const addAddress = async (req, res) => {
  try {
    const { label, street, city, state, zipCode, country, phone, isDefault } =
      req.body;

    const user = await User.findById(req.user._id);
    if (isDefault) {
      user.addresses.forEach((a) => { a.isDefault = false; });
    }
    user.addresses.unshift({ label, street, city, state, zipCode, country, phone, isDefault: !!isDefault });
    if (user.addresses.length > 20) user.addresses = user.addresses.slice(0, 20);
    await user.save();
    res.status(201).json({ addresses: user.addresses });
  } catch (err) {
    console.error("Error saving address", err);
    res.status(500).json({ error: "Failed to save address" });
  }
};

const deleteAddress = async (req, res) => {
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
};

const updateAddress = async (req, res) => {
  try {
    const { addressId } = req.params;
    const { label, street, city, state, zipCode, country, phone, isDefault } =
      req.body;
    const user = await User.findById(req.user._id);
    const addr = user.addresses.id(addressId);
    if (!addr) return res.status(404).json({ error: "Address not found" });

    addr.label = label ?? addr.label;
    addr.street = street ?? addr.street;
    addr.city = city ?? addr.city;
    addr.state = state ?? addr.state;
    addr.zipCode = zipCode ?? addr.zipCode;
    addr.country = country ?? addr.country;
    addr.phone = phone ?? addr.phone;
    if (typeof isDefault !== "undefined" && isDefault) {
      user.addresses.forEach((a) => { a.isDefault = false; });
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
};

const setDefaultAddress = async (req, res) => {
  try {
    const { addressId } = req.params;
    const user = await User.findById(req.user._id);
    const addr = user.addresses.id(addressId);
    if (!addr) return res.status(404).json({ error: "Address not found" });
    user.addresses.forEach((a) => { a.isDefault = false; });
    addr.isDefault = true;
    await user.save();
    res.json({ addresses: user.addresses });
  } catch (err) {
    console.error("Error setting default address", err);
    res.status(500).json({ error: "Failed to set default address" });
  }
};

const getWishlist = async (req, res) => {
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
};

const addToWishlist = async (req, res) => {
  try {
    const { productId } = req.body;
    if (!productId) return res.status(400).json({ error: "productId required" });

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
};

const removeFromWishlist = async (req, res) => {
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
};

module.exports = {
  register,
  login,
  logout,
  getProfile,
  getAddresses,
  addAddress,
  deleteAddress,
  updateAddress,
  setDefaultAddress,
  getWishlist,
  addToWishlist,
  removeFromWishlist,
};
