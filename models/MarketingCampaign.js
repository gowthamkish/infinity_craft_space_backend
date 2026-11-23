const mongoose = require("mongoose");

/** One campaign package written by the marketing agent (Instagram + WhatsApp + email drafts, audience, offer). */
const MarketingCampaignSchema = new mongoose.Schema(
  {
    brief: { type: String, required: true, maxlength: 600 },
    status: { type: String, enum: ["running", "succeeded", "failed"], default: "running", index: true },
    startedAt: { type: Date, default: Date.now },
    finishedAt: { type: Date },
    model: { type: String },
    steps: [{ _id: false, tool: String, note: String, at: { type: Date, default: Date.now } }],
    usage: { inputTokens: { type: Number, default: 0 }, outputTokens: { type: Number, default: 0 }, turns: { type: Number, default: 0 } },
    error: { type: String },
    /** The finished, validated content (see services/marketingAgent.js → cleanCampaign) */
    campaign: { type: mongoose.Schema.Types.Mixed },
    /** Categories/products the campaign is about — used to work out who might be interested */
    audienceQuery: { categories: [String], productIds: [String] },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

MarketingCampaignSchema.index({ createdAt: -1 });

module.exports = mongoose.model("MarketingCampaign", MarketingCampaignSchema);
