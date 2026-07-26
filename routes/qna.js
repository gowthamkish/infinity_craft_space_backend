const express = require("express");
const router = express.Router();
const { protect, isAdmin } = require("../middlewares/authMiddleware");
const QnA = require("../models/QnA");
const Product = require("../models/Product");
const { body, validationResult } = require("express-validator");
const { runQnAAutoAnswerAgent } = require("../controllers/qnaAgentController");

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

      // Fire-and-forget: AI auto-answer agent
      runQnAAutoAnswerAgent(qna).catch((e) =>
        console.error("[QnAAgent] Unhandled error:", e.message)
      );

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

// Admin: Get Q&A pending AI draft approval
router.get("/admin/drafts", protect, isAdmin, async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const safeLimit = Math.min(50, Math.max(1, parseInt(limit, 10) || 20));
    const safePage  = Math.max(1, parseInt(page, 10) || 1);

    const [items, total] = await Promise.all([
      QnA.find({ "aiDraftAnswer.status": "pending_approval" })
        .populate("product", "name images")
        .populate("user", "username email")
        .sort({ createdAt: -1 })
        .skip((safePage - 1) * safeLimit)
        .limit(safeLimit)
        .lean(),
      QnA.countDocuments({ "aiDraftAnswer.status": "pending_approval" }),
    ]);

    res.json({
      success: true,
      items,
      pagination: { page: safePage, limit: safeLimit, total, pages: Math.ceil(total / safeLimit) },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Admin: Approve AI draft answer → post it as official answer
router.post("/:qnaId/approve-ai-answer", protect, isAdmin, async (req, res) => {
  try {
    const { editedContent } = req.body; // admin can optionally edit before approving

    const qna = await QnA.findById(req.params.qnaId);
    if (!qna) return res.status(404).json({ success: false, error: "Question not found" });
    if (!qna.aiDraftAnswer?.content) {
      return res.status(400).json({ success: false, error: "No AI draft answer found" });
    }
    if (qna.aiDraftAnswer.status !== "pending_approval") {
      return res.status(400).json({ success: false, error: "Draft has already been actioned" });
    }

    const finalContent = editedContent?.trim() || qna.aiDraftAnswer.content;

    qna.answers.push({
      user:             req.user._id,
      userName:         "Aria (AI Assistant)",
      content:          finalContent,
      isSellerResponse: true,
      createdAt:        new Date(),
    });
    qna.aiDraftAnswer.status = "approved";

    await qna.save();
    await qna.populate("answers.user", "username email");

    res.json({ success: true, message: "AI answer approved and posted", data: qna });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Admin: Dismiss AI draft answer
router.post("/:qnaId/dismiss-ai-answer", protect, isAdmin, async (req, res) => {
  try {
    const qna = await QnA.findByIdAndUpdate(
      req.params.qnaId,
      { "aiDraftAnswer.status": "dismissed" },
      { new: true }
    );
    if (!qna) return res.status(404).json({ success: false, error: "Question not found" });
    res.json({ success: true, message: "AI draft dismissed" });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
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
