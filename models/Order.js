const mongoose = require("mongoose");

const TimelineEventSchema = new mongoose.Schema(
  {
    status: String,
    title: String,
    description: String,
    timestamp: {
      type: Date,
      default: Date.now,
    },
    metadata: mongoose.Schema.Types.Mixed, // Additional info like tracking number
  },
  { _id: true },
);

const OrderSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    items: [
      {
        product: {
          _id: { type: mongoose.Schema.Types.ObjectId, ref: "Product" },
          name: { type: String, required: true },
          price: { type: Number, required: true },
          description: { type: String, required: false },
          category: { type: String, required: true },
          subCategory: { type: String, required: true },
        },
        quantity: { type: Number, required: true },
        totalPrice: { type: Number, required: true },
        variant: {
          color: String,
          size: String,
          material: String,
          variantId: String,
        },
      },
    ],
    subtotal: { type: Number, required: true },
    discount: {
      code: String,
      type: {
        type: String,
        enum: ["percentage", "fixed"],
      },
      amount: {
        type: Number,
        default: 0,
      },
    },
    tax: {
      type: Number,
      default: 0,
    },
    shipping: {
      type: Number,
      default: 0,
    },
    totalAmount: { type: Number, required: true },
    currency: { type: String, default: "INR" },
    status: {
      type: String,
      enum: [
        "pending",
        "confirmed",
        "processing",
        "cancelled",
        "shipped",
        "out_for_delivery",
        "delivered",
        "returned",
      ],
      default: "pending",
    },

    // Payment details
    razorpayOrderId: { type: String },
    razorpayPaymentId: { type: String },
    razorpaySignature: { type: String },
    paymentStatus: {
      type: String,
      enum: ["pending", "completed", "failed", "refunded"],
      default: "pending",
    },

    // Shipping details
    shippingAddress: {
      street: { type: String, required: true },
      city: { type: String, required: true },
      country: { type: String, required: true },
      state: { type: String, required: true },
      zipCode: { type: String, required: true },
      phone: { type: String, default: "" },
    },
    shippingCourierId: { type: String, default: null }, // Selected courier ID from Shiprocket rates
    trackingNumber: String,
    estimatedDelivery: Date,
    paymentMethod: {
      type: String,
      enum: ["prepaid", "cod"],
      default: "prepaid",
    },

    // Shiprocket integration
    shiprocket: {
      shiprocketOrderId: { type: String },
      shipmentId: { type: String },
      awbCode: { type: String },
      courierId: { type: String },
      courierName: { type: String },
      trackingUrl: { type: String },
      currentStatus: { type: String },
      returnOrderId: { type: String },
      lastSyncAt: { type: Date },
    },

    // Order timeline
    timeline: [TimelineEventSchema],

    // Return/refund
    hasReturnRequest: {
      type: Boolean,
      default: false,
    },
    returnRequestId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ReturnRequest",
    },

    // Email notifications
    emailsSent: {
      orderConfirmation: { type: Boolean, default: false },
      shippingUpdate: { type: Boolean, default: false },
      deliveryConfirmation: { type: Boolean, default: false },
    },

    deliveredAt: { type: Date, default: null },

    // Set when an ADMIN changes the status; cleared once the customer has seen it (modal/toast on login).
    // previousStatus is the status the customer last knew about, so several offline changes collapse to one.
    statusNotice: {
      status: { type: String },
      previousStatus: { type: String },
      at: { type: Date },
    },

    notes: String,
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

// Indexes
OrderSchema.index({ userId: 1, createdAt: -1 });
OrderSchema.index({ userId: 1, status: 1 });
OrderSchema.index({ status: 1, createdAt: -1 });
OrderSchema.index({ paymentStatus: 1, createdAt: -1 });
OrderSchema.index({ razorpayOrderId: 1 });
// One Razorpay payment can only ever confirm one order
OrderSchema.index(
  { razorpayPaymentId: 1 },
  { unique: true, partialFilterExpression: { razorpayPaymentId: { $type: "string" } } },
);
OrderSchema.index({ "shiprocket.awbCode": 1 });
OrderSchema.index({ "shiprocket.shipmentId": 1 });
OrderSchema.index({ createdAt: -1 }); // Admin date-range scans
OrderSchema.index({ userId: 1, "statusNotice.status": 1 }, { sparse: true }); // unseen status changes per customer

module.exports = mongoose.model("Order", OrderSchema);
