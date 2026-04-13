const express = require("express");
const router = express.Router();
const { protect, isAdmin } = require("../middlewares/authMiddleware");
const QnA = require("../models/QnA");
const Product = require("../models/Product");
const { body, validationResult } = require("express-validator");

// Get Q&A for a product (public)
router.get("/product/:productId", async (req, res) => {
  try {
    const { page = 1, limit = 10, sort = "latest" } = req.query;

    const product = await Product.findById(req.params.productId);
    if (!product) {
      return res.status(404).json({
        success: false,
        error: "Product not found",
      });
    }

    let sortOption = { createdAt: -1 };
    if (sort === "helpful") {
      sortOption = { helpful: -1 };
    } else if (sort === "pinned") {
      sortOption = { isPinned: -1, helpful: -1 };
    }

    const qnaList = await QnA.find({
      product: req.params.productId,
      isApproved: true,
    })
      .populate("user", "username email")
      .populate("answers.user", "username email")
      .limit(limit * 1)
      .skip((page - 1) * limit)
      .sort(sortOption);

    const total = await QnA.countDocuments({
      product: req.params.productId,
      isApproved: true,
    });

    res.status(200).json({
      success: true,
      data: qnaList,
      pagination: {
        total,
        page: parseInt(page),
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: "Failed to fetch Q&A",
      details: error.message,
    });
  }
});

// Post a question (authenticated)
router.post(
  "/product/:productId/question",
  protect,
  [body("question").trim().notEmpty().isLength({ min: 10, max: 500 })],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, errors: errors.array() });
      }

      const product = await Product.findById(req.params.productId);
      if (!product) {
        return res.status(404).json({
          success: false,
          error: "Product not found",
        });
      }

      const qna = new QnA({
        product: req.params.productId,
        user: req.user._id,
        userName: req.user.username,
        userEmail: req.user.email,
        question: req.body.question,
        isApproved: true, // Auto-approve for now (you can change this)
      });

      await qna.save();
      await qna.populate("user", "username email");

      res.status(201).json({
        success: true,
        data: qna,
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: "Failed to post question",
        details: error.message,
      });
    }
  },
);

// Post an answer (authenticated)
router.post(
  "/:qnaId/answer",
  protect,
  [body("content").trim().notEmpty().isLength({ min: 5, max: 500 })],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, errors: errors.array() });
      }

      const qna = await QnA.findById(req.params.qnaId);
      if (!qna) {
        return res.status(404).json({
          success: false,
          error: "Question not found",
        });
      }

      const answer = {
        user: req.user._id,
        userName: req.user.username,
        content: req.body.content,
        isSellerResponse: req.user.isAdmin, // Mark as seller if admin
      };

      qna.answers.push(answer);
      await qna.save();
      await qna.populate("answers.user", "username email");

      res.status(201).json({
        success: true,
        data: qna,
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: "Failed to post answer",
        details: error.message,
      });
    }
  },
);

// Mark as helpful (public)
router.post("/:qnaId/helpful", async (req, res) => {
  try {
    const qna = await QnA.findByIdAndUpdate(
      req.params.qnaId,
      { $inc: { helpful: 1 } },
      { new: true },
    );

    if (!qna) {
      return res.status(404).json({
        success: false,
        error: "Question not found",
      });
    }

    res.status(200).json({
      success: true,
      data: qna,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: "Failed to update helpful count",
      details: error.message,
    });
  }
});

// Mark as not helpful (public)
router.post("/:qnaId/not-helpful", async (req, res) => {
  try {
    const qna = await QnA.findByIdAndUpdate(
      req.params.qnaId,
      { $inc: { notHelpful: 1 } },
      { new: true },
    );

    if (!qna) {
      return res.status(404).json({
        success: false,
        error: "Question not found",
      });
    }

    res.status(200).json({
      success: true,
      data: qna,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: "Failed to update not helpful count",
      details: error.message,
    });
  }
});

// Pin question (admin only)
router.post("/:qnaId/pin", protect, isAdmin, async (req, res) => {
  try {
    const qna = await QnA.findByIdAndUpdate(
      req.params.qnaId,
      { isPinned: true },
      { new: true },
    );

    if (!qna) {
      return res.status(404).json({
        success: false,
        error: "Question not found",
      });
    }

    res.status(200).json({
      success: true,
      data: qna,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: "Failed to pin question",
      details: error.message,
    });
  }
});

// Approve question (admin only)
router.post("/:qnaId/approve", protect, isAdmin, async (req, res) => {
  try {
    const qna = await QnA.findByIdAndUpdate(
      req.params.qnaId,
      { isApproved: true },
      { new: true },
    );

    if (!qna) {
      return res.status(404).json({
        success: false,
        error: "Question not found",
      });
    }

    res.status(200).json({
      success: true,
      data: qna,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: "Failed to approve question",
      details: error.message,
    });
  }
});

module.exports = router;
