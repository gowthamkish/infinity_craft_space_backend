const express = require("express");
const router = express.Router();
const { protect, isAdmin, optionalAuth } = require("../middlewares/authMiddleware");
const { evaluateCoupon, CouponError } = require("../utils/coupons");
const Coupon = require("../models/Coupon");
const Order = require("../models/Order");
const { body, validationResult } = require("express-validator");

// Get all coupons (admin only)
router.get("/", protect, isAdmin, async (req, res) => {
  try {
    const { page = 1, limit = 10, active } = req.query;
    const query = {};

    if (active !== undefined) {
      query.isActive = active === "true";
    }

    const coupons = await Coupon.find(query)
      .limit(limit * 1)
      .skip((page - 1) * limit)
      .sort({ createdAt: -1 });

    const total = await Coupon.countDocuments(query);

    res.status(200).json({
      success: true,
      data: coupons,
      pagination: {
        total,
        page: parseInt(page),
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: "Failed to fetch coupons",
      details: error.message,
    });
  }
});

// Get single coupon details (admin only)
router.get("/:id", protect, isAdmin, async (req, res) => {
  try {
    const coupon = await Coupon.findById(req.params.id)
      .populate("applicableProducts", "name price")
      .populate("createdBy", "email name");

    if (!coupon) {
      return res.status(404).json({
        success: false,
        error: "Coupon not found",
      });
    }

    res.status(200).json({
      success: true,
      data: coupon,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: "Failed to fetch coupon",
      details: error.message,
    });
  }
});

// Validate coupon code (public; per-customer limits are checked too when signed in)
router.post(
  "/validate",
  optionalAuth,
  [
    body("code").notEmpty().trim().toUpperCase(),
    body("cartTotal").isFloat({ min: 0 }),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, errors: errors.array() });
      }

      const cartTotal = Number(req.body.cartTotal);
      const { coupon, discount } = await evaluateCoupon({
        code: req.body.code,
        subtotal: cartTotal,
        userId: req.user?._id,
      });

      res.status(200).json({
        success: true,
        data: {
          code: coupon.code,
          discountType: coupon.discountType,
          discountValue: coupon.discountValue,
          maxDiscount: coupon.maxDiscount ?? null,
          minCartValue: coupon.minCartValue || 0,
          discount,
          finalTotal: Math.max(0, cartTotal - discount),
        },
      });
    } catch (error) {
      if (error instanceof CouponError) {
        return res.status(400).json({ success: false, error: error.message });
      }
      res.status(500).json({
        success: false,
        error: "Failed to validate coupon",
      });
    }
  },
);

// Create coupon (admin only)
router.post(
  "/",
  protect,
  isAdmin,
  [
    body("code").notEmpty().trim().toUpperCase(),
    body("discountType").isIn(["percentage", "fixed"]),
    body("discountValue").isFloat({ min: 0 }),
    body("validFrom").optional().isISO8601(),
    body("validUntil").optional().isISO8601(),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, errors: errors.array() });
      }

      // Check if coupon code already exists
      const existingCoupon = await Coupon.findOne({ code: req.body.code });
      if (existingCoupon) {
        return res.status(400).json({
          success: false,
          error: "Coupon code already exists",
        });
      }

      const coupon = new Coupon({
        ...req.body,
        createdBy: req.user._id,
      });

      await coupon.save();

      res.status(201).json({
        success: true,
        data: coupon,
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: "Failed to create coupon",
        details: error.message,
      });
    }
  },
);

// Update coupon (admin only)
router.put("/:id", protect, isAdmin, async (req, res) => {
  try {
    const coupon = await Coupon.findByIdAndUpdate(
      req.params.id,
      { ...req.body, updatedAt: new Date() },
      { new: true, runValidators: true },
    );

    if (!coupon) {
      return res.status(404).json({
        success: false,
        error: "Coupon not found",
      });
    }

    res.status(200).json({
      success: true,
      data: coupon,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: "Failed to update coupon",
      details: error.message,
    });
  }
});

// Delete coupon (admin only)
router.delete("/:id", protect, isAdmin, async (req, res) => {
  try {
    const coupon = await Coupon.findByIdAndDelete(req.params.id);

    if (!coupon) {
      return res.status(404).json({
        success: false,
        error: "Coupon not found",
      });
    }

    res.status(200).json({
      success: true,
      message: "Coupon deleted successfully",
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: "Failed to delete coupon",
      details: error.message,
    });
  }
});

module.exports = router;
