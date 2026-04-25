const mongoose = require("mongoose");
const Order = require("../models/Order");
const Product = require("../models/Product");
const Notification = require("../models/Notification");
const User = require("../models/User");
const { notifyCustomerStatusChange } = require("../services/whatsappService");

const createOrder = async (req, res) => {
  const { items } = req.body;
  const userId = req.user._id;
  const order = new Order({ userId, items });
  await order.save();
  res.json({ success: true, order });
};

const getUserOrders = async (req, res) => {
  try {
    const orders = await Order.find({ userId: req.user._id })
      .populate("userId", "username email isAdmin")
      .sort({ createdAt: -1 })
      .lean();

    res.json({ success: true, count: orders.length, orders });
  } catch (error) {
    console.error("Error fetching orders:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch orders",
      error: error.message,
    });
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

    const result = await Order.updateOne(
      { _id: orderId },
      { $set: statusUpdate },
    );

    if (!result.acknowledged) {
      return res.status(500).json({ success: false, message: "Failed to update order status" });
    }

    // Restore stock if order is cancelled from an active state
    if (status === "cancelled" && ["confirmed", "processing", "shipped"].includes(oldStatus)) {
      try {
        for (const item of order.items) {
          if (item.product && item.product._id) {
            const product = await Product.findById(item.product._id);
            if (product && product.trackInventory) {
              const newStock = product.stock + item.quantity;
              await Product.findByIdAndUpdate(item.product._id, {
                stock: newStock,
                updatedAt: new Date(),
              });
            }
          }
        }
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
    } catch {}

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

module.exports = { createOrder, getUserOrders, updateOrderStatus };
