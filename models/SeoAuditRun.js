const mongoose = require("mongoose");

/** One run of the SEO & website-health audit, with its full report (see services/seoAudit.js). */
const SeoAuditRunSchema = new mongoose.Schema(
  {
    trigger: { type: String, enum: ["schedule", "manual"], required: true },
    status: { type: String, enum: ["running", "succeeded", "failed"], default: "running", index: true },
    startedAt: { type: Date, default: Date.now },
    finishedAt: { type: Date },
    report: { type: mongoose.Schema.Types.Mixed },
    error: { type: String },
  },
  { timestamps: true },
);

SeoAuditRunSchema.index({ startedAt: -1 });

module.exports = mongoose.model("SeoAuditRun", SeoAuditRunSchema);
