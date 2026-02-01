const express = require("express");
const Order = require("../models/Order");
const router = express.Router();

router.post("/", async (req, res) => {
  const { userId, items } = req.body;
  const order = new Order({ userId, items });
  await order.save();
  res.json({ success: true, order });
});

// Get all orders
router.get("/", async (req, res) => {
  try {
    const orders = await Order.find({})
      .populate("userId", "username email isAdmin") // Populate user details
      .sort({ createdAt: -1 }); // Sort by newest first

    // Debug: Log first order's userId to verify population
    if (orders.length > 0) {
      console.log('First order userId after populate:', JSON.stringify(orders[0].userId, null, 2));
    }

    res.json({ 
      success: true, 
      count: orders.length,
      orders 
    });
  } catch (error) {
    console.error("Error fetching orders:", error);
    res.status(500).json({ 
      success: false, 
      message: "Failed to fetch orders", 
      error: error.message 
    });
  }
});

// Update order status
router.put("/:orderId/status", async (req, res) => {
  try {
    const { orderId } = req.params;
    const { status } = req.body;

    console.log('Updating order status:', orderId, status); // Debug log
    // Validate status
    const validStatuses = ["pending", "confirmed", "processing", "cancelled", "shipped", "delivered"];
    if (!status || !validStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        message: `Invalid status. Valid statuses are: ${validStatuses.join(", ")}`
      });
    }

    // Find and update the order
    const order = await Order.findById(orderId);
    if (!order) {
      return res.status(404).json({
        success: false,
        message: "Order not found"
      });
    }

    // Update the order status and timestamp
    order.status = status;
    order.updatedAt = new Date();
    await order.save();

    // Return the updated order with user details
    const updatedOrder = await Order.findById(orderId)
      .populate("userId", "username email");

    res.json({
      success: true,
      message: `Order status updated to ${status}`,
      order: updatedOrder
    });

  } catch (error) {
    console.error("Error updating order status:", error);
    res.status(500).json({
      success: false,
      message: "Failed to update order status",
      error: error.message
    });
  }
});

module.exports = router;
