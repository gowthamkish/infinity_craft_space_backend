const express = require("express");
const Order = require("../models/Order");
const Product = require("../models/Product");
const router = express.Router();

router.post("/", async (req, res) => {
  const { items } = req.body;
  // Use the authenticated user's ID from the middleware
  const userId = req.user._id;
  const order = new Order({ userId, items });
  await order.save();
  res.json({ success: true, order });
});

// Get orders for the authenticated user
router.get("/", async (req, res) => {
  try {
    // Filter orders by the authenticated user's ID
    const orders = await Order.find({ userId: req.user._id })
      .populate("userId", "username email isAdmin") // Populate user details
      .sort({ createdAt: -1 }); // Sort by newest first

    res.json({
      success: true,
      count: orders.length,
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
});

// Update order status
router.put("/:orderId/status", async (req, res) => {
  try {
    const { orderId } = req.params;
    const { status } = req.body;

    console.log("Updating order status:", orderId, status); // Debug log
    // Validate status
    const validStatuses = [
      "pending",
      "confirmed",
      "processing",
      "cancelled",
      "shipped",
      "delivered",
    ];
    if (!status || !validStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        message: `Invalid status. Valid statuses are: ${validStatuses.join(", ")}`,
      });
    }

    // Find and update the order
    const order = await Order.findById(orderId);
    if (!order) {
      return res.status(404).json({
        success: false,
        message: "Order not found",
      });
    }

    // Store old status to check for stock restoration
    const oldStatus = order.status;

    // Update the order status and timestamp
    order.status = status;
    order.updatedAt = new Date();
    await order.save();

    // Restore stock if order is being cancelled (and was previously confirmed/processing/shipped)
    if (
      status === "cancelled" &&
      ["confirmed", "processing", "shipped"].includes(oldStatus)
    ) {
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
              console.log(
                `Stock restored for ${product.name}: ${product.stock} -> ${newStock} (Order ${orderId} cancelled)`,
              );
            }
          }
        }
      } catch (stockError) {
        console.warn("Warning: Could not restore stock -", stockError.message);
        // Don't fail the order update if stock restoration fails
      }
    }

    // Return the updated order with user details
    const updatedOrder = await Order.findById(orderId).populate(
      "userId",
      "username email",
    );

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
});

module.exports = router;
