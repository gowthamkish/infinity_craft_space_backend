const mongoose = require("mongoose");

const AbandonedCartSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    userEmail: {
      type: String,
      required: true,
    },
    items: [
      {
        product: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Product",
          required: true,
        },
        productName: String,
        quantity: {
          type: Number,
          required: true,
        },
        price: Number,
        variant: {
          color: String,
          size: String,
          material: String,
          quantity: Number,
        },
      },
    ],
    cartTotal: Number,
    reminderSent: {
      type: Boolean,
      default: false,
    },
    remindersCount: {
      type: Number,
      default: 0,
    },
    lastReminderAt: Date,
    recoveryLink: {
      token: String,
      expiresAt: Date,
    },
    abandoned: {
      type: Boolean,
      default: true,
    },
    recoveredAt: Date,
    createdAt: {
      type: Date,
      default: Date.now,
    },
    updatedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true },
);

// Index for finding abandoned carts to remind
AbandonedCartSchema.index({ abandoned: 1, reminderSent: 1, createdAt: 1 });
AbandonedCartSchema.index({ user: 1, createdAt: -1 });

module.exports = mongoose.model("AbandonedCart", AbandonedCartSchema);
