const mongoose = require("mongoose");

// Audit log for all password-reset-related events.
// identifierHash is SHA-256(lowercased email/username) — never store raw identifiers.
// TTL index auto-deletes entries after 90 days.
const PasswordResetLogSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  identifierHash: { type: String },
  action: {
    type: String,
    enum: [
      "forgot_password_request",    // user submitted identifier
      "forgot_password_no_account", // identifier not found / no questions
      "verify_answers_fail",        // wrong answers
      "verify_answers_locked",      // too many attempts
      "verify_answers_success",     // all answers correct
      "password_reset_success",     // password changed
      "setup_questions",            // user configured security questions
    ],
    required: true,
  },
  ip: { type: String },
  userAgent: { type: String },
  createdAt: { type: Date, default: Date.now, expires: 90 * 24 * 60 * 60 }, // 90 days TTL
});

module.exports = mongoose.model("PasswordResetLog", PasswordResetLogSchema);
