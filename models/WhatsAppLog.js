const mongoose = require("mongoose");

const whatsAppLogSchema = new mongoose.Schema(
  {
    // Who received it
    to: { type: String, required: true },           // E.164 phone number
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: "Order" },

    // What was sent
    templateName: { type: String, required: true },
    variables: { type: [String], default: [] },

    // Delivery status
    status: {
      type: String,
      enum: ["pending", "sent", "failed", "skipped"],
      default: "pending",
    },
    messageId: { type: String },          // WhatsApp message ID on success
    error: { type: String },              // Error message on failure

    // Retry tracking
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 3 },
    nextRetryAt: { type: Date },

    // Context
    eventType: {
      type: String,
      enum: [
        "order_placed_admin",
        "order_confirmed",
        "order_processing",
        "order_shipped",
        "order_out_for_delivery",
        "order_delivered",
        "order_cancelled",
      ],
    },
  },
  { timestamps: true },
);

whatsAppLogSchema.index({ status: 1, nextRetryAt: 1 });
whatsAppLogSchema.index({ orderId: 1 });

module.exports = mongoose.model("WhatsAppLog", whatsAppLogSchema);
