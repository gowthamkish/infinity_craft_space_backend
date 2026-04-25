/**
 * Dynamic Sitemap — GET /sitemap.xml
 *
 * Generates a real-time XML sitemap including all active products.
 * Register in server.js: app.use("/", require("./routes/sitemap"));
 *
 * Cached in-memory for 30 minutes to avoid hammering the DB on every crawl.
 */

const express = require("express");
const router = express.Router();
const Product = require("../models/Product");

const SITE_URL = process.env.SITE_URL || "https://www.infinitycraftspace.com";
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

let cachedXml = null;
let cacheExpiry = 0;

const STATIC_PAGES = [
  { loc: "/",                changefreq: "daily",   priority: "1.0" },
  { loc: "/products",        changefreq: "daily",   priority: "0.9" },
  { loc: "/login",           changefreq: "monthly", priority: "0.3" },
  { loc: "/register",        changefreq: "monthly", priority: "0.3" },
  { loc: "/contact",         changefreq: "monthly", priority: "0.4" },
  { loc: "/return-policy",   changefreq: "monthly", priority: "0.3" },
  { loc: "/terms",           changefreq: "monthly", priority: "0.3" },
];

function escapeXml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildXml(pages) {
  const urls = pages
    .map(({ loc, lastmod, changefreq, priority }) => {
      return [
        "  <url>",
        `    <loc>${escapeXml(`${SITE_URL}${loc}`)}</loc>`,
        lastmod ? `    <lastmod>${lastmod}</lastmod>` : "",
        `    <changefreq>${changefreq}</changefreq>`,
        `    <priority>${priority}</priority>`,
        "  </url>",
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>`;
}

router.get("/sitemap.xml", async (_req, res) => {
  res.setHeader("Content-Type", "application/xml; charset=utf-8");

  // Serve from cache if fresh
  if (cachedXml && Date.now() < cacheExpiry) {
    return res.send(cachedXml);
  }

  try {
    const products = await Product.find({ isActive: true })
      .select("_id slug updatedAt")
      .lean();

    const productPages = products.map((p) => ({
      loc: p.slug ? `/products/${p.slug}` : `/product/${p._id}`,
      lastmod: p.updatedAt ? new Date(p.updatedAt).toISOString().split("T")[0] : undefined,
      changefreq: "weekly",
      priority: "0.8",
    }));

    const xml = buildXml([...STATIC_PAGES, ...productPages]);

    cachedXml = xml;
    cacheExpiry = Date.now() + CACHE_TTL_MS;

    res.send(xml);
  } catch (err) {
    console.error("[Sitemap] Generation error:", err.message);
    // Fallback: return static pages only
    res.send(buildXml(STATIC_PAGES));
  }
});

module.exports = router;
