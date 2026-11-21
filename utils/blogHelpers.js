/** Shared blog helpers — used by the admin routes and by the blog agent. */
const BlogPost = require("../models/BlogPost");

const slugify = (s) =>
  String(s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 80)
    .replace(/^-|-$/g, "");

/** Unique slug: "my-post", then "my-post-2", "my-post-3"… */
async function uniqueSlug(base, excludeId = null) {
  const root = slugify(base) || "post";
  let candidate = root;
  for (let n = 2; n < 100; n++) {
    const clash = await BlogPost.findOne({ slug: candidate, ...(excludeId ? { _id: { $ne: excludeId } } : {}) }).select("_id").lean();
    if (!clash) return candidate;
    candidate = `${root}-${n}`;
  }
  return `${root}-${Date.now()}`;
}

const readingMinutes = (md) => Math.max(1, Math.round(String(md).split(/\s+/).filter(Boolean).length / 200));

const cleanTags = (tags) =>
  [...new Set((Array.isArray(tags) ? tags : String(tags || "").split(",")).map((t) => String(t).trim().toLowerCase()).filter(Boolean))].slice(0, 8);

module.exports = { slugify, uniqueSlug, readingMinutes, cleanTags };
