/**
 * ChatLog — records every chat session and tool call for QA / abuse review.
 *
 * Mirrors the WhatsAppLog / Notification pattern in this codebase.
 * Never stores payment fields, passwords, or PII beyond userId + session.
 */

const mongoose = require("mongoose");

const MessageSchema = new mongoose.Schema(
  {
    role: { type: String, enum: ["user", "assistant", "tool"], required: true },
    content: { type: String },
    toolName: { type: String },   // set when role === 'tool'
    toolInput: { type: mongoose.Schema.Types.Mixed },
    toolResult: { type: mongoose.Schema.Types.Mixed },
  },
  { _id: false },
);

const ChatLogSchema = new mongoose.Schema({
  sessionId: { type: String, required: true, index: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  ipHash: { type: String },           // SHA-256 of IP for abuse tracking, not reversible
  messages: [MessageSchema],
  toolCallCount: { type: Number, default: 0 },
  inputTokens: { type: Number, default: 0 },
  outputTokens: { type: Number, default: 0 },
  error: { type: String, default: null },
  createdAt: { type: Date, default: Date.now, index: true },
  // Auto-expire logs after 90 days
  expiresAt: {
    type: Date,
    default: () => new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
    index: { expireAfterSeconds: 0 },
  },
});

module.exports = mongoose.model("ChatLog", ChatLogSchema);
