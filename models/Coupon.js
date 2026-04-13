const mongoose = require("mongoose");

const CouponSchema = new mongoose.Schema({
  code: {
    type: String,
    required: true,
    unique: true,
    uppercase: true,
    trim: true,
  },
  description: String,
  discountType: {
    type: String,
    enum: ["percentage", "fixed"],
    required: true,
  },
  discountValue: {
    type: Number,
    required: true,
    min: 0,
  },
  maxDiscount: Number, // Max discount for percentage-based coupons
  minCartValue: {
    type: Number,
    default: 0,
  },
  maxUses: Number, // Total number of times coupon can be used
  useCount: {
    type: Number,
    default: 0,
  },
  maxUsesPerUser: {
    type: Number,
    default: 1,
  },
  validFrom: {
    type: Date,
    default: Date.now,
  },
  validUntil: Date,
  isActive: {
    type: Boolean,
    default: true,
  },
  applicableCategories: [String], // Empty array = applies to all
  applicableProducts: [
    {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
    },
  ],
  usedBy: [
    {
      userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
      },
      usedCount: {
        type: Number,
        default: 0,
      },
      lastUsedAt: Date,
    },
  ],
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
});

// Index for quick lookups
CouponSchema.index({ code: 1 });
CouponSchema.index({ isActive: 1, validUntil: 1 });

module.exports = mongoose.model("Coupon", CouponSchema);
