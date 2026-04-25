const express = require("express");
const router = express.Router();
const { protect, isAdmin } = require("../middlewares/authMiddleware");
const {
  createOrder,
  getUserOrders,
  getOrderById,
  updateOrderStatus,
} = require("../controllers/orderController");

router.post("/", createOrder);
router.get("/", getUserOrders);
router.get("/:orderId", getOrderById);
// updateOrderStatus should only be accessible to admins
router.put("/:orderId/status", protect, isAdmin, updateOrderStatus);

module.exports = router;
