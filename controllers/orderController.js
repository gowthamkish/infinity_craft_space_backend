const Order = require("../models/Order");
const Product = require("../models/Product");

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
      .sort({ createdAt: -1 });

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

    const validStatuses = ["pending", "confirmed", "processing", "cancelled", "shipped", "delivered"];
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

    const result = await Order.updateOne(
      { _id: orderId },
      { $set: { status, updatedAt: new Date() } },
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
