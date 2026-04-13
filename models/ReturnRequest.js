const mongoose = require("mongoose");

const ReturnRequestSchema = new mongoose.Schema(
  {
    orderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order",
      required: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    items: [
      {
        productId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Product",
        },
        productName: String,
        quantity: Number,
        reason: String,
      },
    ],
    returnType: {
      type: String,
      enum: ["return", "exchange", "refund"],
      default: "return",
    },
    reason: {
      type: String,
      required: true,
      enum: [
        "defective",
        "wrong_item",
        "not_as_described",
        "size_mismatch",
        "quality_issue",
        "changed_mind",
        "duplicate_order",
        "other",
      ],
    },
    reasonDetails: String,
    images: [
      {
        url: String,
        publicId: String,
        uploadedAt: Date,
      },
    ],
    status: {
      type: String,
      enum: [
        "requested",
        "approved",
        "rejected",
        "in_transit",
        "received",
        "refunded",
        "completed",
      ],
      default: "requested",
    },
    refundAmount: Number,
    refundMethod: {
      type: String,
      enum: ["original_payment", "wallet", "credit"],
      default: "original_payment",
    },
    returnAddress: {
      street: String,
      city: String,
      state: String,
      zipCode: String,
      country: String,
      phone: String,
    },
    pickupScheduled: Date,
    trackingNumber: String,
    adminNotes: String,
    createdAt: {
      type: Date,
      default: Date.now,
    },
    updatedAt: {
      type: Date,
      default: Date.now,
    },
    completedAt: Date,
  },
  { timestamps: true },
);

// Indexes
ReturnRequestSchema.index({ orderId: 1, userId: 1 });
ReturnRequestSchema.index({ status: 1, createdAt: -1 });
ReturnRequestSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model("ReturnRequest", ReturnRequestSchema);
