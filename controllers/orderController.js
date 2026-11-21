const mongoose = require("mongoose");
const Order = require("../models/Order");
const Product = require("../models/Product");
const Notification = require("../models/Notification");
const User = require("../models/User");
const { notifyCustomerStatusChange } = require("../services/whatsappService");
const { resolveUnitPrice } = require("../utils/stringSizes");
const { releaseCouponUse } = require("../utils/coupons");
const { enqueueEmail } = require("../utils/emailQueue");
const { sendAdminOrderCancelledEmail } = require("../utils/emailService");

// Customers may cancel a paid order until it is shipped.
const CUSTOMER_CANCELLABLE = ["confirmed", "processing"];

const createOrder = async (req, res) => {
  try {
    const { items, shippingAddress, discount } = req.body;
    const userId = req.user._id;

    // Batch-fetch all products in one query — never trust client-sent prices
    const productIds = items.map((i) => i.product?._id || i.productId).filter(Boolean);
    const dbProducts = await Product.find({ _id: { $in: productIds }, isActive: true }).lean();
    const productMap = Object.fromEntries(dbProducts.map((p) => [String(p._id), p]));

    const verifiedItems = [];
    for (const item of items) {
      const prodId = String(item.product?._id || item.productId);
      const dbProduct = productMap[prodId];

      if (!dbProduct) {
        return res.status(400).json({
          success: false,
          error: `Product not found or unavailable: ${prodId}`,
        });
      }
      if (dbProduct.stock < item.quantity) {
        return res.status(400).json({
          success: false,
          error: `Insufficient stock for "${dbProduct.name}" (requested: ${item.quantity}, available: ${dbProduct.stock})`,
        });
      }

      const resolved = resolveUnitPrice(dbProduct, item.stringSize ?? item.selectedStringSize);
      if (resolved.error) {
        return res.status(400).json({ success: false, error: resolved.error });
      }

      verifiedItems.push({
        product: {
          _id:         dbProduct._id,
          name:        dbProduct.name,
          price:       resolved.price,         // always use DB price (size-specific for string products)
          description: dbProduct.description || "",
          category:    dbProduct.category,
          subCategory: dbProduct.subCategory,
        },
        quantity:   item.quantity,
        selectedStringSize: resolved.stringSize,
        totalPrice: resolved.price * item.quantity,
        variant:    item.variant || {},
      });
    }

    const subtotal = verifiedItems.reduce((sum, i) => sum + i.totalPrice, 0);

    const order = new Order({
      userId,
      items: verifiedItems,
      subtotal,
      totalAmount: subtotal,
      shippingAddress,
      ...(discount ? { discount } : {}),
    });

    await order.save();
    res.status(201).json({ success: true, order });
  } catch (error) {
    console.error("Error creating order:", error);
    res.status(500).json({ success: false, error: "Failed to create order" });
  }
};

const getUserOrders = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 10));

    const [orders, total] = await Promise.all([
      Order.find({ userId: req.user._id })
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Order.countDocuments({ userId: req.user._id }),
    ]);

    res.json({
      success: true,
      count: orders.length,
      total,
      page,
      pages: Math.ceil(total / limit),
      orders,
    });
  } catch (error) {
    console.error("Error fetching orders:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch orders",
      error: error.message,
    });
  }
};

const getOrderById = async (req, res) => {
  try {
    const { orderId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(orderId)) {
      return res.status(400).json({ success: false, message: "Invalid order ID" });
    }

    const order = await Order.findOne({ _id: orderId, userId: req.user._id }).lean();
    if (!order) {
      return res.status(404).json({ success: false, message: "Order not found" });
    }

    res.json({ success: true, order });
  } catch (error) {
    console.error("Error fetching order:", error);
    res.status(500).json({ success: false, message: "Failed to fetch order", error: error.message });
  }
};

const updateOrderStatus = async (req, res) => {
  try {
    const { orderId } = req.params;
    const { status } = req.body;

    if (!mongoose.Types.ObjectId.isValid(orderId)) {
      return res.status(400).json({ success: false, message: "Invalid order ID" });
    }

    const validStatuses = ["pending", "confirmed", "processing", "cancelled", "shipped", "out_for_delivery", "delivered"];
    if (!status || !validStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        message: `Invalid status. Valid statuses are: ${validStatuses.join(", ")}`,
      });
    }

    const order = await Order.findById(orderId);
    if (!order) {
      return res.status(404).json({ success: false, message: "Order not found" });
    }

    const oldStatus = order.status;

    const statusUpdate = { status, updatedAt: new Date() };
    if (status === "delivered") statusUpdate.deliveredAt = new Date();
    if (status !== oldStatus) {
      // Remember the change for the customer until they've seen it (they may be offline right now)
      statusUpdate.statusNotice = {
        status,
        previousStatus: order.statusNotice?.previousStatus || oldStatus,
        at: new Date(),
      };
    }

    const result = await Order.updateOne(
      { _id: orderId },
      { $set: statusUpdate },
    );

    if (!result.acknowledged) {
      return res.status(500).json({ success: false, message: "Failed to update order status" });
    }

    // Restore stock if order is cancelled from an active state.
    // Use bulkWrite with $inc — atomic, no read-before-write, single round-trip.
    if (status === "cancelled" && ["confirmed", "processing", "shipped"].includes(oldStatus)) {
      try {
        const restoreOps = order.items
          .filter((item) => item.product?._id)
          .map((item) => ({
            updateOne: {
              filter: { _id: item.product._id, trackInventory: true },
              update: { $inc: { stock: item.quantity }, $set: { updatedAt: new Date() } },
            },
          }));
        if (restoreOps.length) await Product.bulkWrite(restoreOps);
      } catch (stockError) {
        console.warn("Warning: Could not restore stock -", stockError.message);
      }
    }

    const updatedOrder = await Order.findById(orderId).populate("userId", "username email");

    // Create admin notification when order status is updated
    // Notify admins about important status changes
    const notificationMessages = {
      pending: "Order awaiting confirmation",
      confirmed: "Order has been confirmed",
      processing: "Order is being processed for shipment",
      shipped: "Order has been shipped",
      out_for_delivery: "Order is out for delivery",
      delivered: "Order has been delivered",
      cancelled: "Order has been cancelled",
    };

    const notificationMessage = notificationMessages[status] || `Order status updated to ${status}`;
    await Notification.create({
      type: "order_status_update",
      message: `Order #${order._id.toString().slice(-6).toUpperCase()} — ${notificationMessage}`,
      orderId: order._id,
      read: false,
      meta: {
        orderId: order._id,
        userId: order.userId,
        previousStatus: oldStatus,
        newStatus: status,
        totalAmount: order.totalAmount,
        customerEmail: updatedOrder?.userId?.email,
      },
    }).catch((err) => {
      console.error("Failed to create order status notification:", err.message);
    });

    // Push real-time SSE update to the customer
    try {
      const { pushOrderUpdate } = require("../routes/sse");
      pushOrderUpdate(order.userId.toString(), updatedOrder, oldStatus);
    } catch (sseErr) {
      console.error("[SSE] pushOrderUpdate failed:", sseErr.message);
    }

    // WhatsApp notification to customer
    setImmediate(async () => {
      try {
        const customer = await User.findById(order.userId).lean();
        await notifyCustomerStatusChange(updatedOrder, customer, status);
      } catch (e) {
        console.error("[WhatsApp] Customer status notification error:", e.message);
      }
    });

    res.json({
      success: true,
      message: `Order status updated to ${status}`,
      order: updatedOrder,
    });
  } catch (error) {
    console.error("Error updating order status:", error);
    res.status(500).json({
      success: false,
      message: "Failed to update order status",
      error: error.message,
    });
  }
};

// GET /api/orders/status-updates — admin status changes the customer hasn't seen yet
const getStatusUpdates = async (req, res) => {
  try {
    const orders = await Order.find({ userId: req.user._id, "statusNotice.status": { $exists: true } })
      .sort({ "statusNotice.at": -1 })
      .limit(20)
      .lean();
    const updates = orders
      .filter((o) => o.statusNotice?.status === o.status) // a later change by someone else supersedes a stale notice
      .map(({ statusNotice, ...order }) => ({ order, previousStatus: statusNotice.previousStatus || null, at: statusNotice.at }));
    res.json({ success: true, updates });
  } catch (error) {
    console.error("Error fetching status updates:", error);
    res.status(500).json({ success: false, message: "Failed to fetch status updates" });
  }
};

// POST /api/orders/status-updates/ack  { items: [{ orderId, status }] } — customer has seen these
const ackStatusUpdates = async (req, res) => {
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items.slice(0, 50) : [];
    const ops = items
      .filter((i) => mongoose.Types.ObjectId.isValid(i?.orderId) && typeof i?.status === "string")
      .map((i) => ({
        updateOne: {
          // matching on status means a newer admin change (not yet shown) is never acknowledged by mistake
          filter: { _id: i.orderId, userId: req.user._id, "statusNotice.status": i.status },
          update: { $unset: { statusNotice: "" } },
        },
      }));
    if (ops.length) await Order.bulkWrite(ops);
    res.json({ success: true });
  } catch (error) {
    console.error("Error acknowledging status updates:", error);
    res.status(500).json({ success: false, message: "Failed to acknowledge status updates" });
  }
};

// GET /api/orders/:orderId/invoice — Bill of Supply PDF. Owner or admin only; unpaid/cancelled orders get none.
const downloadInvoice = async (req, res) => {
  try {
    const { orderId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(orderId)) {
      return res.status(400).json({ success: false, message: "Invalid order ID" });
    }
    const filter = req.user.isAdmin ? { _id: orderId } : { _id: orderId, userId: req.user._id };
    const order = await Order.findOne(filter).lean();
    if (!order) return res.status(404).json({ success: false, message: "Order not found" });
    if (order.status === "cancelled" || (order.paymentMethod !== "cod" && order.paymentStatus !== "completed" && order.paymentStatus !== "refunded")) {
      return res.status(409).json({ success: false, message: "An invoice is only available for confirmed orders" });
    }

    const customer = await User.findById(order.userId).select("username email").lean();
    const { buildInvoicePdf, invoiceNumber } = require("../utils/invoicePdf");
    const doc = buildInvoicePdf(order, customer || {});
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${invoiceNumber(order)}.pdf"`);
    res.setHeader("Cache-Control", "private, no-store");
    doc.pipe(res);
    doc.end();
  } catch (error) {
    console.error("Error generating invoice:", error);
    if (!res.headersSent) res.status(500).json({ success: false, message: "Failed to generate invoice" });
  }
};

// POST /api/shipping/cancel/:orderId — the customer cancels their own order before it is shipped.
// Paid orders are refunded in full to the original payment method via Razorpay.
const cancelOrder = async (req, res) => {
  try {
    const { orderId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(orderId)) {
      return res.status(400).json({ success: false, message: "Invalid order ID" });
    }
    const reason = String(req.body?.reason || "").trim().slice(0, 500);

    const existing = await Order.findOne({ _id: orderId, userId: req.user._id });
    if (!existing) return res.status(404).json({ success: false, message: "Order not found" });
    if (!CUSTOMER_CANCELLABLE.includes(existing.status) || existing.paymentStatus !== "completed") {
      const shipped = ["shipped", "out_for_delivery", "delivered", "returned"].includes(existing.status);
      return res.status(400).json({
        success: false,
        message: existing.status === "cancelled"
          ? "This order is already cancelled"
          : shipped
            ? "This order has already been shipped and can no longer be cancelled. You can request a return after delivery."
            : "This order cannot be cancelled online. Please contact us for help.",
      });
    }

    const wasPaid = existing.paymentStatus === "completed";
    const now = new Date();

    // Atomic claim: only flips if the order is still cancellable (guards against a concurrent admin update)
    const order = await Order.findOneAndUpdate(
      { _id: orderId, userId: req.user._id, status: { $in: CUSTOMER_CANCELLABLE } },
      {
        $set: {
          status: "cancelled",
          updatedAt: now,
          cancellation: { by: "customer", reason, at: now, refundStatus: wasPaid ? "initiated" : "not_required" },
        },
        $push: {
          timeline: {
            status: "cancelled",
            title: "Order Cancelled",
            description: reason ? `Cancelled by customer: ${reason}` : "Cancelled by customer",
            timestamp: now,
          },
        },
      },
      { new: true },
    );
    if (!order) {
      return res.status(409).json({ success: false, message: "This order's status just changed. Please refresh and try again." });
    }

    let refundFailed = false;
    if (wasPaid) {
      // Stock was deducted when payment was confirmed — put it back
      const restoreOps = order.items
        .filter((item) => item.product?._id)
        .map((item) => ({
          updateOne: {
            filter: { _id: item.product._id, trackInventory: true },
            update: { $inc: { stock: item.quantity }, $set: { updatedAt: now } },
          },
        }));
      if (restoreOps.length) await Product.bulkWrite(restoreOps).catch((e) => console.warn("[Cancel] Stock restore failed:", e.message));

      if (order.discount?.code) {
        await releaseCouponUse(order.discount.code, order.userId).catch((e) => console.warn("[Cancel] Coupon release failed:", e.message));
      }

      // Full refund to the original payment method
      try {
        const Razorpay = require("razorpay");
        const rzp = new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET });
        const refund = await rzp.payments.refund(order.razorpayPaymentId, {
          amount: Math.round(order.totalAmount * 100),
          notes: { orderId: String(order._id), reason: "Cancelled by customer" },
        });
        await Order.updateOne(
          { _id: order._id },
          {
            $set: { paymentStatus: "refunded", "cancellation.refundId": refund.id },
            $push: {
              timeline: {
                status: "refunded",
                title: "Refund Initiated",
                description: `Refund of ₹${order.totalAmount} initiated to your original payment method (usually 5–7 business days)`,
                timestamp: new Date(),
                metadata: { refundId: refund.id },
              },
            },
          },
        );
      } catch (refundErr) {
        refundFailed = true;
        console.error("[Cancel] Razorpay refund failed:", refundErr?.error?.description || refundErr.message);
        await Order.updateOne({ _id: order._id }, { $set: { "cancellation.refundStatus": "failed" } });
        await Notification.create({
          type: "system",
          message: `⚠️ Refund FAILED for customer-cancelled order #${order._id.toString().slice(-6).toUpperCase()} (₹${order.totalAmount}). Please refund manually in Razorpay.`,
          orderId: order._id,
          read: false,
        }).catch(() => {});
      }
    }

    Notification.create({
      type: "order_status_update",
      message: `Order #${order._id.toString().slice(-6).toUpperCase()} — Cancelled by customer${reason ? `: ${reason}` : ""}`,
      orderId: order._id,
      read: false,
      meta: { orderId: order._id, userId: order.userId, previousStatus: existing.status, newStatus: "cancelled", totalAmount: order.totalAmount },
    }).catch(() => {});

    const updatedOrder = await Order.findById(order._id);
    enqueueEmail(async () => {
      const customer = await User.findById(order.userId).lean();
      await sendAdminOrderCancelledEmail(updatedOrder, customer);
    });
    try {
      require("../routes/sse").pushOrderUpdate(String(order.userId), updatedOrder, existing.status);
    } catch (e) { /* SSE is best-effort */ }

    res.json({
      success: true,
      order: updatedOrder,
      message: !wasPaid
        ? "Your order has been cancelled."
        : refundFailed
          ? "Your order has been cancelled. We couldn't start the refund automatically — our team will refund you within 2 business days."
          : `Your order has been cancelled. A refund of ₹${order.totalAmount} has been initiated and usually reaches you in 5–7 business days.`,
    });
  } catch (error) {
    console.error("Error cancelling order:", error);
    res.status(500).json({ success: false, message: "Failed to cancel order" });
  }
};

module.exports = { cancelOrder, createOrder, getUserOrders, getOrderById, updateOrderStatus, downloadInvoice, getStatusUpdates, ackStatusUpdates };
