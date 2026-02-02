const express = require("express");
const router = express.Router();
const Razorpay = require("razorpay");
const crypto = require("crypto");
const Order = require("../models/Order");
const Cart = require("../models/Cart");
const Product = require("../models/Product");
const { protect } = require("../middlewares/authMiddleware");

// Initialize Razorpay instance
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});


// Create Razorpay order
router.post("/", protect, async (req, res) => {
  try {
    const { amount, currency, shippingAddress, items } = req.body;
    
    // Check if user exists
    if (!req.user || !req.user._id) {
      return res.status(401).json({ message: "User not authenticated" });
    }
    
    const userId = req.user._id;

    // Validate required fields
    if (!amount || amount <= 0) {
      return res.status(400).json({ message: "Valid amount is required" });
    }

    if (!currency) {
      return res.status(400).json({ message: "Currency is required" });
    }

    // Convert amount from paise to rupees for database storage
    const totalAmount = amount / 100;

    let orderItems = [];

    // If items are provided, use them; otherwise get from cart or create default
    if (items && items.length > 0) {
      // Validate and process provided items (ensure they match new schema)
      orderItems = items.map(item => ({
        product: {
          _id: item.productId || null,
          name: item.name || "Direct Payment Item",
          price: 1,
          description: item.description || "Direct payment transaction",
          category: item.category || "General",
          subCategory: item.subCategory || "Payment",
        },
        quantity: item.quantity || 1,
        totalPrice: (item.price || totalAmount) * (item.quantity || 1),
      }));
    } else {
      // Try to get from cart first
      const cart = await Cart.findOne({ userId }).populate("items.productId");
      if (cart && cart.items.length > 0) {
        for (const item of cart.items) {
          const product = item.productId;
          orderItems.push({
            product: {
              _id: product._id,
              name: product.name,
              price: product.price,
              description: product.description,
              category: product.category,
              subCategory: product.subCategory,
            },
            quantity: item.quantity,
            totalPrice: product.price * item.quantity,
          });
        }
      } else {
        // Create a default item for direct payment (no specific products)
        orderItems = [{
          product: {
            _id: null,
            name: "Direct Payment",
            price: totalAmount,
            description: "Direct payment transaction without specific product",
            category: "Payment",
            subCategory: "Direct",
          },
          quantity: 1,
          totalPrice: totalAmount,
        }];
      }
    }

    // Default shipping address if not provided (match new schema)
    const defaultShippingAddress = shippingAddress || {
      street: "Address not provided",
      city: "City not provided",
      state: "State not provided",
      country: "India",
      zipCode: "000000",
    };


    // Create order in database
    const order = new Order({
      userId,
      items: orderItems,
      totalAmount,
      currency: currency || "INR",
      shippingAddress: shippingAddress,
      status: "pending",
    });

    await order.save();

    const razorpayOrder = await razorpay.orders.create({
      amount: amount, // Amount is already in paise from frontend
      currency: currency || "INR",
      receipt: `order_${order._id}`,
      payment_capture: 1,
    });

    // Update order with Razorpay order ID
    order.razorpayOrderId = razorpayOrder.id;
    await order.save();

    res.json({
      success: true,
      order: {
        id: order._id,
        razorpayOrderId: razorpayOrder.id,
        amount: amount / 100, // Amount in rupees for display
        amountInPaise: amount, // Amount in paise for Razorpay
        currency: currency || "INR",
      },
      razorpayKeyId: process.env.RAZORPAY_KEY_ID,
    });
  } catch (error) {
    console.error("Error creating order:", error);
    res.status(500).json({ message: "Failed to create order", error: error.message });
  }
});

// Verify payment
router.post("/verify-payment", protect, async (req, res) => {
  try {
    const { razorpayOrderId, razorpayPaymentId, razorpaySignature, orderId } = req.body;

    // Validate required fields
    if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
      return res.status(400).json({
        success: false,
        message: "Missing payment verification details",
      });
    }

    // Generate signature for verification
    const body = razorpayOrderId + "|" + razorpayPaymentId;
    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(body.toString())
      .digest("hex");

    if (expectedSignature === razorpaySignature) {
      // Payment is valid
      const order = await Order.findById(orderId);
      if (!order) {
        console.error("Order not found in database:", orderId);
        return res.status(404).json({ 
          success: false,
          message: "Order not found" 
        });
      }

      // Update order status to confirmed (payment successful)
      order.status = "confirmed";
      order.razorpayPaymentId = razorpayPaymentId;
      order.razorpaySignature = razorpaySignature;
      order.updatedAt = new Date();
      await order.save();

      // Clear user's cart
      try {
        await Cart.findOneAndDelete({ userId: req.user._id });
      } catch (cartError) {
        console.warn("Warning: Could not clear cart -", cartError.message);
        // Don't fail the payment verification if cart clearing fails
      }

      res.json({
        success: true,
        message: "Payment verified successfully",
        order: order,
      });
    } else {
      // Payment verification failed
      console.error("Signature mismatch for order:", orderId);
      console.error("Expected:", expectedSignature);
      console.error("Received:", razorpaySignature);
      
      const order = await Order.findById(orderId);
      if (order) {
        order.status = "cancelled";
        order.failureReason = "Signature verification failed";
        order.updatedAt = new Date();
        await order.save();
      }

      res.status(400).json({
        success: false,
        message: "Payment verification failed - Signature mismatch",
        debug: {
          expectedSignature: expectedSignature,
          receivedSignature: razorpaySignature,
          match: expectedSignature === razorpaySignature
        }
      });
    }
  } catch (error) {
    console.error("Error verifying payment:", error);
    res.status(500).json({ 
      success: false,
      message: "Payment verification failed", 
      error: error.message 
    });
  }
});

// Get order details
router.get("/order/:orderId", protect, async (req, res) => {
  try {
    const order = await Order.findById(req.params.orderId)
      .populate("items.productId")
      .populate("userId", "name email");

    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    // Check if user owns this order
    if (order.userId._id.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: "Access denied" });
    }

    res.json({ success: true, order });
  } catch (error) {
    console.error("Error fetching order:", error);
    res.status(500).json({ message: "Failed to fetch order", error: error.message });
  }
});

// Get user's orders
router.get("/orders", protect, async (req, res) => {
  try {
    const orders = await Order.find({ userId: req.user._id })
      .populate("items.productId")
      .sort({ createdAt: -1 });

    res.json({ success: true, orders });
  } catch (error) {
    console.error("Error fetching orders:", error);
    res.status(500).json({ message: "Failed to fetch orders", error: error.message });
  }
});

// Handle payment failure
router.post("/payment-failed", protect, async (req, res) => {
  try {
    const { orderId, error } = req.body;

    const order = await Order.findById(orderId);
    if (order) {
      order.status = "cancelled";
      order.updatedAt = new Date();
      await order.save();
    }

    res.json({
      success: true,
      message: "Payment failure recorded",
    });
  } catch (error) {
    console.error("Error handling payment failure:", error);
    res.status(500).json({ message: "Failed to handle payment failure", error: error.message });
  }
});

// Create simple Razorpay order (no database record) - RECOMMENDED FOR YOUR USE CASE
router.post("/create-simple-order", protect, async (req, res) => {
  try {
    const { amount, currency = "INR" } = req.body;
    
    if (!req.user || !req.user._id) {
      return res.status(401).json({ message: "User not authenticated" });
    }

    if (!amount || amount <= 0) {
      return res.status(400).json({ message: "Valid amount is required" });
    }

    // Create Razorpay order directly (no database record)
    const razorpayOrder = await razorpay.orders.create({
      amount: amount, // Amount in paise
      currency: currency,
      receipt: `simple_${req.user._id}_${Date.now()}`,
      payment_capture: 1,
    });

    res.json({
      success: true,
      order: {
        razorpayOrderId: razorpayOrder.id,
        amount: amount / 100, // Amount in rupees for display
        amountInPaise: amount, // Amount in paise for Razorpay
        currency: currency,
      },
      razorpayKeyId: process.env.RAZORPAY_KEY_ID,
    });
  } catch (error) {
    console.error("Error creating simple order:", error);
    res.status(500).json({ message: "Failed to create order", error: error.message });
  }
});

// Create order without Razorpay (for direct amount payments)
router.post("/create-direct-order", protect, async (req, res) => {
  try {
    const { amount, currency = "INR" } = req.body;
    
    if (!req.user || !req.user._id) {
      return res.status(401).json({ message: "User not authenticated" });
    }

    if (!amount || amount <= 0) {
      return res.status(400).json({ message: "Valid amount is required" });
    }

    const userId = req.user._id;
    const totalAmount = amount / 100; // Convert paise to rupees

    // Create Razorpay order directly
    const razorpayOrder = await razorpay.orders.create({
      amount: amount, // Amount in paise
      currency: currency,
      receipt: `direct_order_${Date.now()}`,
      payment_capture: 1,
    });

    res.json({
      success: true,
      razorpayOrder: {
        id: razorpayOrder.id,
        amount: razorpayOrder.amount,
        currency: razorpayOrder.currency,
      },
      razorpayKeyId: process.env.RAZORPAY_KEY_ID,
    });
  } catch (error) {
    console.error("Error creating direct order:", error);
    res.status(500).json({ message: "Failed to create order", error: error.message });
  }
});

// Get Razorpay config
router.get("/config", (req, res) => {
  res.json({
    razorpayKeyId: process.env.RAZORPAY_KEY_ID,
  });
});

module.exports = router;