const router = require("express").Router();
const {
  protect,
  refreshAccessToken,
} = require("../middlewares/authMiddleware");
const {
  registerValidation,
  loginValidation,
  addressValidation,
  mongoIdValidation,
} = require("../middlewares/validators");
const { loginLimiter, registerLimiter } = require("../middlewares/rateLimiter");
const {
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
} = require("../controllers/authController");

// Token refresh
router.post("/refresh-token", refreshAccessToken);

// Auth
router.post("/register", registerLimiter, registerValidation, register);
router.post("/login", loginLimiter, loginValidation, login);
router.post("/logout", logout);

// Profile
router.get("/profile", protect, getProfile);

// Addresses
router.get("/addresses", protect, getAddresses);
router.post("/addresses", protect, addressValidation, addAddress);
router.delete("/addresses/:addressId", protect, deleteAddress);
router.put("/addresses/:addressId", protect, updateAddress);
router.post("/addresses/:addressId/default", protect, setDefaultAddress);

// Wishlist
router.get("/wishlist", protect, getWishlist);
router.post("/wishlist", protect, addToWishlist);
router.delete("/wishlist/:productId", protect, removeFromWishlist);

// NOTE: Admin routes are now in /api/admin routes for better organization
// See /routes/admin.js for admin user management

module.exports = router;
