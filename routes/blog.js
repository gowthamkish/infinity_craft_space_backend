/**
 * Blog — "Behind the craft" stories.
 *   Public : GET /api/blog, GET /api/blog/tags, GET /api/blog/:slug
 *   Admin  : GET /api/blog/admin/all, GET /api/blog/admin/:id, POST /api/blog, PUT /api/blog/:id,
 *            DELETE /api/blog/:id, POST /api/blog/upload-image
 */
const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const BlogPost = require("../models/BlogPost");
const { protect, isAdmin } = require("../middlewares/authMiddleware");
const { uploadBase64Image, deleteImage } = require("../config/cloudinary");
const { slugify, uniqueSlug, readingMinutes, cleanTags } = require("../utils/blogHelpers");

const PUBLIC_LIST_FIELDS = "title slug excerpt coverImage tags authorName publishedAt readingMinutes";

/** Picks only the fields an admin may set. */
function pickFields(body) {
  const out = {};
  if (body.title !== undefined) out.title = String(body.title).trim();
  if (body.excerpt !== undefined) out.excerpt = String(body.excerpt).trim().slice(0, 300);
  if (body.content !== undefined) out.content = String(body.content);
  if (body.tags !== undefined) out.tags = cleanTags(body.tags);
  if (body.authorName !== undefined) out.authorName = String(body.authorName).trim().slice(0, 80) || "Infinity Craft Space";
  if (body.metaTitle !== undefined) out.metaTitle = String(body.metaTitle).trim().slice(0, 70);
  if (body.metaDescription !== undefined) out.metaDescription = String(body.metaDescription).trim().slice(0, 170);
  if (body.coverImage !== undefined) {
    const c = body.coverImage;
    out.coverImage = c && c.url ? { url: String(c.url), publicId: c.publicId ? String(c.publicId) : undefined, alt: String(c.alt || "").slice(0, 200) } : undefined;
  }
  return out;
}

// ── Admin ────────────────────────────────────────────────────────────────────

router.get("/admin/all", protect, isAdmin, async (_req, res) => {
  try {
    const posts = await BlogPost.find({}).select("-content").sort({ updatedAt: -1 }).lean();
    res.json({ success: true, posts });
  } catch (e) {
    res.status(500).json({ success: false, message: "Failed to load posts" });
  }
});

router.get("/admin/:id", protect, isAdmin, async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ success: false, message: "Invalid id" });
  const post = await BlogPost.findById(req.params.id).lean();
  if (!post) return res.status(404).json({ success: false, message: "Post not found" });
  res.json({ success: true, post });
});

router.post("/upload-image", protect, isAdmin, async (req, res) => {
  try {
    const { image } = req.body || {};
    if (typeof image !== "string" || !image.startsWith("data:image/")) {
      return res.status(400).json({ success: false, message: "Send the image as a base64 data URL" });
    }
    const result = await uploadBase64Image(image, {
      folder: "infinity_craft_blog",
      transformation: [{ width: 1600, crop: "limit" }, { quality: "auto" }],
    });
    res.json({ success: true, image: { url: result.url, publicId: result.publicId } });
  } catch (e) {
    console.error("[Blog] Image upload failed:", e.message);
    res.status(500).json({ success: false, message: "Image upload failed" });
  }
});

router.post("/", protect, isAdmin, async (req, res) => {
  try {
    const data = pickFields(req.body);
    if (!data.title) return res.status(400).json({ success: false, message: "Title is required" });
    if (!data.content || !data.content.trim()) return res.status(400).json({ success: false, message: "Write something in the post body" });

    const publish = req.body.status === "published";
    const post = await BlogPost.create({
      ...data,
      slug: await uniqueSlug(req.body.slug || data.title),
      readingMinutes: readingMinutes(data.content),
      status: publish ? "published" : "draft",
      publishedAt: publish ? new Date() : null,
      createdBy: req.user._id,
    });
    res.status(201).json({ success: true, post });
  } catch (e) {
    console.error("[Blog] Create failed:", e.message);
    res.status(500).json({ success: false, message: "Failed to create post" });
  }
});

router.put("/:id", protect, isAdmin, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ success: false, message: "Invalid id" });
    const post = await BlogPost.findById(req.params.id);
    if (!post) return res.status(404).json({ success: false, message: "Post not found" });

    const data = pickFields(req.body);
    if (data.title === "") return res.status(400).json({ success: false, message: "Title is required" });
    if (data.content !== undefined && !data.content.trim()) return res.status(400).json({ success: false, message: "Post body can't be empty" });

    const oldCover = post.coverImage?.publicId;
    Object.assign(post, data);
    if (data.content !== undefined) post.readingMinutes = readingMinutes(data.content);
    // Slug only changes when asked to, so published links don't break by accident
    if (req.body.slug && slugify(req.body.slug) !== post.slug) post.slug = await uniqueSlug(req.body.slug, post._id);

    if (req.body.status === "published" && post.status !== "published") {
      post.status = "published";
      post.publishedAt = post.publishedAt || new Date();
    } else if (req.body.status === "draft") {
      post.status = "draft";
    }
    await post.save();

    if (oldCover && oldCover !== post.coverImage?.publicId) deleteImage(oldCover).catch(() => {});
    res.json({ success: true, post });
  } catch (e) {
    console.error("[Blog] Update failed:", e.message);
    res.status(500).json({ success: false, message: "Failed to update post" });
  }
});

router.delete("/:id", protect, isAdmin, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ success: false, message: "Invalid id" });
    const post = await BlogPost.findByIdAndDelete(req.params.id);
    if (!post) return res.status(404).json({ success: false, message: "Post not found" });
    if (post.coverImage?.publicId) deleteImage(post.coverImage.publicId).catch(() => {});
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: "Failed to delete post" });
  }
});

// ── Public ───────────────────────────────────────────────────────────────────

router.get("/", async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(24, Math.max(1, parseInt(req.query.limit, 10) || 9));
    const filter = { status: "published" };
    if (req.query.tag) filter.tags = String(req.query.tag).toLowerCase();

    const [posts, total] = await Promise.all([
      BlogPost.find(filter).select(PUBLIC_LIST_FIELDS).sort({ publishedAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      BlogPost.countDocuments(filter),
    ]);
    res.set("Cache-Control", "public, max-age=60");
    res.json({ success: true, posts, total, page, pages: Math.ceil(total / limit) });
  } catch (e) {
    res.status(500).json({ success: false, message: "Failed to load posts" });
  }
});

router.get("/tags", async (_req, res) => {
  try {
    const tags = await BlogPost.aggregate([
      { $match: { status: "published" } },
      { $unwind: "$tags" },
      { $group: { _id: "$tags", count: { $sum: 1 } } },
      { $sort: { count: -1, _id: 1 } },
      { $limit: 20 },
    ]);
    res.set("Cache-Control", "public, max-age=300");
    res.json({ success: true, tags: tags.map((t) => ({ tag: t._id, count: t.count })) });
  } catch (e) {
    res.status(500).json({ success: false, message: "Failed to load tags" });
  }
});

router.get("/:slug", async (req, res) => {
  try {
    const post = await BlogPost.findOneAndUpdate(
      { slug: String(req.params.slug).toLowerCase(), status: "published" },
      { $inc: { views: 1 } },
      { new: true },
    ).select("-createdBy -views").lean();
    if (!post) return res.status(404).json({ success: false, message: "Post not found" });

    const related = await BlogPost.find({
      status: "published",
      _id: { $ne: post._id },
      ...(post.tags?.length ? { tags: { $in: post.tags } } : {}),
    })
      .select(PUBLIC_LIST_FIELDS).sort({ publishedAt: -1 }).limit(3).lean();

    res.json({ success: true, post, related });
  } catch (e) {
    res.status(500).json({ success: false, message: "Failed to load post" });
  }
});

module.exports = router;
