/**
 * Shipping Routes — /api/shipping
 *
 * NOTE: Shiprocket integration is disabled. Will be re-enabled in a future release.
 * Cancel order is handled internally (no Shiprocket API calls).
 * Rate/track/return endpoints return 503 until integration is live.
 */

const express = require("express");
const router = express.Router();
const { cancelOrder } = require("../controllers/orderController");
const mongoose = require("mongoose");
const Order = require("../models/Order");
const Product = require("../models/Product");
const Notification = require("../models/Notification");
const { protect } = require("../middlewares/authMiddleware");

const validateObjectId = (res, id) => {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    res.status(400).json({ success: false, error: "Invalid order ID" });
    return false;
  }
  return true;
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/shipping/rates — disabled until Shiprocket is integrated
// ─────────────────────────────────────────────────────────────────────────────
router.get("/rates", protect, (_req, res) => {
  res.status(503).json({ success: false, error: "Shipping rate lookup coming soon" });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/shipping/pickup-locations — disabled until Shiprocket is integrated
// ─────────────────────────────────────────────────────────────────────────────
router.get("/pickup-locations", protect, (_req, res) => {
  if (!_req.user?.isAdmin) return res.status(403).json({ success: false, error: "Admin only" });
  res.status(503).json({ success: false, error: "Pickup locations coming soon" });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/shipping/track/:orderId — returns order timeline (no live Shiprocket call)
// ─────────────────────────────────────────────────────────────────────────────
router.get("/track/:orderId", protect, async (req, res) => {
  try {
    if (!validateObjectId(res, req.params.orderId)) return;
    const order = await Order.findById(req.params.orderId).lean();
    if (!order) return res.status(404).json({ success: false, error: "Order not found" });
    if (order.userId.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, error: "Access denied" });
    }
    res.json({
      success: true,
      tracking: null,
      order: {
        _id: order._id,
        status: order.status,
        timeline: order.timeline,
        createdAt: order.createdAt,
        totalAmount: order.totalAmount,
        subtotal: order.subtotal,
        shipping: order.shipping,
        shippingAddress: order.shippingAddress,
        items: order.items,
        estimatedDelivery: order.estimatedDelivery,
      },
      message: "Live tracking not yet available",
    });
  } catch (err) {
    console.error("[Shipping] Track error:", err.message);
    res.status(500).json({ success: false, error: "Failed to fetch order details" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/shipping/cancel/:orderId — customer cancels their own order; paid orders are refunded via Razorpay
// ─────────────────────────────────────────────────────────────────────────────
router.post("/cancel/:orderId", protect, cancelOrder);

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/shipping/return/:orderId — disabled until Shiprocket is integrated
// ─────────────────────────────────────────────────────────────────────────────
router.post("/return/:orderId", protect, (_req, res) => {
  res.status(503).json({ success: false, error: "Return pickup coming soon" });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/shipping/webhook — disabled until Shiprocket is integrated
// ─────────────────────────────────────────────────────────────────────────────
router.post("/webhook", (_req, res) => {
  res.json({ success: true, message: "Webhook integration pending" });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/shipping/retry/:orderId — disabled until Shiprocket is integrated
// ─────────────────────────────────────────────────────────────────────────────
router.post("/retry/:orderId", protect, (_req, res) => {
  if (!_req.user?.isAdmin) return res.status(403).json({ success: false, error: "Admin only" });
  res.status(503).json({ success: false, error: "Shiprocket integration coming soon" });
});

module.exports = router;
