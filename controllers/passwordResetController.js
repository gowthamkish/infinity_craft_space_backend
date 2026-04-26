const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const User = require("../models/User");
const PasswordResetLog = require("../models/PasswordResetLog");
const { SECURITY_QUESTIONS, FAKE_QUESTION_INDICES } = require("../utils/securityQuestions");

const VERIFICATION_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes
const RESET_EXPIRY_MS = 15 * 60 * 1000;        // 15 minutes
const MAX_VERIFY_ATTEMPTS = 3;

// SHA-256 hash of the raw token — safe to use for DB lookup since the token
// has 256-bit entropy (unlike passwords which need bcrypt).
const hashToken = (token) =>
  crypto.createHash("sha256").update(token).digest("hex");

// Normalise answer: lowercase + collapse whitespace.
const normaliseAnswer = (str) =>
  str.trim().toLowerCase().replace(/\s+/g, " ");

// Escape regex special chars for safe username lookups.
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Non-blocking audit log.
const auditLog = async (action, ip, ua, userId = null, identifier = null) => {
  try {
    const identifierHash = identifier
      ? crypto.createHash("sha256").update(identifier.toLowerCase()).digest("hex")
      : null;
    await PasswordResetLog.create({
      userId, identifierHash, action, ip, userAgent: ua?.slice(0, 200),
    });
  } catch { /* never let logging break the flow */ }
};

// ─────────────────────────────────────────────────────────────────────────────
// Step 1 — POST /api/auth/forgot-password
// ─────────────────────────────────────────────────────────────────────────────
const forgotPassword = async (req, res) => {
  const { identifier } = req.body;
  const ip = req.ip;
  const ua = req.headers["user-agent"];

  const GENERIC = {
    message:
      "If an account with those details exists and security questions are configured, you may proceed to verification.",
  };

  if (!identifier || typeof identifier !== "string" || identifier.trim().length < 3) {
    return res.json(GENERIC);
  }

  const id = identifier.trim();

  try {
    // hasSecurityQuestions is a plain Boolean field (no select:false) — reliable fast check.
    const user = await User.findOne({
      $or: [
        { email: id.toLowerCase() },
        { username: new RegExp(`^${escapeRegex(id)}$`, "i") },
      ],
    });

    const rawToken = crypto.randomBytes(32).toString("hex");

    if (user && user.hasSecurityQuestions) {
      // Use updateOne so we don't depend on Mongoose's partial-projection save behaviour.
      await User.updateOne(
        { _id: user._id },
        {
          $set: {
            verificationToken: hashToken(rawToken),
            verificationTokenExpiry: new Date(Date.now() + VERIFICATION_EXPIRY_MS),
            verificationAttempts: 0,
          },
        }
      );
      await auditLog("forgot_password_request", ip, ua, user._id, id);
    } else {
      await auditLog("forgot_password_no_account", ip, ua, null, id);
    }

    // Always respond identically — never reveal whether the account or questions exist.
    return res.json({ ...GENERIC, verificationToken: rawToken });
  } catch (err) {
    console.error("forgotPassword error:", err);
    return res.json(GENERIC);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Step 2a — GET /api/auth/security-questions/:token
// Returns the questions associated with a valid verificationToken.
// Returns fake questions for invalid/expired tokens (indistinguishable from real).
// ─────────────────────────────────────────────────────────────────────────────
const getSecurityQuestions = async (req, res) => {
  const { token } = req.params;

  const fakeQuestions = FAKE_QUESTION_INDICES.map((i) => ({
    index: i,
    question: SECURITY_QUESTIONS[i],
  }));

  if (!token || token.length < 10) {
    return res.json({ questions: fakeQuestions });
  }

  try {
    // securityQuestions has select:false — must explicitly include it.
    const user = await User.findOne({
      verificationToken: hashToken(token),
      verificationTokenExpiry: { $gt: new Date() },
    }).select("+securityQuestions");

    if (!user) {
      return res.json({ questions: fakeQuestions });
    }

    const questions = (user.securityQuestions || []).map((sq) => ({
      index: sq.questionIndex,
      question: SECURITY_QUESTIONS[sq.questionIndex],
    }));

    return res.json({ questions });
  } catch (err) {
    console.error("getSecurityQuestions error:", err);
    return res.json({ questions: fakeQuestions });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Step 2b — POST /api/auth/verify-answers
// ─────────────────────────────────────────────────────────────────────────────
const verifyAnswers = async (req, res) => {
  const { verificationToken, answers } = req.body;
  const ip = req.ip;
  const ua = req.headers["user-agent"];

  const FAIL = (msg = "Verification failed. Please check your answers and try again.") =>
    res.status(400).json({ success: false, error: msg });

  if (!verificationToken || !Array.isArray(answers) || answers.length < 2) {
    return FAIL();
  }

  try {
    // securityQuestions has select:false — explicitly include it.
    const user = await User.findOne({
      verificationToken: hashToken(verificationToken),
      verificationTokenExpiry: { $gt: new Date() },
    }).select("+securityQuestions");

    if (!user) {
      // Burn a bcrypt round to equalise response time for invalid tokens.
      await bcrypt.compare("timing-pad", "$2a$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMQJqhN8/LewYpfQiZMHfEdx.q");
      return FAIL();
    }

    if (user.verificationAttempts >= MAX_VERIFY_ATTEMPTS) {
      await auditLog("verify_answers_locked", ip, ua, user._id);
      return res.status(429).json({
        success: false,
        error: "Too many failed attempts. Please start the process again.",
      });
    }

    const questions = user.securityQuestions || [];
    if (answers.length < questions.length) {
      await User.updateOne({ _id: user._id }, { $inc: { verificationAttempts: 1 } });
      return FAIL();
    }

    const results = await Promise.all(
      questions.map((sq, i) => {
        const provided = answers[i] ? normaliseAnswer(String(answers[i])) : "";
        return bcrypt.compare(provided, sq.answerHash);
      })
    );

    if (!results.every(Boolean)) {
      const newAttempts = user.verificationAttempts + 1;
      await User.updateOne({ _id: user._id }, { $set: { verificationAttempts: newAttempts } });
      await auditLog("verify_answers_fail", ip, ua, user._id);

      const remaining = MAX_VERIFY_ATTEMPTS - newAttempts;
      return FAIL(
        remaining > 0
          ? `Incorrect answers. ${remaining} attempt${remaining !== 1 ? "s" : ""} remaining.`
          : "Too many failed attempts. Please start the process again."
      );
    }

    // All correct — issue a short-lived reset token.
    const rawResetToken = crypto.randomBytes(32).toString("hex");
    await User.updateOne(
      { _id: user._id },
      {
        $set: {
          resetToken: hashToken(rawResetToken),
          resetTokenExpiry: new Date(Date.now() + RESET_EXPIRY_MS),
          verificationAttempts: 0,
        },
        $unset: { verificationToken: "", verificationTokenExpiry: "" },
      }
    );

    await auditLog("verify_answers_success", ip, ua, user._id);

    return res.json({
      success: true,
      resetToken: rawResetToken,
      expiresInMinutes: 15,
      message: "Verification successful. You may now reset your password.",
    });
  } catch (err) {
    console.error("verifyAnswers error:", err);
    return res.status(500).json({ success: false, error: "Verification failed. Please try again." });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Step 3 — POST /api/auth/reset-password
// ─────────────────────────────────────────────────────────────────────────────
const resetPassword = async (req, res) => {
  const { resetToken, newPassword } = req.body;
  const ip = req.ip;
  const ua = req.headers["user-agent"];

  if (!resetToken || !newPassword) {
    return res.status(400).json({ success: false, error: "Reset token and new password are required." });
  }

  const pwError = validatePasswordStrength(newPassword);
  if (pwError) {
    return res.status(400).json({ success: false, error: pwError });
  }

  try {
    // previousPasswordHash has select:false — explicitly include it.
    const user = await User.findOne({
      resetToken: hashToken(resetToken),
      resetTokenExpiry: { $gt: new Date() },
    }).select("+previousPasswordHash");

    if (!user) {
      return res.status(400).json({
        success: false,
        error: "Invalid or expired reset token. Please start over.",
      });
    }

    const sameAsCurrent = await bcrypt.compare(newPassword, user.password);
    if (sameAsCurrent) {
      return res.status(400).json({
        success: false,
        error: "New password cannot be the same as your current password.",
      });
    }

    if (user.previousPasswordHash) {
      const sameAsPrevious = await bcrypt.compare(newPassword, user.previousPasswordHash);
      if (sameAsPrevious) {
        return res.status(400).json({
          success: false,
          error: "New password cannot be the same as your previous password.",
        });
      }
    }

    const newHash = await bcrypt.hash(newPassword, 12);

    await User.updateOne(
      { _id: user._id },
      {
        $set: {
          previousPasswordHash: user.password, // rotate
          password: newHash,
          passwordChangedAt: new Date(),        // invalidates all existing JWTs
          loginAttempts: 0,
          lockUntil: null,
        },
        $unset: {
          resetToken: "",
          resetTokenExpiry: "",
          verificationToken: "",
          verificationTokenExpiry: "",
        },
      }
    );

    await auditLog("password_reset_success", ip, ua, user._id);

    return res.json({
      success: true,
      message: "Password reset successfully. Please log in with your new password.",
    });
  } catch (err) {
    console.error("resetPassword error:", err);
    return res.status(500).json({ success: false, error: "Password reset failed. Please try again." });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Setup — POST /api/auth/setup-security-questions  (protected)
// Uses updateOne directly to bypass any Mongoose partial-projection save issues
// with select:false fields.
// ─────────────────────────────────────────────────────────────────────────────
const setupSecurityQuestions = async (req, res) => {
  const { questions } = req.body;
  const ip = req.ip;
  const ua = req.headers["user-agent"];

  if (!Array.isArray(questions) || questions.length < 2) {
    return res.status(400).json({ success: false, error: "You must provide exactly 2 security questions." });
  }

  const chosen = questions.slice(0, 2);

  for (const q of chosen) {
    if (
      typeof q.questionIndex !== "number" ||
      q.questionIndex < 0 ||
      q.questionIndex >= SECURITY_QUESTIONS.length
    ) {
      return res.status(400).json({ success: false, error: "Invalid question selection." });
    }
    if (!q.answer || typeof q.answer !== "string" || q.answer.trim().length < 2) {
      return res.status(400).json({ success: false, error: "Each answer must be at least 2 characters." });
    }
  }

  if (new Set(chosen.map((q) => q.questionIndex)).size !== chosen.length) {
    return res.status(400).json({ success: false, error: "Please choose two different questions." });
  }

  try {
    const hashedQuestions = await Promise.all(
      chosen.map(async (q) => ({
        questionIndex: q.questionIndex,
        answerHash: await bcrypt.hash(normaliseAnswer(q.answer), 12),
      }))
    );

    // Use updateOne to avoid any Mongoose save quirk with select:false fields.
    await User.updateOne(
      { _id: req.user._id },
      {
        $set: {
          securityQuestions: hashedQuestions,
          hasSecurityQuestions: true,
        },
      }
    );

    await auditLog("setup_questions", ip, ua, req.user._id);

    return res.json({ success: true, message: "Security questions saved successfully." });
  } catch (err) {
    console.error("setupSecurityQuestions error:", err);
    return res.status(500).json({ success: false, error: "Failed to save security questions." });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Status — GET /api/auth/security-questions-status  (protected)
// ─────────────────────────────────────────────────────────────────────────────
const getSecurityQuestionsStatus = async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select("+securityQuestions");
    const hasQuestions = !!user.hasSecurityQuestions && user.securityQuestions?.length >= 2;
    const configured = hasQuestions
      ? user.securityQuestions.map((sq) => ({
          index: sq.questionIndex,
          question: SECURITY_QUESTIONS[sq.questionIndex],
        }))
      : [];
    return res.json({ hasQuestions, configured });
  } catch (err) {
    return res.status(500).json({ success: false, error: "Could not fetch security question status." });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Password strength validation
// ─────────────────────────────────────────────────────────────────────────────
function validatePasswordStrength(password) {
  if (!password || password.length < 8) return "Password must be at least 8 characters.";
  if (password.length > 128) return "Password is too long (max 128 characters).";
  if (!/[A-Z]/.test(password)) return "Password must contain at least one uppercase letter.";
  if (!/[a-z]/.test(password)) return "Password must contain at least one lowercase letter.";
  if (!/[0-9]/.test(password)) return "Password must contain at least one number.";
  if (!/[^A-Za-z0-9]/.test(password)) return "Password must contain at least one special character (!@#$…).";
  return null;
}

module.exports = {
  forgotPassword,
  getSecurityQuestions,
  verifyAnswers,
  resetPassword,
  setupSecurityQuestions,
  getSecurityQuestionsStatus,
};
