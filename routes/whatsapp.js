/**
 * WhatsApp Admin API — /api/whatsapp
 *
 * Routes:
 *   GET  /api/whatsapp/logs          — view notification logs (admin only)
 *   POST /api/whatsapp/test          — send a test message to any number (admin only)
 *   POST /api/whatsapp/resend/:logId — retry a failed notification (admin only)
 *   POST /api/whatsapp/retry-failed  — bulk retry all due failed notifications (admin only)
 */

const express = require("express");
const router = express.Router();
const { protect, isAdmin } = require("../middlewares/authMiddleware");
const adminOnly = isAdmin;
const WhatsAppLog = require("../models/WhatsAppLog");
const Order = require("../models/Order");
const User = require("../models/User");
const {
  sendWhatsApp,
  notifyCustomerStatusChange,
  notifyAdminNewOrder,
  retryFailedNotifications,
  isConfigured,
  TEMPLATES,
} = require("../services/whatsappService");

// GET /api/whatsapp/logs
router.get("/logs", protect, adminOnly, async (req, res) => {
  try {
    const { page = 1, limit = 20, status, eventType } = req.query;
    const filter = {};
    if (status) filter.status = status;
    if (eventType) filter.eventType = eventType;

    const logs = await WhatsAppLog.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(Number(limit))
      .populate("userId", "username email")
      .populate("orderId", "_id totalAmount")
      .lean();

    const total = await WhatsAppLog.countDocuments(filter);

    res.json({ success: true, logs, total, page: Number(page), pages: Math.ceil(total / limit) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/whatsapp/test
// Body: { phone, templateKey, params }
router.post("/test", protect, adminOnly, async (req, res) => {
  try {
    if (!isConfigured()) {
      return res.status(503).json({
        success: false,
        error: "WhatsApp not configured. Set WHATSAPP_ACCESS_TOKEN and WHATSAPP_PHONE_NUMBER_ID in .env",
      });
    }

    const { phone, templateKey, params } = req.body;
    if (!phone || !templateKey) {
      return res.status(400).json({ success: false, error: "phone and templateKey are required" });
    }
    if (!TEMPLATES[templateKey]) {
      return res.status(400).json({
        success: false,
        error: `Unknown templateKey. Valid keys: ${Object.keys(TEMPLATES).join(", ")}`,
      });
    }

    await sendWhatsApp({
      to: phone,
      templateKey,
      templateParams: params || [],
      eventType: templateKey,
    });

    res.json({ success: true, message: `Test message queued to ${phone}` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/whatsapp/resend/:logId
router.post("/resend/:logId", protect, adminOnly, async (req, res) => {
  try {
    const log = await WhatsAppLog.findById(req.params.logId);
    if (!log) return res.status(404).json({ success: false, error: "Log not found" });

    const templateKey = Object.keys(TEMPLATES).find((k) => TEMPLATES[k].name === log.templateName);
    if (!templateKey) {
      return res.status(400).json({ success: false, error: `No template found for: ${log.templateName}` });
    }

    // Reset for retry
    log.status = "pending";
    log.attempts = 0;
    log.nextRetryAt = null;
    log.error = undefined;
    await log.save();

    await sendWhatsApp({
      to: log.to,
      templateKey,
      templateParams: log.variables,
      orderId: log.orderId,
      userId: log.userId,
      eventType: log.eventType,
    });

    res.json({ success: true, message: "Resend triggered" });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/whatsapp/retry-failed
router.post("/retry-failed", protect, adminOnly, async (req, res) => {
  try {
    const count = await retryFailedNotifications();
    res.json({ success: true, message: `Retried ${count} failed notification(s)` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/whatsapp/send-order-status
// Body: { orderId, status } — manually trigger a customer WA for any order
router.post("/send-order-status", protect, adminOnly, async (req, res) => {
  try {
    const { orderId, status } = req.body;
    if (!orderId || !status) return res.status(400).json({ success: false, error: "orderId and status required" });

    const order = await Order.findById(orderId);
    if (!order) return res.status(404).json({ success: false, error: "Order not found" });

    const user = await User.findById(order.userId).lean();
    await notifyCustomerStatusChange(order, user, status);

    res.json({ success: true, message: `WhatsApp notification triggered for status: ${status}` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
