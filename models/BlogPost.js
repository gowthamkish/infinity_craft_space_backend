const mongoose = require("mongoose");

/**
 * "Behind the craft" blog post. Body is stored as lightweight Markdown (headings, bold/italic, lists, links,
 * quotes, images) and rendered safely on the frontend — no raw HTML is ever stored or injected.
 */
const BlogPostSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 140 },
    slug: { type: String, required: true, unique: true, trim: true, lowercase: true },
    excerpt: { type: String, trim: true, maxlength: 300, default: "" },
    content: { type: String, required: true, maxlength: 60000 },
    coverImage: {
      url: { type: String },
      publicId: { type: String },
      alt: { type: String, trim: true, maxlength: 200 },
    },
    tags: [{ type: String, trim: true, lowercase: true, maxlength: 30 }],
    authorName: { type: String, trim: true, default: "Infinity Craft Space" },
    status: { type: String, enum: ["draft", "published"], default: "draft", index: true },
    publishedAt: { type: Date, default: null },
    readingMinutes: { type: Number, default: 1 },
    views: { type: Number, default: 0 },
    // Optional SEO overrides (fall back to title / excerpt)
    metaTitle: { type: String, trim: true, maxlength: 70 },
    metaDescription: { type: String, trim: true, maxlength: 170 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    // Set when the blog agent wrote the post (shown to readers as a disclosure, and as an "AI" badge in admin)
    generatedBy: { type: String, enum: ["manual", "agent"], default: "manual" },
    aiModel: { type: String },
    agentRunId: { type: mongoose.Schema.Types.ObjectId, ref: "BlogAgentRun" },
  },
  { timestamps: true },
);

BlogPostSchema.index({ status: 1, publishedAt: -1 });
BlogPostSchema.index({ tags: 1, status: 1 });

module.exports = mongoose.model("BlogPost", BlogPostSchema);
