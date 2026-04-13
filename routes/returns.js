const express = require("express");
const router = express.Router();
const { protect, isAdmin } = require("../middlewares/authMiddleware");
const ReturnRequest = require("../models/ReturnRequest");
const Order = require("../models/Order");
const { body, validationResult } = require("express-validator");
const multer = require("multer");
const cloudinary = require("cloudinary").v2;
const { CloudinaryStorage } = require("multer-storage-cloudinary");

// Configure Cloudinary storage
const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: "return-requests",
    resource_type: "auto",
    allowed_formats: ["jpg", "jpeg", "png", "gif", "webp"],
    max_file_size: 5242880, // 5MB
  },
});

const upload = multer({ storage });

// Get user's return requests (authenticated)
router.get("/", protect, async (req, res) => {
  try {
    const { page = 1, limit = 10, status } = req.query;
    const query = { userId: req.user._id };

    if (status) {
      query.status = status;
    }

    const returnRequests = await ReturnRequest.find(query)
      .populate("orderId", "orderNumber totalAmount")
      .limit(limit * 1)
      .skip((page - 1) * limit)
      .sort({ createdAt: -1 });

    const total = await ReturnRequest.countDocuments(query);

    res.status(200).json({
      success: true,
      data: returnRequests,
      pagination: {
        total,
        page: parseInt(page),
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: "Failed to fetch return requests",
      details: error.message,
    });
  }
});

// Get return request details (authenticated)
router.get("/:id", protect, async (req, res) => {
  try {
    const returnRequest = await ReturnRequest.findById(req.params.id)
      .populate("orderId")
      .populate("userId", "email username");

    if (!returnRequest) {
      return res.status(404).json({
        success: false,
        error: "Return request not found",
      });
    }

    // Check if user is authorized
    if (
      returnRequest.userId.toString() !== req.user._id.toString() &&
      !req.user.isAdmin
    ) {
      return res.status(403).json({
        success: false,
        error: "Unauthorized",
      });
    }

    res.status(200).json({
      success: true,
      data: returnRequest,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: "Failed to fetch return request",
      details: error.message,
    });
  }
});

// Create return request (authenticated)
router.post(
  "/",
  protect,
  upload.array("images", 5),
  [
    body("orderId").notEmpty(),
    body("reason").isIn([
      "defective",
      "wrong_item",
      "not_as_described",
      "size_mismatch",
      "quality_issue",
      "changed_mind",
      "duplicate_order",
      "other",
    ]),
    body("items").isArray({ min: 1 }),
    body("returnType").isIn(["return", "exchange", "refund"]),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, errors: errors.array() });
      }

      // Verify order belongs to user
      const order = await Order.findById(req.body.orderId);
      if (!order) {
        return res.status(404).json({
          success: false,
          error: "Order not found",
        });
      }

      if (order.userId.toString() !== req.user._id.toString()) {
        return res.status(403).json({
          success: false,
          error: "Unauthorized",
        });
      }

      // Check if order is eligible for return (within 30 days)
      const daysOld = Math.floor(
        (Date.now() - order.createdAt) / (1000 * 60 * 60 * 24),
      );
      if (daysOld > 30) {
        return res.status(400).json({
          success: false,
          error: "Return window expired (30 days)",
        });
      }

      // Process uploaded images
      const images = req.files
        ? req.files.map((file) => ({
            url: file.path,
            publicId: file.filename,
            uploadedAt: new Date(),
          }))
        : [];

      const returnRequest = new ReturnRequest({
        orderId: req.body.orderId,
        userId: req.user._id,
        userEmail: req.user.email,
        items: req.body.items,
        returnType: req.body.returnType,
        reason: req.body.reason,
        reasonDetails: req.body.reasonDetails,
        images,
        status: "requested",
      });

      await returnRequest.save();

      // Update order
      await Order.findByIdAndUpdate(req.body.orderId, {
        hasReturnRequest: true,
        returnRequestId: returnRequest._id,
      });

      res.status(201).json({
        success: true,
        data: returnRequest,
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: "Failed to create return request",
        details: error.message,
      });
    }
  },
);

// Approve return request (admin only)
router.put(
  "/:id/approve",
  protect,
  isAdmin,
  [
    body("refundAmount").isFloat({ min: 0 }),
    body("refundMethod").isIn(["original_payment", "wallet", "credit"]),
  ],
  async (req, res) => {
    try {
      const returnRequest = await ReturnRequest.findByIdAndUpdate(
        req.params.id,
        {
          status: "approved",
          refundAmount: req.body.refundAmount,
          refundMethod: req.body.refundMethod,
          returnAddress: req.body.returnAddress || undefined,
        },
        { new: true },
      );

      if (!returnRequest) {
        return res.status(404).json({
          success: false,
          error: "Return request not found",
        });
      }

      res.status(200).json({
        success: true,
        data: returnRequest,
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: "Failed to approve return request",
        details: error.message,
      });
    }
  },
);

// Reject return request (admin only)
router.put("/:id/reject", protect, isAdmin, async (req, res) => {
  try {
    const returnRequest = await ReturnRequest.findByIdAndUpdate(
      req.params.id,
      {
        status: "rejected",
        adminNotes: req.body.reason,
      },
      { new: true },
    );

    if (!returnRequest) {
      return res.status(404).json({
        success: false,
        error: "Return request not found",
      });
    }

    res.status(200).json({
      success: true,
      data: returnRequest,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: "Failed to reject return request",
      details: error.message,
    });
  }
});

// Update return status (admin only)
router.put(
  "/:id/status",
  protect,
  isAdmin,
  [
    body("status").isIn([
      "requested",
      "approved",
      "rejected",
      "in_transit",
      "received",
      "refunded",
      "completed",
    ]),
  ],
  async (req, res) => {
    try {
      const returnRequest = await ReturnRequest.findByIdAndUpdate(
        req.params.id,
        {
          status: req.body.status,
          trackingNumber: req.body.trackingNumber || undefined,
          updatedAt: new Date(),
        },
        { new: true },
      );

      if (!returnRequest) {
        return res.status(404).json({
          success: false,
          error: "Return request not found",
        });
      }

      res.status(200).json({
        success: true,
        data: returnRequest,
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: "Failed to update return status",
        details: error.message,
      });
    }
  },
);

// Get all return requests (admin only)
router.get("/admin/all", protect, isAdmin, async (req, res) => {
  try {
    const { page = 1, limit = 20, status } = req.query;
    const query = {};

    if (status) {
      query.status = status;
    }

    const returnRequests = await ReturnRequest.find(query)
      .populate("userId", "email username")
      .populate("orderId", "orderNumber totalAmount")
      .limit(limit * 1)
      .skip((page - 1) * limit)
      .sort({ createdAt: -1 });

    const total = await ReturnRequest.countDocuments(query);

    res.status(200).json({
      success: true,
      data: returnRequests,
      pagination: {
        total,
        page: parseInt(page),
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: "Failed to fetch return requests",
      details: error.message,
    });
  }
});

module.exports = router;
