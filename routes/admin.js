const express = require("express");
const router = express.Router();
const {
  getDashboard,
  getUsers,
  updateUserRole,
  getNotifications,
  getUnreadNotificationCount,
  markNotificationRead,
  getAllOrders,
  getAnalytics,
  getPredictions,
} = require("../controllers/adminController");

router.get("/dashboard", getDashboard);
router.get("/users", getUsers);
router.put("/users/:id/role", updateUserRole);
router.get("/notifications", getNotifications);
router.get("/notifications/unread-count", getUnreadNotificationCount);
router.put("/notifications/:id/read", markNotificationRead);
router.get("/orders", getAllOrders);
router.get("/analytics", getAnalytics);
router.get("/predictions", getPredictions);

module.exports = router;
