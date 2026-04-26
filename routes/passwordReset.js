const express = require("express");
const router = express.Router();
const { protect } = require("../middlewares/authMiddleware");
const { passwordResetLimiter, verifyAnswersLimiter } = require("../middlewares/rateLimiter");
const {
  forgotPassword,
  getSecurityQuestions,
  verifyAnswers,
  resetPassword,
  setupSecurityQuestions,
  getSecurityQuestionsStatus,
} = require("../controllers/passwordResetController");

// Public password-reset flow (rate-limited, no auth required)
router.post("/forgot-password",     passwordResetLimiter,  forgotPassword);
router.get("/security-questions/:token",                   getSecurityQuestions);
router.post("/verify-answers",      verifyAnswersLimiter,  verifyAnswers);
router.post("/reset-password",      passwordResetLimiter,  resetPassword);

// Authenticated: manage own security questions
router.post("/setup-security-questions", protect, setupSecurityQuestions);
router.get("/security-questions-status", protect, getSecurityQuestionsStatus);

module.exports = router;
