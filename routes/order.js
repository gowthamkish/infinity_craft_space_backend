const express = require("express");
const router = express.Router();
const { protect, isAdmin } = require("../middlewares/authMiddleware");
const {
  createOrder,
  getUserOrders,
  updateOrderStatus,
} = require("../controllers/orderController");

router.post("/", createOrder);
router.get("/", getUserOrders);
// updateOrderStatus should only be accessible to admins
router.put("/:orderId/status", protect, isAdmin, updateOrderStatus);
