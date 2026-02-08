const router = require("express").Router();
const mongoose = require("mongoose");
const Review = require("../models/Review");
const Order = require("../models/Order");
const { protect, isAdmin } = require("../middlewares/authMiddleware");
const { uploadBase64Image, deleteImage } = require("../config/cloudinary");

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

    // Populate user info before returning
    await review.populate("user", "username email");

    res.status(201).json({
      success: true,
      message: "Review submitted successfully",
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
