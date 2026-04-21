/**
 * Shipping Routes — /api/shipping
 *
 * GET  /rates              → fetch shipping rates for a pincode
 * GET  /track/:orderId     → get live tracking for an order
 * POST /cancel/:orderId    → cancel shipment
 * POST /return/:orderId    → create return order
 * POST /webhook            → Shiprocket webhook handler (no auth)
 */

const express = require("express");
const router = express.Router();
const Order = require("../models/Order");
const User = require("../models/User");
const Notification = require("../models/Notification");
const { protect } = require("../middlewares/authMiddleware");
const shiprocket = require("../services/shiprocketService");

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/shipping/pickup-locations  (Admin: list valid Shiprocket pickup names)
// ─────────────────────────────────────────────────────────────────────────────
router.get("/pickup-locations", protect, async (req, res) => {
  if (!req.user?.isAdmin)
    return res.status(403).json({ success: false, error: "Admin only" });
  try {
    const axios = require("axios");
    const token = await shiprocket.getToken();
    const r = await axios.get(
      "https://apiv2.shiprocket.in/v1/external/settings/company/pickup",
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      },
    );
    const locations = (r.data?.data?.shipping_address || []).map((loc) => ({
      name: loc.pickup_location,
      address: `${loc.address}, ${loc.city}, ${loc.state} ${loc.pin_code}`,
      isActive: loc.status === 1,
    }));
    console.log(
      "[Shiprocket] Available pickup locations:",
      locations.map((l) => l.name).join(" | "),
    );
    res.json({
      success: true,
      current: process.env.SHIPROCKET_PICKUP_LOCATION,
      locations,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/shipping/rates
// Query: pincode, weight (optional), cod (0|1), declaredValue (optional)
// ─────────────────────────────────────────────────────────────────────────────
router.get("/rates", protect, async (req, res) => {
  try {
    const {
      pincode,
      weight = "0.5",
      cod = "0",
      declaredValue = "500",
    } = req.query;

    if (!pincode || !/^\d{6}$/.test(pincode)) {
      return res
        .status(400)
        .json({ success: false, error: "Valid 6-digit pincode is required" });
    }

    console.log("[Shipping] Fetching rates for:", {
      pincode,
      weight,
      cod,
      declaredValue,
    });

    const rates = await shiprocket.getShippingRates({
      deliveryPincode: pincode,
      weight: parseFloat(weight),
      cod: parseInt(cod, 10),
      declaredValue: parseFloat(declaredValue),
    });

    res.json({ success: true, rates });
  } catch (err) {
    console.error(
      "[Shipping] Rate fetch error:",
      err.response?.data || err.message,
    );
    res.status(500).json({
      success: false,
      error: "Failed to fetch shipping rates",
      details: process.env.NODE_ENV === "development" ? err.message : undefined,
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/shipping/track/:orderId
// ─────────────────────────────────────────────────────────────────────────────
router.get("/track/:orderId", protect, async (req, res) => {
  try {
    const order = await Order.findById(req.params.orderId);
    if (!order) {
      return res.status(404).json({ success: false, error: "Order not found" });
    }

    // Ensure the requesting user owns this order
    if (order.userId.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, error: "Access denied" });
    }

    const { shipmentId, awbCode, courierName, trackingUrl } =
      order.shiprocket || {};

    if (!shipmentId && !awbCode) {
      return res.json({
        success: true,
        tracking: null,
        order: {
          _id: order._id,
          status: order.status,
          shiprocket: order.shiprocket,
          timeline: order.timeline,
          createdAt: order.createdAt,
          totalAmount: order.totalAmount,
          subtotal: order.subtotal,
          shipping: order.shipping,
          shippingAddress: order.shippingAddress,
          items: order.items,
          estimatedDelivery: order.estimatedDelivery,
        },
        message: "Shipment not yet created",
      });
    }

    const tracking = await shiprocket.trackShipment(shipmentId, awbCode);

    // Update lastSyncAt on the order (fire and forget)
    Order.findByIdAndUpdate(order._id, {
      "shiprocket.currentStatus": tracking.currentStatus,
      "shiprocket.lastSyncAt": new Date(),
    }).catch(() => {});

    res.json({
      success: true,
      tracking,
      order: {
        _id: order._id,
        status: order.status,
        shiprocket: order.shiprocket,
        timeline: order.timeline,
        createdAt: order.createdAt,
        shippingAddress: order.shippingAddress,
        items: order.items,
        subtotal: order.subtotal,
        shipping: order.shipping,
        discount: order.discount,
        totalAmount: order.totalAmount,
      },
    });
  } catch (err) {
    console.error("[Shipping] Track error:", err.message);
    res
      .status(500)
      .json({ success: false, error: "Failed to fetch tracking information" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/shipping/cancel/:orderId
// ─────────────────────────────────────────────────────────────────────────────
router.post("/cancel/:orderId", protect, async (req, res) => {
  try {
    const order = await Order.findById(req.params.orderId);
    if (!order) {
      return res.status(404).json({ success: false, error: "Order not found" });
    }
    if (order.userId.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, error: "Access denied" });
    }
    if (!["confirmed", "processing"].includes(order.status)) {
      return res.status(400).json({
        success: false,
        error: `Cannot cancel order with status: ${order.status}`,
      });
    }

    const srOrderId = order.shiprocket?.shiprocketOrderId;
    const awbCode = order.shiprocket?.awbCode;

    if (awbCode) {
      await shiprocket
        .cancelAWB(awbCode)
        .catch((e) =>
          console.warn("[Shipping] AWB cancel warning:", e.message),
        );
    } else if (srOrderId) {
      await shiprocket
        .cancelShiprocketOrder(srOrderId)
        .catch((e) =>
          console.warn("[Shipping] Order cancel warning:", e.message),
        );
    }

    order.status = "cancelled";
    order.timeline.push({
      status: "cancelled",
      title: "Order Cancelled",
      description: "Order was cancelled by the customer",
      timestamp: new Date(),
    });
    await order.save();

    res.json({ success: true, message: "Order cancelled successfully" });
  } catch (err) {
    console.error("[Shipping] Cancel error:", err.message);
    res
      .status(500)
      .json({ success: false, error: "Failed to cancel shipment" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/shipping/return/:orderId
// ─────────────────────────────────────────────────────────────────────────────
router.post("/return/:orderId", protect, async (req, res) => {
  try {
    const order = await Order.findById(req.params.orderId);
    if (!order) {
      return res.status(404).json({ success: false, error: "Order not found" });
    }
    if (order.userId.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, error: "Access denied" });
    }
    if (order.status !== "delivered") {
      return res.status(400).json({
        success: false,
        error: "Only delivered orders can be returned",
      });
    }

    const user = await User.findById(order.userId);
    const srOrderId = order.shiprocket?.shiprocketOrderId;

    const returnData = await shiprocket.createReturnOrder({
      shiprocketOrderId: srOrderId,
      order,
      user,
    });

    order.status = "returned";
    order.hasReturnRequest = true;
    order.shiprocket = {
      ...order.shiprocket,
      returnOrderId: returnData?.order_id?.toString(),
    };
    order.timeline.push({
      status: "returned",
      title: "Return Initiated",
      description: "Return pickup has been scheduled",
      timestamp: new Date(),
    });
    await order.save();

    res.json({
      success: true,
      message: "Return order created successfully",
      returnOrderId: returnData?.order_id,
    });
  } catch (err) {
    console.error("[Shipping] Return error:", err.message);
    res
      .status(500)
      .json({ success: false, error: "Failed to create return order" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/shipping/webhook
// No auth middleware — Shiprocket calls this endpoint directly.
// Secure with SHIPROCKET_WEBHOOK_TOKEN header check.
// ─────────────────────────────────────────────────────────────────────────────
router.post("/webhook", async (req, res) => {
  try {
    // Security: verify webhook origin via HMAC signature or static token
    const webhookSecret = process.env.SHIPROCKET_WEBHOOK_SECRET;
    const webhookToken = process.env.SHIPROCKET_WEBHOOK_TOKEN;

    if (webhookSecret) {
      // Preferred: HMAC-SHA256 signature verification
      const signature = req.headers["x-shiprocket-signature"] || req.headers["x-sr-signature"];
      if (signature) {
        const crypto = require("crypto");
        const body = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
        const expectedSig = crypto
          .createHmac("sha256", webhookSecret)
          .update(body)
          .digest("hex");
        if (signature !== expectedSig) {
          console.warn("[Shiprocket Webhook] HMAC signature mismatch");
          return res.status(401).json({ error: "Unauthorized" });
        }
      }
    } else if (webhookToken) {
      // Fallback: static token comparison
      const receivedToken = req.headers["x-shiprocket-token"] || req.query.token;
      if (receivedToken !== webhookToken) {
        console.warn("[Shiprocket Webhook] Invalid token received");
        return res.status(401).json({ error: "Unauthorized" });
      }
    }

    const payload = req.body;
    console.log("[Shiprocket Webhook] Received:", JSON.stringify(payload));

    const awbCode = payload.awb;
    const srStatusId = payload.current_status_id || payload.status_id;
    const srStatus = payload.current_status || payload.status;
    const shipmentId = payload.shipment_id?.toString();

    if (!awbCode && !shipmentId) {
      return res.status(400).json({ error: "Missing awb or shipment_id" });
    }

    // Find the order by AWB code or Shiprocket shipment ID
    const order = await Order.findOne(
      awbCode
        ? { "shiprocket.awbCode": awbCode }
        : { "shiprocket.shipmentId": shipmentId },
    );

    if (!order) {
      console.warn(
        `[Shiprocket Webhook] No order found for AWB: ${awbCode} / Shipment: ${shipmentId}`,
      );
      return res.json({ success: true, message: "Order not found, skipping" });
    }

    // Map Shiprocket status → internal status
    const newInternalStatus = shiprocket.mapSRStatus(srStatusId);

    // Status progression guard: don't regress (e.g., delivered → shipped)
    const STATUS_RANK = {
      pending: 0,
      confirmed: 1,
      processing: 2,
      shipped: 3,
      out_for_delivery: 3.5,
      delivered: 4,
      returned: 5,
      cancelled: 6,
    };
    const currentRank = STATUS_RANK[order.status] ?? 0;
    const newRank = STATUS_RANK[newInternalStatus] ?? 0;
    const shouldUpdate = newInternalStatus && newRank > currentRank;

    // Build timeline event
    const timelineEntry = {
      status: newInternalStatus || order.status,
      title: srStatus || "Status Update",
      description: payload.activity || payload.remark || srStatus || "",
      timestamp: payload.date ? new Date(payload.date) : new Date(),
      metadata: {
        srStatusId,
        awbCode,
        location: payload.current_location || "",
        courierName: payload.courier_name || order.shiprocket?.courierName,
      },
    };

    // Build update object
    const update = {
      $push: { timeline: timelineEntry },
      $set: {
        "shiprocket.currentStatus": srStatus,
        "shiprocket.lastSyncAt": new Date(),
        updatedAt: new Date(),
      },
    };

    if (shouldUpdate) {
      update.$set.status = newInternalStatus;

      // Set estimatedDelivery when shipped (if ETD provided)
      if (newInternalStatus === "shipped" && payload.etd) {
        update.$set.estimatedDelivery = new Date(payload.etd);
      }

      console.log(
        `[Shiprocket Webhook] Order ${order._id}: ${order.status} → ${newInternalStatus}`,
      );
    }

    await Order.findByIdAndUpdate(order._id, update);

    // Create admin notification for key status changes
    if (
      newInternalStatus &&
      [
        "shipped",
        "out_for_delivery",
        "delivered",
        "returned",
        "cancelled",
      ].includes(newInternalStatus)
    ) {
      await Notification.create({
        type: "order",
        message: `Order ${order._id} is now ${newInternalStatus} (AWB: ${awbCode})`,
        orderId: order._id,
        read: false,
        meta: { awbCode, srStatus, userId: order.userId },
      }).catch(() => {});
    }

    return res.json({ success: true });
  } catch (err) {
    console.error("[Shiprocket Webhook] Error:", err.message);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/shipping/retry/:orderId   (Admin: manually trigger Shiprocket creation)
// ─────────────────────────────────────────────────────────────────────────────
router.post("/retry/:orderId", protect, async (req, res) => {
  try {
    if (!req.user?.isAdmin) {
      return res.status(403).json({ success: false, error: "Admin only" });
    }

    const order = await Order.findById(req.params.orderId);
    if (!order) {
      return res.status(404).json({ success: false, error: "Order not found" });
    }
    if (!["confirmed", "processing"].includes(order.status)) {
      return res.status(400).json({
        success: false,
        error: "Order must be in confirmed or processing state",
      });
    }

    const user = await User.findById(order.userId);
    const srData = await shiprocket.createShiprocketOrder(order, user);

    order.shiprocket = {
      ...order.shiprocket,
      ...srData,
    };
    order.status = "processing";
    order.trackingNumber = srData.awbCode;
    order.timeline.push({
      status: "processing",
      title: "Shipment Created",
      description: `AWB ${srData.awbCode} assigned via ${srData.courierName}`,
      timestamp: new Date(),
    });
    await order.save();

    res.json({ success: true, shiprocket: srData });
  } catch (err) {
    console.error("[Shipping] Retry error:", err.message);
    res
      .status(500)
      .json({ success: false, error: "Failed to create Shiprocket shipment" });
  }
});

module.exports = router;
