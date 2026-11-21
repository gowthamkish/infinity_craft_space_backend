const mongoose = require("mongoose");

/** One execution of the blog agent — kept for the admin "recent runs" list and for debugging. */
const BlogAgentRunSchema = new mongoose.Schema(
  {
    trigger: { type: String, enum: ["schedule", "manual"], required: true },
    status: { type: String, enum: ["running", "succeeded", "failed"], default: "running", index: true },
    startedAt: { type: Date, default: Date.now },
    finishedAt: { type: Date },
    model: { type: String },
    pillar: { type: String },
    postId: { type: mongoose.Schema.Types.ObjectId, ref: "BlogPost" },
    postTitle: { type: String },
    published: { type: Boolean, default: false },
    steps: [{ _id: false, tool: String, note: String, at: { type: Date, default: Date.now } }],
    usage: { inputTokens: { type: Number, default: 0 }, outputTokens: { type: Number, default: 0 }, turns: { type: Number, default: 0 } },
    error: { type: String },
  },
  { timestamps: true },
);

BlogAgentRunSchema.index({ startedAt: -1 });

module.exports = mongoose.model("BlogAgentRun", BlogAgentRunSchema);
