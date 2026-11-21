const mongoose = require("mongoose");

/** Single settings document for the blog agent (key: "default"). Edited from Admin → Blog; takes effect without a redeploy. */
const BlogAgentConfigSchema = new mongoose.Schema(
  {
    key: { type: String, unique: true, default: "default" },
    enabled: { type: Boolean, default: true },
    intervalDays: { type: Number, default: 3, min: 1, max: 30 },
    runHourIST: { type: Number, default: 10, min: 0, max: 23 }, // hour of day (India time) the agent starts writing
    autoPublish: { type: Boolean, default: false }, // false = every post is saved as a draft for you to review
    focusNotes: { type: String, default: "", maxlength: 500 }, // e.g. "This week: wedding season gifting"
    lastRunAt: { type: Date, default: null },
    nextRunAt: { type: Date, default: null },
    runningSince: { type: Date, default: null }, // lock so two ticks can never write at once
    consecutiveFailures: { type: Number, default: 0 },
  },
  { timestamps: true },
);

module.exports = mongoose.model("BlogAgentConfig", BlogAgentConfigSchema);
