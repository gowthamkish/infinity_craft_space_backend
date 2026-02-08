const mongoose = require("mongoose");

const ReviewSchema = new mongoose.Schema({
  product: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Product",
    required: true,
  },
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  rating: {
    type: Number,
    required: true,
    min: 1,
    max: 5,
  },
  title: {
    type: String,
    required: true,
    maxLength: 100,
    trim: true,
  },
  comment: {
    type: String,
    required: true,
    maxLength: 1000,
    trim: true,
  },
  // Customer photos of product in use (e.g., jewelry worn)
  images: [
    {
      url: { type: String },
      publicId: { type: String },
      originalName: { type: String },
      uploadedAt: { type: Date, default: Date.now },
    },
  ],
  // Helpful votes from other users
  helpfulVotes: {
    type: Number,
    default: 0,
  },
  helpfulVoters: [
    {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
  ],
  // Verified purchase flag
  isVerifiedPurchase: {
    type: Boolean,
    default: false,
  },
  // Admin response to review
  adminResponse: {
    comment: { type: String },
    respondedAt: { type: Date },
    respondedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  // Review status for moderation
  status: {
    type: String,
    enum: ["pending", "approved", "rejected"],
    default: "approved", // Auto-approve for now, can add moderation later
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

// Index for efficient queries
ReviewSchema.index({ product: 1, createdAt: -1 });
ReviewSchema.index({ user: 1, product: 1 }, { unique: true }); // One review per user per product

// Static method to calculate average rating for a product
ReviewSchema.statics.calculateAverageRating = async function (productId) {
  const result = await this.aggregate([
    { $match: { product: productId, status: "approved" } },
    {
      $group: {
        _id: "$product",
        averageRating: { $avg: "$rating" },
        reviewCount: { $sum: 1 },
        ratingDistribution: {
          $push: "$rating",
        },
      },
    },
  ]);

  if (result.length > 0) {
    const { averageRating, reviewCount, ratingDistribution } = result[0];

    // Calculate rating breakdown (1-5 stars)
    const ratingBreakdown = {
      5: ratingDistribution.filter((r) => r === 5).length,
      4: ratingDistribution.filter((r) => r === 4).length,
      3: ratingDistribution.filter((r) => r === 3).length,
      2: ratingDistribution.filter((r) => r === 2).length,
      1: ratingDistribution.filter((r) => r === 1).length,
    };

    return {
      averageRating: Math.round(averageRating * 10) / 10, // Round to 1 decimal
      reviewCount,
      ratingBreakdown,
    };
  }

  return {
    averageRating: 0,
    reviewCount: 0,
    ratingBreakdown: { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 },
  };
};

// Update timestamp on save
ReviewSchema.pre("save", function (next) {
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.model("Review", ReviewSchema);
