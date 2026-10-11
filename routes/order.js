const express = require("express");
const router = express.Router();
const { protect, isAdmin } = require("../middlewares/authMiddleware");
const { orderValidation } = require("../middlewares/validators");
const {
  createOrder,
  getUserOrders,
  getOrderById,
  updateOrderStatus,
  downloadInvoice,
  getStatusUpdates,
  ackStatusUpdates,
} = require("../controllers/orderController");

router.post("/", orderValidation, createOrder);
router.get("/", getUserOrders);
router.get("/status-updates", getStatusUpdates); // before /:orderId
router.post("/status-updates/ack", ackStatusUpdates);
router.get("/:orderId/invoice", downloadInvoice);
router.get("/:orderId", getOrderById);
// updateOrderStatus should only be accessible to admins
router.put("/:orderId/status", protect, isAdmin, updateOrderStatus);

module.exports = router;
