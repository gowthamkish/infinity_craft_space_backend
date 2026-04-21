const mongoose = require("mongoose");

const StockAlertSchema = new mongoose.Schema(
  {
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: true,
    },
    email: { type: String, required: true },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    notifiedAt: { type: Date, default: null },
    createdAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

// One alert per email per product
StockAlertSchema.index({ productId: 1, email: 1 }, { unique: true });
// For efficient restocked-product queries
StockAlertSchema.index({ productId: 1, notifiedAt: 1 });

module.exports = mongoose.model("StockAlert", StockAlertSchema);
