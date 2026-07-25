/**
 * Chat route — POST /api/chat
 *
 * Public endpoint (no auth required to start chatting).
 * Order status lookup inside the agent requires auth, but the route itself is open
 * so guests can still ask about products and policies.
 *
 * Rate limited by chatLimiter (20 messages per 10 minutes per IP).
 */

const express = require("express");
const router = express.Router();
const { optionalAuth } = require("../middlewares/authMiddleware");
const { chatLimiter } = require("../middlewares/rateLimiter");
const { handleChat } = require("../controllers/chatController");
const { body, validationResult } = require("express-validator");

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, errors: errors.array() });
  }
  next();
};

router.post(
  "/",
  chatLimiter,
  optionalAuth,
  [
    body("messages")
      .isArray({ min: 1, max: 20 })
      .withMessage("messages must be an array of 1–20 items"),
    body("messages.*.role")
      .isIn(["user", "assistant"])
      .withMessage("message role must be user or assistant"),
    body("messages.*.content")
      .isString()
      .isLength({ max: 2000 })
      .withMessage("message content max 2000 chars"),
    body("sessionId").optional().isString().isLength({ max: 64 }),
  ],
  validate,
  handleChat,
);

module.exports = router;
