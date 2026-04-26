const express = require("express");
const router = express.Router();
const { protect, isAdmin } = require("../middlewares/authMiddleware");
const {
  getDashboard,
  getUsers,
  updateUserRole,
  updateUser,
  getNotifications,
  getUnreadNotificationCount,
  markNotificationRead,
  getAllOrders,
  getAnalytics,
  getPredictions,
} = require("../controllers/adminController");

// All admin routes explicitly protected with both protect and isAdmin middleware
// to ensure they work correctly even on mobile browsers
router.get("/dashboard", protect, isAdmin, getDashboard);
router.get("/users", protect, isAdmin, getUsers);
router.put("/users/:id/role", protect, isAdmin, updateUserRole);
router.patch("/users/:id", protect, isAdmin, updateUser);
router.get("/notifications", protect, isAdmin, getNotifications);
router.get(
  "/notifications/unread-count",
  protect,
  isAdmin,
  getUnreadNotificationCount,
);
router.put("/notifications/:id/read", protect, isAdmin, markNotificationRead);
router.get("/orders", protect, isAdmin, getAllOrders);
router.get("/analytics", protect, isAdmin, getAnalytics);
router.get("/predictions", protect, isAdmin, getPredictions);

module.exports = router;
