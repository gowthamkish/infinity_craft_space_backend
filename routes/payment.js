const express = require("express");
const router = express.Router();
const Razorpay = require("razorpay");
const crypto = require("crypto");
const mongoose = require("mongoose");
const Order = require("../models/Order");
const Cart = require("../models/Cart");
const Product = require("../models/Product");
const User = require("../models/User");
const Notification = require("../models/Notification");
const { protect } = require("../middlewares/authMiddleware");
// const shiprocket = require("../services/shiprocketService"); // COMMENTED OUT — Shiprocket will be re-enabled in future
const { enqueueEmail } = require("../utils/emailQueue");
const { sendConfirmationEmail } = require("../utils/emailService");

// Lazily initialize Razorpay so credential changes take effect on restart
function getRazorpay() {
  const key_id = process.env.RAZORPAY_KEY_ID;
  const key_secret = process.env.RAZORPAY_KEY_SECRET;
  if (!key_id || !key_secret) {
    throw new Error(
      "RAZORPAY_KEY_ID or RAZORPAY_KEY_SECRET is missing from environment",
    );
  }
  return new Razorpay({ key_id, key_secret });
}

// Create Razorpay order
router.post("/", protect, async (req, res) => {
  try {
    const {
      amount,
      currency,
      shippingAddress,
      items,
      shippingCost = 0,
      shippingCourierId = null,
    } = req.body;

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

    // Stock validation before order creation
    if (items && items.length > 0) {
      const stockErrors = [];
      for (const item of items) {
        // Support both item.productId and item.product._id (frontend sends item.product._id)
        const productId = item.productId || (item.product && item.product._id);
        if (productId) {
          const product = await Product.findById(productId);
          if (product && product.trackInventory) {
            if (product.stock <= 0) {
              stockErrors.push({
                productId: productId,
                name: product.name,
                error: "Out of stock",
              });
            } else if (product.stock < item.quantity) {
              stockErrors.push({
                productId: productId,
                name: product.name,
                error: `Only ${product.stock} available`,
                availableStock: product.stock,
                requestedQuantity: item.quantity,
              });
            }
          }
        }
      }

      if (stockErrors.length > 0) {
        return res.status(400).json({
          success: false,
          message: "Some items are out of stock or have insufficient quantity",
          stockErrors,
        });
      }
    }

    // Convert amount from paise to rupees for database storage
    const totalAmount = amount / 100;

    let orderItems = [];

    // If items are provided, use them; otherwise get from cart or create default
    if (items && items.length > 0) {
      // Validate and process provided items with proper product details
      for (const item of items) {
        let productData = null;

        // Support both item.productId and item.product._id (frontend sends item.product._id)
        const productId = item.productId || (item.product && item.product._id);

        // If productId is provided, fetch full product details from DB
        if (productId) {
          productData = await Product.findById(productId);
        }

        // Use fetched product data or fallback to provided data
        if (productData) {
          orderItems.push({
            product: {
              _id: productData._id,
              name: productData.name,
              price: productData.price,
              description: productData.description,
              category: productData.category,
              subCategory: productData.subCategory,
            },
            quantity: item.quantity || 1,
            totalPrice: productData.price * (item.quantity || 1),
          });
        } else if (item.product) {
          // Frontend sends item.product with full product details
          orderItems.push({
            product: {
              _id: item.product._id || null,
              name: item.product.name || "Product",
              price: item.product.price || 0,
              description: item.product.description || "",
              category: item.product.category || "General",
              subCategory: item.product.subCategory || "Product",
            },
            quantity: item.quantity || 1,
            totalPrice: (item.product.price || 0) * (item.quantity || 1),
          });
        } else {
          // Only use defaults if no product found and proper data not provided
          if (productId || item.name) {
            orderItems.push({
              product: {
                _id: productId || null,
                name: item.name || "Product",
                price: item.price || 0,
                description: item.description || "",
                category: item.category || "General",
                subCategory: item.subCategory || "Product",
              },
              quantity: item.quantity || 1,
              totalPrice: (item.price || 0) * (item.quantity || 1),
            });
          }
        }
      }
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
        orderItems = [
          {
            product: {
              _id: null,
              name: "Direct Payment",
              price: totalAmount,
              description:
                "Direct payment transaction without specific product",
              category: "Payment",
              subCategory: "Direct",
            },
            quantity: 1,
            totalPrice: totalAmount,
          },
        ];
      }
    }

    // Calculate subtotal from order items
    const calculatedSubtotal = orderItems.reduce((sum, item) => {
      return sum + (item.totalPrice || 0);
    }, 0);

    // Ensure shippingAddress has all required fields with proper defaults
    const finalShippingAddress = shippingAddress
      ? {
          street:
            (shippingAddress.street || "").trim() || "Address not provided",
          city: (shippingAddress.city || "").trim() || "City not provided",
          state: (shippingAddress.state || "").trim() || "State not provided",
          country:
            (shippingAddress.country || "India")
              .replace(/\s*\(.*?\)\s*/g, "")
              .trim() || "India",
          zipCode: (shippingAddress.zipCode || "000000").trim(),
          phone: (shippingAddress.phone || "").trim(),
        }
      : {
          street: "Address not provided",
          city: "City not provided",
          state: "State not provided",
          country: "India",
          zipCode: "000000",
          phone: "",
        };

    // Calculate final totalAmount (ensure it's not 0)
    const finalTotalAmount =
      totalAmount || calculatedSubtotal + (shippingCost || 0);

    console.log("[Payment] Creating order with:", {
      subtotal: calculatedSubtotal,
      shipping: shippingCost,
      totalAmount: finalTotalAmount,
      shippingAddress: finalShippingAddress,
    });

    // Call Razorpay FIRST — don't save DB order until Razorpay succeeds
    let razorpayOrder;
    try {
      razorpayOrder = await getRazorpay().orders.create({
        amount: amount,
        currency: currency || "INR",
        receipt: `rcpt_${Date.now()}`,
        payment_capture: 1,
      });
    } catch (rzpErr) {
      const rzpMsg =
        rzpErr?.error?.description ||
        rzpErr?.message ||
        "Razorpay authentication failed";
      console.error(
        "[Payment] Razorpay error:",
        rzpErr?.error || rzpErr?.message,
      );
      console.error(
        "[Payment] KEY_ID loaded:",
        process.env.RAZORPAY_KEY_ID
          ? `${process.env.RAZORPAY_KEY_ID.slice(0, 8)}...`
          : "MISSING",
      );
      return res.status(502).json({
        message: "Payment gateway error. Please try again.",
        detail: rzpMsg,
      });
    }

    // Razorpay succeeded — now persist the order
    const order = new Order({
      userId,
      items: orderItems,
      subtotal: calculatedSubtotal,
      shipping: shippingCost || 0,
      discount: { couponCode: null, amount: 0 },
      totalAmount: finalTotalAmount,
      currency: currency || "INR",
      shippingAddress: finalShippingAddress,
      status: "pending",
      paymentMethod: "prepaid",
      shippingCourierId: shippingCourierId || null,
      razorpayOrderId: razorpayOrder.id,
    });

    await order.save();

    res.json({
      success: true,
      order: {
        id: order._id,
        razorpayOrderId: razorpayOrder.id,
        amount: amount / 100,
        amountInPaise: amount,
        currency: currency || "INR",
      },
      razorpayKeyId: process.env.RAZORPAY_KEY_ID,
    });
  } catch (error) {
    console.error("Error creating order:", error);
    res
      .status(500)
      .json({ message: "Failed to create order", error: error.message });
  }
});

// Verify payment
router.post("/verify-payment", protect, async (req, res) => {
  try {
    const { razorpayOrderId, razorpayPaymentId, razorpaySignature, orderId } =
      req.body;

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
      // Payment is valid — use a transaction so order + stock are atomic
      const session = await mongoose.startSession();
      session.startTransaction();

      let confirmedOrder;
      try {
        const order = await Order.findById(orderId).session(session);
        if (!order) {
          await session.abortTransaction();
          session.endSession();
          console.error("Order not found in database:", orderId);
          return res
            .status(404)
            .json({ success: false, message: "Order not found" });
        }

        // Update order status atomically
        order.status = "confirmed";
        order.paymentStatus = "completed";
        order.razorpayPaymentId = razorpayPaymentId;
        order.razorpaySignature = razorpaySignature;
        order.updatedAt = new Date();
        order.timeline.push({
          status: "confirmed",
          title: "Payment Confirmed",
          description: `Payment of ₹${order.totalAmount} received via Razorpay`,
          timestamp: new Date(),
          metadata: { razorpayPaymentId },
        });
        await order.save({ session });

        // Deduct stock atomically — abort if any item is out of stock
        for (const item of order.items) {
          if (
            item.product &&
            item.product._id &&
            item.product._id.toString() !== "null"
          ) {
            const updated = await Product.findOneAndUpdate(
              {
                _id: item.product._id,
                $or: [
                  { trackInventory: false },
                  { stock: { $gte: item.quantity } },
                ],
              },
              [
                {
                  $set: {
                    stock: {
                      $cond: [
                        "$trackInventory",
                        { $max: [0, { $subtract: ["$stock", item.quantity] }] },
                        "$stock",
                      ],
                    },
                  },
                },
              ],
              { session, new: true },
            );
            if (!updated) {
              console.warn(
                `[Payment] Stock check failed for ${item.product.name} — proceeding anyway`,
              );
            }
          }
        }

        await session.commitTransaction();
        confirmedOrder = order;
      } catch (txErr) {
        await session.abortTransaction();
        session.endSession();
        console.error("[Payment] Transaction aborted:", txErr.message);
        return res
          .status(500)
          .json({
            success: false,
            message: "Payment confirmation failed. Please contact support.",
            error: txErr.message,
          });
      }
      session.endSession();

      // ── Non-critical post-payment actions (fire-and-forget) ──
      setImmediate(async () => {
        try {
          // Clear user's cart
          await Cart.findOneAndDelete({ userId: req.user._id });

          // Admin notification
          await Notification.create({
            type: "order",
            message: `New order received: #${confirmedOrder._id.toString().slice(-6).toUpperCase()}`,
            orderId: confirmedOrder._id,
            read: false,
            meta: {
              userId: confirmedOrder.userId,
              totalAmount: confirmedOrder.totalAmount,
            },
          });

          // Send confirmation email via queue (non-blocking)
          const user = await User.findById(confirmedOrder.userId).lean();
          if (user?.email) {
            enqueueEmail(() => sendConfirmationEmail(user, confirmedOrder));
          }

          // Push SSE update to the user
          const { pushOrderUpdate } = require("../routes/sse");
          pushOrderUpdate(confirmedOrder.userId.toString(), confirmedOrder);

          /* COMMENTED OUT — Shiprocket integration disabled (will be re-enabled in future)
          // Shiprocket — create shipment after commit
          const srEmail = process.env.SHIPROCKET_EMAIL || "";
          const srPass = process.env.SHIPROCKET_PASSWORD || "";
          const credentialsConfigured =
            srEmail && !srEmail.includes("example.com") &&
            srPass && srPass !== "your_shiprocket_password";

          if (credentialsConfigured && confirmedOrder.shippingAddress?.zipCode !== "000000") {
            const courierId = confirmedOrder.shippingCourierId || req.body?.shippingCourierId || null;
            const srData = await shiprocket.createShiprocketOrder(confirmedOrder, user, courierId);
            const updatedSR = await Order.findByIdAndUpdate(
              confirmedOrder._id,
              {
                $set: { shiprocket: srData, trackingNumber: srData.awbCode, status: "processing" },
                $push: {
                  timeline: {
                    status: "processing",
                    title: "Shipment Created",
                    description: `AWB ${srData.awbCode} assigned via ${srData.courierName}`,
                    timestamp: new Date(),
                    metadata: { awbCode: srData.awbCode, courierName: srData.courierName },
                  },
                },
              },
              { new: true },
            );
            if (updatedSR) pushOrderUpdate(updatedSR.userId.toString(), updatedSR);
          }
          */
        } catch (postErr) {
          console.error(
            "[Payment] Post-payment action failed:",
            postErr.message,
          );
          Notification.create({
            type: "system",
            message: `⚠️ Post-payment action failed for order ${confirmedOrder._id}: ${postErr.message}`,
            orderId: confirmedOrder._id,
            read: false,
          }).catch(() => {});
        }
      });

      // Immediately respond — don't wait for Shiprocket / email
      res.json({
        success: true,
        message: "Payment verified successfully",
        order: confirmedOrder,
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
          match: expectedSignature === razorpaySignature,
        },
      });
    }
  } catch (error) {
    console.error("Error verifying payment:", error);
    res.status(500).json({
      success: false,
      message: "Payment verification failed",
      error: error.message,
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
    res
      .status(500)
      .json({ message: "Failed to fetch order", error: error.message });
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
    res
      .status(500)
      .json({ message: "Failed to fetch orders", error: error.message });
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
    res.status(500).json({
      message: "Failed to handle payment failure",
      error: error.message,
    });
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
    const razorpayOrder = await getRazorpay().orders.create({
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
    res
      .status(500)
      .json({ message: "Failed to create order", error: error.message });
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
    const razorpayOrder = await getRazorpay().orders.create({
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
    res
      .status(500)
      .json({ message: "Failed to create order", error: error.message });
  }
});

// Get Razorpay config
router.get("/config", (req, res) => {
  res.json({
    razorpayKeyId: process.env.RAZORPAY_KEY_ID,
  });
});

module.exports = router;
