/**
 * Instagram feed + "shop the look" tags.
 *   Public : GET /api/instagram
 *   Admin  : GET /api/instagram/admin/all · POST /api/instagram · PUT /api/instagram/:id · DELETE /api/instagram/:id
 *            POST /api/instagram/upload-image
 */
const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();
const InstagramPost = require("../models/InstagramPost");
const Product = require("../models/Product");
const { protect, isAdmin } = require("../middlewares/authMiddleware");
const { uploadBase64Image, deleteImage } = require("../config/cloudinary");

const MAX_TAGS = 6;
const PERMALINK_RE = /^https:\/\/(www\.)?instagram\.com\/(p|reel|reels|tv)\/[A-Za-z0-9_-]+\/?(\?[^\s#]*)?$/i;

const productImage = (p) => p.images?.find((i) => i?.isPrimary && i.url)?.url || p.images?.find((i) => i?.url)?.url || p.image?.url || null;

// Products that need a choice (size / colour / personalisation) must be added from their own page
const needsOptions = (p) =>
  Boolean(
    (p.showHoopSizePicker && p.hoopSizes?.length > 0) ||
      (p.showStringSizePicker && p.stringSizes?.length > 0) ||
      (p.showColorPickerToUsers && (p.colors || []).some((c) => c.visibleToUsers)) ||
      p.isCustomizable,
  );

const PRODUCT_FIELDS =
  "name slug price compareAtPrice images image stock trackInventory isActive isCustomizable showHoopSizePicker hoopSizes showStringSizePicker stringSizes showColorPickerToUsers colors";

/** Validates/cleans the fields an admin may send. Returns { data } or { error }. */
async function cleanInput(body, { partial = false } = {}) {
  const data = {};
  if (body.imageUrl !== undefined) {
    if (!/^https:\/\//i.test(String(body.imageUrl))) return { error: "Please upload a photo" };
    data.imageUrl = String(body.imageUrl);
    if (body.imagePublicId !== undefined) data.imagePublicId = body.imagePublicId ? String(body.imagePublicId) : undefined;
  } else if (!partial) return { error: "Please upload a photo" };

  if (body.permalink !== undefined) {
    const link = String(body.permalink).trim();
    if (link && !PERMALINK_RE.test(link)) return { error: "That doesn't look like an Instagram post link (https://www.instagram.com/p/…)" };
    data.permalink = link;
  }
  if (body.caption !== undefined) data.caption = String(body.caption).trim().slice(0, 300);
  if (body.isActive !== undefined) data.isActive = Boolean(body.isActive);

  if (body.tags !== undefined) {
    const raw = Array.isArray(body.tags) ? body.tags : [];
    if (raw.length > MAX_TAGS) return { error: `You can tag at most ${MAX_TAGS} products per post` };
    const tags = [];
    for (const t of raw) {
      const id = String(t?.product?._id || t?.product || "");
      const x = Number(t?.x), y = Number(t?.y);
      if (!mongoose.Types.ObjectId.isValid(id)) return { error: "A tag points at an invalid product" };
      if (![x, y].every((n) => Number.isFinite(n) && n >= 0 && n <= 100)) return { error: "A tag has an invalid position" };
      tags.push({ product: id, x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 });
    }
    if (new Set(tags.map((t) => String(t.product))).size !== tags.length) return { error: "Each product can be tagged only once per photo" };
    if (tags.length) {
      const found = await Product.countDocuments({ _id: { $in: tags.map((t) => t.product) } });
      if (found !== tags.length) return { error: "A tagged product no longer exists" };
    }
    data.tags = tags;
  }
  return { data };
}

// ── Public ───────────────────────────────────────────────────────────────────

router.get("/", async (req, res) => {
  try {
    const limit = Math.min(12, Math.max(1, parseInt(req.query.limit, 10) || 6));
    const posts = await InstagramPost.find({ isActive: true }).sort({ createdAt: -1 }).limit(limit).lean();

    const ids = [...new Set(posts.flatMap((p) => p.tags.map((t) => String(t.product))))];
    const products = ids.length ? await Product.find({ _id: { $in: ids }, isActive: { $ne: false } }).select(PRODUCT_FIELDS).lean() : [];
    const byId = new Map(products.map((p) => [String(p._id), p]));

    const out = posts.map((p) => ({
      _id: p._id,
      imageUrl: p.imageUrl,
      permalink: p.permalink,
      caption: p.caption,
      tags: p.tags
        .map((t) => {
          const pr = byId.get(String(t.product));
          if (!pr) return null; // product deleted or hidden — drop the pin
          return {
            x: t.x,
            y: t.y,
            product: {
              _id: pr._id,
              name: pr.name,
              slug: pr.slug,
              price: pr.price,
              compareAtPrice: pr.compareAtPrice,
              image: productImage(pr),
              inStock: pr.trackInventory === false || pr.stock > 0,
              needsOptions: needsOptions(pr),
              // enough for the cart to add it without another request
              cartProduct: { _id: pr._id, name: pr.name, price: pr.price, images: pr.images, image: pr.image, stock: pr.stock, trackInventory: pr.trackInventory },
            },
          };
        })
        .filter(Boolean),
    }));

    res.set("Cache-Control", "public, max-age=60");
    res.json({ success: true, posts: out });
  } catch (e) {
    console.error("[Instagram] Feed failed:", e.message);
    res.status(500).json({ success: false, message: "Failed to load the feed" });
  }
});

// ── Admin ────────────────────────────────────────────────────────────────────

router.get("/admin/all", protect, isAdmin, async (_req, res) => {
  try {
    const posts = await InstagramPost.find({}).sort({ createdAt: -1 }).populate("tags.product", "name slug price images image").lean();
    res.json({
      success: true,
      posts: posts.map((p) => ({
        ...p,
        tags: p.tags.filter((t) => t.product).map((t) => ({ x: t.x, y: t.y, product: { _id: t.product._id, name: t.product.name, price: t.product.price, image: productImage(t.product) } })),
      })),
    });
  } catch (e) {
    res.status(500).json({ success: false, message: "Failed to load posts" });
  }
});

// Partial-match product search for the tag picker (typing "kun" finds "Kundan …")
router.get("/admin/products", protect, isAdmin, async (req, res) => {
  try {
    const q = String(req.query.q || "").trim().slice(0, 60);
    if (q.length < 2) return res.json({ success: true, products: [] });
    const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    const products = await Product.find({ isActive: { $ne: false }, $or: [{ name: re }, { category: re }, { subCategory: re }] })
      .select("name price category images image")
      .sort({ createdAt: -1 })
      .limit(10)
      .lean();
    res.json({ success: true, products: products.map((p) => ({ _id: p._id, name: p.name, price: p.price, category: p.category, image: productImage(p) })) });
  } catch (e) {
    res.status(500).json({ success: false, message: "Search failed" });
  }
});

router.post("/upload-image", protect, isAdmin, async (req, res) => {
  try {
    const { image } = req.body || {};
    if (typeof image !== "string" || !image.startsWith("data:image/")) {
      return res.status(400).json({ success: false, message: "Send the image as a base64 data URL" });
    }
    const r = await uploadBase64Image(image, {
      folder: "infinity_craft_instagram",
      transformation: [{ width: 1080, crop: "limit" }, { quality: "auto" }],
    });
    res.json({ success: true, image: { url: r.url, publicId: r.publicId } });
  } catch (e) {
    console.error("[Instagram] Upload failed:", e.message);
    res.status(500).json({ success: false, message: "Image upload failed" });
  }
});

router.post("/", protect, isAdmin, async (req, res) => {
  try {
    const { data, error } = await cleanInput(req.body);
    if (error) return res.status(400).json({ success: false, message: error });
    const post = await InstagramPost.create({ ...data, createdBy: req.user._id });
    res.status(201).json({ success: true, post });
  } catch (e) {
    console.error("[Instagram] Create failed:", e.message);
    res.status(500).json({ success: false, message: "Failed to save the post" });
  }
});

router.put("/:id", protect, isAdmin, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ success: false, message: "Invalid id" });
    const post = await InstagramPost.findById(req.params.id);
    if (!post) return res.status(404).json({ success: false, message: "Post not found" });
    const { data, error } = await cleanInput(req.body, { partial: true });
    if (error) return res.status(400).json({ success: false, message: error });

    const oldPublicId = post.imagePublicId;
    Object.assign(post, data);
    await post.save();
    if (oldPublicId && oldPublicId !== post.imagePublicId) deleteImage(oldPublicId).catch(() => {});
    res.json({ success: true, post });
  } catch (e) {
    console.error("[Instagram] Update failed:", e.message);
    res.status(500).json({ success: false, message: "Failed to update the post" });
  }
});

router.delete("/:id", protect, isAdmin, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ success: false, message: "Invalid id" });
    const post = await InstagramPost.findByIdAndDelete(req.params.id);
    if (!post) return res.status(404).json({ success: false, message: "Post not found" });
    if (post.imagePublicId) deleteImage(post.imagePublicId).catch(() => {});
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: "Failed to delete the post" });
  }
});

module.exports = router;
