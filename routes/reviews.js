const router = require("express").Router();
const mongoose = require("mongoose");
const Review = require("../models/Review");
const Order = require("../models/Order");
const { protect, isAdmin } = require("../middlewares/authMiddleware");
const { uploadBase64Image, deleteImage } = require("../config/cloudinary");
const { runReviewModerationAgent } = require("../controllers/reviewAgentController");

// Get all reviews for a product (public)
router.get("/product/:productId", async (req, res) => {
  try {
    const { productId } = req.params;
    const { page = 1, limit = 10, sortBy = "newest" } = req.query;

    // Determine sort order
    let sortOptions = {};
    switch (sortBy) {
      case "newest":
        sortOptions = { createdAt: -1 };
        break;
      case "oldest":
        sortOptions = { createdAt: 1 };
        break;
      case "highest":
        sortOptions = { rating: -1, createdAt: -1 };
        break;
      case "lowest":
        sortOptions = { rating: 1, createdAt: -1 };
        break;
      case "helpful":
        sortOptions = { helpfulVotes: -1, createdAt: -1 };
        break;
      default:
        sortOptions = { createdAt: -1 };
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const reviews = await Review.find({
      product: productId,
      status: "approved",
    })
      .populate("user", "username email")
      .sort(sortOptions)
      .skip(skip)
      .limit(parseInt(limit));

    const totalReviews = await Review.countDocuments({
      product: productId,
      status: "approved",
    });

    // Calculate rating statistics
    const ratingStats = await Review.calculateAverageRating(
      new mongoose.Types.ObjectId(productId),
    );

    res.json({
      success: true,
      reviews,
      pagination: {
        currentPage: parseInt(page),
        totalPages: Math.ceil(totalReviews / parseInt(limit)),
        totalReviews,
        hasMore: skip + reviews.length < totalReviews,
      },
      ratingStats,
    });
  } catch (err) {
    console.error("Error fetching reviews:", err);
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

// Get rating summary for a product (for product cards)
router.get("/product/:productId/summary", async (req, res) => {
  try {
    const { productId } = req.params;

    const ratingStats = await Review.calculateAverageRating(
      new mongoose.Types.ObjectId(productId),
    );

    res.json({
      success: true,
      ...ratingStats,
    });
  } catch (err) {
    console.error("Error fetching rating summary:", err);
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

// Check if user can review a product (must have purchased)
router.get("/can-review/:productId", protect, async (req, res) => {
  try {
    const { productId } = req.params;
    const userId = req.user._id;

    // Check if user already reviewed this product
    const existingReview = await Review.findOne({
      product: productId,
      user: userId,
    });

    if (existingReview) {
      return res.json({
        success: true,
        canReview: false,
        reason: "already_reviewed",
        existingReview,
      });
    }

    // Check if user has purchased this product
    const hasPurchased = await Order.findOne({
      userId: userId,
      "items.product._id": productId,
      status: { $in: ["delivered", "confirmed", "shipped"] },
    });

    res.json({
      success: true,
      canReview: true,
      isVerifiedPurchase: !!hasPurchased,
    });
  } catch (err) {
    console.error("Error checking review eligibility:", err);
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

// Create a new review (authenticated)
router.post("/", protect, async (req, res) => {
  try {
    const { productId, rating, title, comment, images } = req.body;
    const userId = req.user._id;

    // Validate required fields
    if (!productId || !rating || !title || !comment) {
      return res.status(400).json({
        success: false,
        error: "Product ID, rating, title, and comment are required",
      });
    }

    // Check if user already reviewed this product
    const existingReview = await Review.findOne({
      product: productId,
      user: userId,
    });

    if (existingReview) {
      return res.status(400).json({
        success: false,
        error: "You have already reviewed this product",
      });
    }

    // Check if user has purchased this product
    const hasPurchased = await Order.findOne({
      userId: userId,
      "items.product._id": productId,
      status: { $in: ["delivered", "confirmed", "shipped"] },
    });

    // Upload images to Cloudinary if provided
    let uploadedImages = [];
    if (images && images.length > 0) {
      const maxImages = 5; // Limit to 5 images per review
      const imagesToUpload = images.slice(0, maxImages);

      for (const imageData of imagesToUpload) {
        try {
          const result = await uploadBase64Image(imageData.base64, "reviews");
          uploadedImages.push({
            url: result.secure_url,
            publicId: result.public_id,
            originalName: imageData.name || "review-image",
          });
        } catch (uploadError) {
          console.error("Error uploading review image:", uploadError);
          // Continue with other images even if one fails
        }
      }
    }

    const review = new Review({
      product: productId,
      user: userId,
      rating: parseInt(rating),
      title: title.trim(),
      comment: comment.trim(),
      images: uploadedImages,
      isVerifiedPurchase: !!hasPurchased,
    });

    await review.save();

    // Fire-and-forget: run AI moderation agent asynchronously
    runReviewModerationAgent(review).catch((e) =>
      console.error("[ReviewAgent] Unhandled error:", e.message)
    );

    // Populate user info before returning
    await review.populate("user", "username email");

    res.status(201).json({
      success: true,
      message: "Review submitted successfully. It will be visible once approved.",
      review,
    });
  } catch (err) {
    console.error("Error creating review:", err);

    // Handle duplicate key error
    if (err.code === 11000) {
      return res.status(400).json({
        success: false,
        error: "You have already reviewed this product",
      });
    }

    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

// Update a review (only by the review author)
router.put("/:reviewId", protect, async (req, res) => {
  try {
    const { reviewId } = req.params;
    const { rating, title, comment, images, imagesToDelete } = req.body;
    const userId = req.user._id;

    const review = await Review.findById(reviewId);

    if (!review) {
      return res.status(404).json({
        success: false,
        error: "Review not found",
      });
    }

    // Check if user is the author
    if (review.user.toString() !== userId.toString()) {
      return res.status(403).json({
        success: false,
        error: "You can only edit your own reviews",
      });
    }

    // Delete specified images from Cloudinary
    if (imagesToDelete && imagesToDelete.length > 0) {
      for (const publicId of imagesToDelete) {
        try {
          await deleteImage(publicId);
        } catch (deleteError) {
          console.error("Error deleting image:", deleteError);
        }
      }
      // Remove deleted images from review
      review.images = review.images.filter(
        (img) => !imagesToDelete.includes(img.publicId),
      );
    }

    // Upload new images if provided
    if (images && images.length > 0) {
      const currentImageCount = review.images.length;
      const maxNewImages = 5 - currentImageCount;
      const imagesToUpload = images.slice(0, maxNewImages);

      for (const imageData of imagesToUpload) {
        try {
          const result = await uploadBase64Image(imageData.base64, "reviews");
          review.images.push({
            url: result.secure_url,
            publicId: result.public_id,
            originalName: imageData.name || "review-image",
          });
        } catch (uploadError) {
          console.error("Error uploading review image:", uploadError);
        }
      }
    }

    // Update review fields
    if (rating) review.rating = parseInt(rating);
    if (title) review.title = title.trim();
    if (comment) review.comment = comment.trim();

    await review.save();
    await review.populate("user", "username email");

    res.json({
      success: true,
      message: "Review updated successfully",
      review,
    });
  } catch (err) {
    console.error("Error updating review:", err);
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

// Delete a review (by author or admin)
router.delete("/:reviewId", protect, async (req, res) => {
  try {
    const { reviewId } = req.params;
    const userId = req.user._id;
    const isUserAdmin = req.user.isAdmin;

    const review = await Review.findById(reviewId);

    if (!review) {
      return res.status(404).json({
        success: false,
        error: "Review not found",
      });
    }

    // Check if user is the author or admin
    if (review.user.toString() !== userId.toString() && !isUserAdmin) {
      return res.status(403).json({
        success: false,
        error: "You can only delete your own reviews",
      });
    }

    // Delete images from Cloudinary
    if (review.images && review.images.length > 0) {
      for (const image of review.images) {
        try {
          await deleteImage(image.publicId);
        } catch (deleteError) {
          console.error("Error deleting image:", deleteError);
        }
      }
    }

    await Review.findByIdAndDelete(reviewId);

    res.json({
      success: true,
      message: "Review deleted successfully",
    });
  } catch (err) {
    console.error("Error deleting review:", err);
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

// Mark a review as helpful (authenticated)
router.post("/:reviewId/helpful", protect, async (req, res) => {
  try {
    const { reviewId } = req.params;
    const userId = req.user._id;

    const review = await Review.findById(reviewId);

    if (!review) {
      return res.status(404).json({
        success: false,
        error: "Review not found",
      });
    }

    // Check if user already voted
    const hasVoted = review.helpfulVoters.includes(userId);

    if (hasVoted) {
      // Remove vote
      review.helpfulVoters = review.helpfulVoters.filter(
        (id) => id.toString() !== userId.toString(),
      );
      review.helpfulVotes = Math.max(0, review.helpfulVotes - 1);
    } else {
      // Add vote
      review.helpfulVoters.push(userId);
      review.helpfulVotes += 1;
    }

    await review.save();

    res.json({
      success: true,
      helpfulVotes: review.helpfulVotes,
      hasVoted: !hasVoted,
    });
  } catch (err) {
    console.error("Error marking review as helpful:", err);
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

// Admin: Add response to a review
router.post("/:reviewId/respond", protect, isAdmin, async (req, res) => {
  try {
    const { reviewId } = req.params;
    const { comment } = req.body;
    const adminId = req.user._id;

    if (!comment) {
      return res.status(400).json({
        success: false,
        error: "Response comment is required",
      });
    }

    const review = await Review.findById(reviewId);

    if (!review) {
      return res.status(404).json({
        success: false,
        error: "Review not found",
      });
    }

    review.adminResponse = {
      comment: comment.trim(),
      respondedAt: new Date(),
      respondedBy: adminId,
    };

    await review.save();
    await review.populate("user", "username email");
    await review.populate("adminResponse.respondedBy", "username");

    res.json({
      success: true,
      message: "Response added successfully",
      review,
    });
  } catch (err) {
    console.error("Error adding admin response:", err);
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

// ── Admin: Moderation queue ───────────────────────────────────────────────────

// GET /reviews/admin/queue — reviews pending moderation + reviews with draft responses
router.get("/admin/queue", protect, isAdmin, async (req, res) => {
  try {
    const { tab = "pending", page = 1, limit = 20 } = req.query;
    const safeLimit = Math.min(50, Math.max(1, parseInt(limit, 10) || 20));
    const safePage  = Math.max(1, parseInt(page, 10) || 1);

    let filter = {};
    if (tab === "pending")  filter = { status: "pending" };
    if (tab === "drafts")   filter = { "aiDraftResponse.status": "pending", status: "approved" };
    if (tab === "flagged")  filter = { "aiModeration.verdict": { $in: ["suspicious", "spam"] } };
    if (tab === "insights") filter = { productInsight: { $exists: true, $ne: null } };

    const [reviews, total] = await Promise.all([
      Review.find(filter)
        .populate("product", "name images")
        .populate("user", "username email")
        .sort({ createdAt: -1 })
        .skip((safePage - 1) * safeLimit)
        .limit(safeLimit)
        .lean(),
      Review.countDocuments(filter),
    ]);

    res.json({
      success: true,
      reviews,
      pagination: { page: safePage, limit: safeLimit, total, pages: Math.ceil(total / safeLimit) },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /reviews/:reviewId/moderate — admin manually approve or reject a review
router.put("/:reviewId/moderate", protect, isAdmin, async (req, res) => {
  try {
    const { action } = req.body; // "approve" | "reject"
    if (!["approve", "reject"].includes(action)) {
      return res.status(400).json({ success: false, error: "action must be 'approve' or 'reject'" });
    }

    const review = await Review.findByIdAndUpdate(
      req.params.reviewId,
      { status: action === "approve" ? "approved" : "rejected" },
      { new: true }
    ).populate("user", "username email").populate("product", "name");

    if (!review) return res.status(404).json({ success: false, error: "Review not found" });

    res.json({ success: true, review });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /reviews/:reviewId/approve-draft — admin approves the AI-drafted response and posts it live
router.post("/:reviewId/approve-draft", protect, isAdmin, async (req, res) => {
  try {
    const { editedComment } = req.body; // optional: admin can edit before approving

    const review = await Review.findById(req.params.reviewId);
    if (!review) return res.status(404).json({ success: false, error: "Review not found" });
    if (!review.aiDraftResponse?.comment) {
      return res.status(400).json({ success: false, error: "No AI draft response found" });
    }
    if (review.aiDraftResponse.status !== "pending") {
      return res.status(400).json({ success: false, error: "Draft has already been actioned" });
    }

    const finalComment = editedComment?.trim() || review.aiDraftResponse.comment;

    review.adminResponse = {
      comment:       finalComment,
      respondedAt:   new Date(),
      respondedBy:   req.user._id,
    };
    review.aiDraftResponse.status     = "approved";
    review.aiDraftResponse.approvedAt = new Date();
    review.aiDraftResponse.approvedBy = req.user._id;

    await review.save();
    await review.populate("user", "username email");
    await review.populate("adminResponse.respondedBy", "username");

    res.json({ success: true, message: "Draft approved and posted", review });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /reviews/:reviewId/dismiss-draft — admin dismisses the AI draft without posting
router.post("/:reviewId/dismiss-draft", protect, isAdmin, async (req, res) => {
  try {
    const review = await Review.findByIdAndUpdate(
      req.params.reviewId,
      { "aiDraftResponse.status": "dismissed" },
      { new: true }
    );
    if (!review) return res.status(404).json({ success: false, error: "Review not found" });
    res.json({ success: true, message: "Draft dismissed" });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── User: Get own reviews ─────────────────────────────────────────────────────

// Get user's reviews (authenticated)
router.get("/my-reviews", protect, async (req, res) => {
  try {
    const userId = req.user._id;
    const { page = 1, limit = 10 } = req.query;

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const reviews = await Review.find({ user: userId })
      .populate("product", "name price images image")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    const totalReviews = await Review.countDocuments({ user: userId });

    res.json({
      success: true,
      reviews,
      pagination: {
        currentPage: parseInt(page),
        totalPages: Math.ceil(totalReviews / parseInt(limit)),
        totalReviews,
        hasMore: skip + reviews.length < totalReviews,
      },
    });
  } catch (err) {
    console.error("Error fetching user reviews:", err);
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

module.exports = router;
