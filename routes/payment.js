const express = require("express");
const router = express.Router();
const Razorpay = require("razorpay");
const crypto = require("crypto");
const mongoose = require("mongoose");
const { strictLimiter } = require("../middlewares/rateLimiter");
const Order = require("../models/Order");
const Cart = require("../models/Cart");
const Product = require("../models/Product");
const User = require("../models/User");
const Notification = require("../models/Notification");
const { protect } = require("../middlewares/authMiddleware");
// const shiprocket = require("../services/shiprocketService"); // COMMENTED OUT — Shiprocket will be re-enabled in future
const { enqueueEmail } = require("../utils/emailQueue");
const { sendConfirmationEmail } = require("../utils/emailService");
const { notifyAdminNewOrder } = require("../services/whatsappService");
const { computeShipping } = require("../utils/shippingRates");

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
//
// SECURITY: the amount charged is computed here from database prices plus the
// server-calculated shipping fee. The client's `amount` / `shippingCost` /
// product snapshots are never trusted (they used to be, which allowed paying
// ₹1 for any cart).
router.post("/", protect, async (req, res) => {
  try {
    const { shippingAddress, items, shippingCourierId = null } = req.body;
    const userId = req.user._id;

    // ── 1. Normalise requested lines: [{ productId, quantity }] (dupes merged) ──
    let requested;
    if (Array.isArray(items) && items.length > 0) {
      requested = items.map((item) => ({
        productId: String(item.productId || item.product?._id || ""),
        quantity: Number(item.quantity ?? 1),
      }));
    } else {
      // No items sent — fall back to the user's server-side cart
      const cart = await Cart.findOne({ userId }).lean();
      requested = (cart?.items || []).map((i) => ({
        productId: String(i.productId || ""),
        quantity: Number(i.quantity ?? 1),
      }));
    }

    if (requested.length === 0) {
      return res.status(400).json({ success: false, message: "Your cart is empty" });
    }
    if (requested.length > 100) {
      return res.status(400).json({ success: false, message: "Too many items in one order" });
    }

    const qtyByProduct = new Map();
    for (const { productId, quantity } of requested) {
      if (!mongoose.Types.ObjectId.isValid(productId)) {
        return res.status(400).json({ success: false, message: "Invalid product in cart" });
      }
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100) {
        return res.status(400).json({ success: false, message: "Invalid item quantity" });
      }
      qtyByProduct.set(productId, (qtyByProduct.get(productId) || 0) + quantity);
    }

    // ── 2. Load authoritative product data in ONE query ──
    const dbProducts = await Product.find({
      _id: { $in: [...qtyByProduct.keys()] },
      isActive: { $ne: false },
    }).lean();
    const productMap = new Map(dbProducts.map((p) => [String(p._id), p]));

    const orderItems = [];
    const stockErrors = [];
    for (const [productId, qty] of qtyByProduct) {
      const dbProduct = productMap.get(productId);
      if (!dbProduct) {
        return res.status(400).json({
          success: false,
          message: "Some items in your cart are no longer available. Please refresh your cart.",
        });
      }
      if (dbProduct.trackInventory) {
        if (dbProduct.stock <= 0) {
          stockErrors.push({ productId, name: dbProduct.name, error: "Out of stock" });
          continue;
        }
        if (dbProduct.stock < qty) {
          stockErrors.push({
            productId, name: dbProduct.name,
            error: `Only ${dbProduct.stock} available`,
            availableStock: dbProduct.stock, requestedQuantity: qty,
          });
          continue;
        }
      }
      orderItems.push({
        product: {
          _id: dbProduct._id,
          name: dbProduct.name,
          price: dbProduct.price,
          description: dbProduct.description,
          category: dbProduct.category,
          subCategory: dbProduct.subCategory,
        },
        quantity: qty,
        totalPrice: dbProduct.price * qty,
      });
    }

    if (stockErrors.length > 0) {
      return res.status(400).json({
        success: false,
        message: "Some items are out of stock or have insufficient quantity",
        stockErrors,
      });
    }

    // ── 3. Shipping address (defaults kept for backwards compatibility) ──
    const finalShippingAddress = shippingAddress
      ? {
          street: String(shippingAddress.street || "").trim() || "Address not provided",
          city: String(shippingAddress.city || "").trim() || "City not provided",
          state: String(shippingAddress.state || "").trim() || "State not provided",
          country:
            String(shippingAddress.country || "India")
              .replace(/\s*\(.*?\)\s*/g, "")
              .trim() || "India",
          zipCode: String(shippingAddress.zipCode || "000000").trim(),
          phone: String(shippingAddress.phone || "").trim(),
        }
      : {
          street: "Address not provided",
          city: "City not provided",
          state: "State not provided",
          country: "India",
          zipCode: "000000",
          phone: "",
        };

    // ── 4. Server-calculated totals ──
    const calculatedSubtotal = orderItems.reduce((sum, i) => sum + i.totalPrice, 0);
    const shippingCost = computeShipping(
      orderItems.map((i) => ({
        weightInGrams: productMap.get(String(i.product._id))?.weightInGrams,
        quantity: i.quantity,
      })),
      finalShippingAddress,
    );
    const finalTotalAmount = calculatedSubtotal + shippingCost;
    const amountInPaise = Math.round(finalTotalAmount * 100);

    if (!(amountInPaise > 0)) {
      return res.status(400).json({ success: false, message: "Invalid order amount" });
    }

    // Call Razorpay FIRST — don't save DB order until Razorpay succeeds
    let razorpayOrder;
    try {
      razorpayOrder = await getRazorpay().orders.create({
        amount: amountInPaise,
        currency: "INR",
        receipt: `rcpt_${Date.now()}`,
        payment_capture: 1,
      });
    } catch (rzpErr) {
      console.error("[Payment] Razorpay error:", rzpErr?.error || rzpErr?.message);
      return res.status(502).json({
        message: "Payment gateway error. Please try again.",
        detail: rzpErr?.error?.description || "Payment gateway unavailable",
      });
    }

    // Razorpay succeeded — now persist the order
    const order = new Order({
      userId,
      items: orderItems,
      subtotal: calculatedSubtotal,
      shipping: shippingCost,
      discount: { couponCode: null, amount: 0 },
      totalAmount: finalTotalAmount,
      currency: "INR",
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
        amount: finalTotalAmount,
        amountInPaise,
        shipping: shippingCost,
        currency: "INR",
      },
      razorpayKeyId: process.env.RAZORPAY_KEY_ID,
    });
  } catch (error) {
    console.error("Error creating order:", error);
    res.status(500).json({ message: "Failed to create order" });
  }
});

// ── Payment confirmation (shared by /verify-payment and the Razorpay webhook) ──

const safeEqualHex = (a, b) => {
  const x = Buffer.from(String(a || ""), "utf8");
  const y = Buffer.from(String(b || ""), "utf8");
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

class PaymentError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Notification, email, WhatsApp, SSE and cart clearing — never blocks the response.
function runPostPaymentActions(confirmedOrder) {
  setImmediate(async () => {
    try {
      await Cart.findOneAndDelete({ userId: confirmedOrder.userId });

      await Notification.create({
        type: "order",
        message: `New order received: #${confirmedOrder._id.toString().slice(-6).toUpperCase()}`,
        orderId: confirmedOrder._id,
        read: false,
        meta: { userId: confirmedOrder.userId, totalAmount: confirmedOrder.totalAmount },
      });

      const user = await User.findById(confirmedOrder.userId).lean();
      if (user?.email) {
        enqueueEmail(() => sendConfirmationEmail(user, confirmedOrder));
      }

      notifyAdminNewOrder(confirmedOrder, user).catch((e) =>
        console.error("[WhatsApp] Admin notification error:", e.message),
      );

      const { pushOrderUpdate } = require("../routes/sse");
      pushOrderUpdate(confirmedOrder.userId.toString(), confirmedOrder);
    } catch (postErr) {
      console.error("[Payment] Post-payment action failed:", postErr.message);
      Notification.create({
        type: "system",
        message: `⚠️ Post-payment action failed for order ${confirmedOrder._id}: ${postErr.message}`,
        orderId: confirmedOrder._id,
        read: false,
      }).catch(() => {});
    }
  });
}

/**
 * Marks an order paid. The caller must already have authenticated the payment
 * (checkout signature, or webhook signature).
 *
 * Guards:
 *  - the Razorpay order id must be the one WE created for this order
 *  - (checkout flow) the order must belong to the caller
 *  - the amount Razorpay actually captured must equal the order total
 *  - atomic "claim": only one concurrent caller can flip paymentStatus to
 *    completed, so stock is deducted exactly once
 *
 * @returns {{ order, alreadyConfirmed: boolean }}
 */
async function confirmOrderPayment({
  orderId, userId, razorpayOrderId, razorpayPaymentId, razorpaySignature = null, paymentEntity = null,
}) {
  const query = { razorpayOrderId };
  if (orderId) {
    if (!mongoose.Types.ObjectId.isValid(orderId)) throw new PaymentError(404, "Order not found");
    query._id = orderId;
  }
  if (userId) query.userId = userId;

  const existing = await Order.findOne(query);
  if (!existing) throw new PaymentError(404, "Order not found");

  if (existing.paymentStatus === "completed") {
    return { order: existing, alreadyConfirmed: true };
  }

  // Ask Razorpay what was really paid (unless the webhook already gave us the entity)
  let payment = paymentEntity;
  if (!payment) {
    try {
      payment = await getRazorpay().payments.fetch(razorpayPaymentId);
    } catch (err) {
      console.error("[Payment] Could not fetch payment from Razorpay:", err?.error?.description || err.message);
      throw new PaymentError(502, "Could not verify payment with the gateway. Please retry in a moment.");
    }
  }
  if (
    payment.id !== razorpayPaymentId ||
    payment.order_id !== razorpayOrderId ||
    !["captured", "authorized"].includes(payment.status) ||
    Number(payment.amount) !== Math.round(existing.totalAmount * 100)
  ) {
    console.error("[Payment] Payment/order mismatch", {
      order: String(existing._id), paymentId: razorpayPaymentId,
      expectedPaise: Math.round(existing.totalAmount * 100), gotPaise: payment.amount, status: payment.status,
    });
    throw new PaymentError(400, "Payment details do not match this order");
  }

  const session = await mongoose.startSession();
  try {
    let confirmedOrder = null;
    await session.withTransaction(async () => {
      // Atomic claim — fails (null) if another request/webhook confirmed it first
      confirmedOrder = await Order.findOneAndUpdate(
        { _id: existing._id, paymentStatus: { $ne: "completed" } },
        {
          $set: {
            status: "confirmed",
            paymentStatus: "completed",
            razorpayPaymentId,
            ...(razorpaySignature ? { razorpaySignature } : {}),
            updatedAt: new Date(),
          },
          $push: {
            timeline: {
              status: "confirmed",
              title: "Payment Confirmed",
              description: `Payment of ₹${existing.totalAmount} received via Razorpay`,
              timestamp: new Date(),
              metadata: { razorpayPaymentId },
            },
          },
        },
        { new: true, session },
      );
      if (!confirmedOrder) return; // lost the race — nothing else to do

      for (const item of confirmedOrder.items) {
        const pid = item.product?._id;
        if (!pid) continue;
        const updated = await Product.findOneAndUpdate(
          { _id: pid, $or: [{ trackInventory: false }, { stock: { $gte: item.quantity } }] },
          [
            {
              $set: {
                stock: {
                  $cond: ["$trackInventory", { $max: [0, { $subtract: ["$stock", item.quantity] }] }, "$stock"],
                },
              },
            },
          ],
          { session, new: true },
        );
        if (!updated) {
          // Customer has already paid, so don't fail the order — flag it for the admin instead.
          console.warn(`[Payment] Oversold: insufficient stock for ${item.product.name} on order ${confirmedOrder._id}`);
        }
      }
    });

    if (!confirmedOrder) {
      const fresh = await Order.findById(existing._id);
      return { order: fresh, alreadyConfirmed: true };
    }
    runPostPaymentActions(confirmedOrder);
    return { order: confirmedOrder, alreadyConfirmed: false };
  } finally {
    session.endSession();
  }
}

// Verify payment — called by the browser after Razorpay checkout succeeds
router.post("/verify-payment", protect, strictLimiter, async (req, res) => {
  try {
    const { razorpayOrderId, razorpayPaymentId, razorpaySignature, orderId } = req.body;

    if (
      typeof razorpayOrderId !== "string" ||
      typeof razorpayPaymentId !== "string" ||
      typeof razorpaySignature !== "string"
    ) {
      return res.status(400).json({ success: false, message: "Missing payment verification details" });
    }

    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpayOrderId}|${razorpayPaymentId}`)
      .digest("hex");

    if (!safeEqualHex(expectedSignature, razorpaySignature)) {
      // Never echo the expected signature back, and never mutate an order on a bad signature.
      console.warn("[Payment] Signature mismatch", { orderId, user: String(req.user._id) });
      return res.status(400).json({ success: false, message: "Payment verification failed" });
    }

    const { order, alreadyConfirmed } = await confirmOrderPayment({
      orderId,
      userId: req.user._id,
      razorpayOrderId,
      razorpayPaymentId,
      razorpaySignature,
    });

    res.json({
      success: true,
      message: alreadyConfirmed ? "Payment already verified" : "Payment verified successfully",
      order,
    });
  } catch (error) {
    if (error instanceof PaymentError) {
      return res.status(error.status).json({ success: false, message: error.message });
    }
    console.error("Error verifying payment:", error);
    res.status(500).json({
      success: false,
      message: "Payment confirmation failed. Please contact support.",
    });
  }
});

// Razorpay webhook — confirms orders even if the customer closed the tab after paying.
// Configure in Razorpay Dashboard → Webhooks: URL /api/payment/webhook,
// event "payment.captured", secret = RAZORPAY_WEBHOOK_SECRET.
router.post("/webhook", async (req, res) => {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) {
    console.warn("[Webhook] RAZORPAY_WEBHOOK_SECRET not set — ignoring webhook");
    return res.status(503).json({ success: false, message: "Webhook not configured" });
  }

  const signature = req.headers["x-razorpay-signature"];
  if (!req.rawBody || !signature) {
    return res.status(400).json({ success: false, message: "Invalid webhook" });
  }
  const expected = crypto.createHmac("sha256", secret).update(req.rawBody).digest("hex");
  if (!safeEqualHex(expected, signature)) {
    return res.status(400).json({ success: false, message: "Invalid signature" });
  }

  try {
    const entity = req.body?.payload?.payment?.entity;
    if (req.body?.event === "payment.captured" && entity?.order_id && entity?.id) {
      try {
        await confirmOrderPayment({
          razorpayOrderId: entity.order_id,
          razorpayPaymentId: entity.id,
          paymentEntity: entity,
        });
      } catch (err) {
        // Unknown order / mismatch: acknowledge so Razorpay doesn't retry forever
        if (err instanceof PaymentError && err.status < 500) {
          console.warn("[Webhook] Not applied:", err.message);
        } else {
          throw err;
        }
      }
    }
    res.json({ success: true });
  } catch (err) {
    console.error("[Webhook] Processing error:", err.message);
    res.status(500).json({ success: false }); // non-2xx → Razorpay retries
  }
});

// Get order details
router.get("/order/:orderId", protect, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.orderId)) {
      return res.status(400).json({ success: false, message: "Invalid order ID" });
    }
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

// Handle payment failure — only the order's owner can cancel it, and only while
// it is still unpaid (a confirmed/paid order can never be cancelled from here).
router.post("/payment-failed", protect, async (req, res) => {
  try {
    const { orderId } = req.body;
    if (!mongoose.Types.ObjectId.isValid(orderId)) {
      return res.status(400).json({ success: false, message: "Invalid order ID" });
    }

    await Order.updateOne(
      { _id: orderId, userId: req.user._id, status: "pending", paymentStatus: { $ne: "completed" } },
      { $set: { status: "cancelled", updatedAt: new Date() } },
    );

    res.json({ success: true, message: "Payment failure recorded" });
  } catch (error) {
    console.error("Error handling payment failure:", error);
    res.status(500).json({ message: "Failed to handle payment failure" });
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
