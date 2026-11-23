/**
 * Crawler-ready HTML — GEO/AEO for a client-rendered React app.
 *
 * AI crawlers (GPTBot, PerplexityBot, ClaudeBot…) and many social bots do not run JavaScript, so
 * they only see an empty shell on the SPA. These routes return plain, complete HTML (content +
 * JSON-LD) for the same pages:
 *
 *   GET /prerender/home
 *   GET /prerender/product/:idOrSlug
 *
 * Wire them up by routing bot user-agents on the frontend host to these URLs (see README note
 * in the answer / hosting config). Human visitors are never sent here.
 */
const express = require("express");
const mongoose = require("mongoose");
const Product = require("../models/Product");
const Category = require("../models/Category");
const { buildProductFaq, faqJsonLd } = require("../utils/productFaq");
const router = express.Router();

// The pages declare https://infinitycraftspace.com (no "www") as their canonical address, so every server-built URL must
// use it too — even if a setting on the host says www.
const canonicalSite = (v) => String(v || "https://infinitycraftspace.com").replace(/\/+$/, "").replace(/^(https?:\/\/)www\./i, "$1");
const SITE = canonicalSite(process.env.SITE_URL); // (FRONTEND_URL is for CORS/emails and may legitimately be www)
const SITE_NAME = "Infinity Craft Space";
const TTL = 15 * 60 * 1000;
const cache = new Map(); // url → { html, exp }

const esc = (s) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const jsonLd = (obj) => `<script type="application/ld+json">${JSON.stringify(obj).replace(/</g, "\\u003c")}</script>`;
const productPath = (p) => `/product/${p.slug || p._id}`;
const imageOf = (p) => p.images?.[0]?.url || p.image?.url || `${SITE}/ICS_Logo.jpeg`;
const trunc = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

const organization = {
  "@type": "Organization",
  "@id": `${SITE}/#organization`,
  name: SITE_NAME,
  url: SITE,
  logo: `${SITE}/ICS_Logo.jpeg`,
  sameAs: ["https://www.instagram.com/infinity_craft_space", "https://facebook.com/infinitycraftspace"],
};

function page({ title, description, canonical, image, ogType = "website", body, schema }) {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(trunc(title, 70))}</title>
<meta name="description" content="${esc(trunc(description, 160))}">
<link rel="canonical" href="${esc(canonical)}">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(trunc(description, 200))}">
<meta property="og:type" content="${ogType}"><meta property="og:url" content="${esc(canonical)}">
<meta property="og:image" content="${esc(image)}"><meta property="og:site_name" content="${SITE_NAME}">
${jsonLd({ "@context": "https://schema.org", "@graph": schema })}
</head><body>
${body}
</body></html>`;
}

function productSchema(p, url) {
  const sizes = p.showStringSizePicker && p.stringSizes?.length ? [...p.stringSizes].sort((a, b) => a.inches - b.inches) : [];
  const inStock = p.trackInventory === false || p.stock > 0;
  const availability = `https://schema.org/${inStock ? "InStock" : "OutOfStock"}`;
  const seller = { "@id": `${SITE}/#organization` };
  const offers = sizes.length
    ? {
        "@type": "AggregateOffer",
        priceCurrency: "INR",
        lowPrice: Math.min(...sizes.map((s) => s.price)),
        highPrice: Math.max(...sizes.map((s) => s.price)),
        offerCount: sizes.length,
        availability,
        seller,
        offers: sizes.map((s) => ({ "@type": "Offer", name: `${s.inches} inch`, price: s.price, priceCurrency: "INR", availability, url, seller })),
      }
    : { "@type": "Offer", price: p.price, priceCurrency: "INR", availability, url, seller };
  return {
    "@type": "Product",
    "@id": `${url}#product`,
    name: p.name,
    description: p.description || `${p.name} from ${SITE_NAME}`,
    image: (p.images?.length ? p.images.map((i) => i.url) : [imageOf(p)]).filter(Boolean),
    sku: p.sku || String(p._id),
    category: [p.category, p.subCategory].filter(Boolean).join(" > "),
    brand: { "@type": "Brand", name: SITE_NAME },
    offers,
    ...(p.ratingCount > 0 ? { aggregateRating: { "@type": "AggregateRating", ratingValue: p.averageRating, reviewCount: p.ratingCount, bestRating: 5, worstRating: 1 } } : {}),
  };
}

async function findProduct(idOrSlug) {
  const query = mongoose.Types.ObjectId.isValid(idOrSlug) ? { _id: idOrSlug } : { slug: idOrSlug };
  return Product.findOne({ ...query, isActive: { $ne: false } }).lean();
}

function send(res, key, html) {
  cache.set(key, { html, exp: Date.now() + TTL });
  res.set("Content-Type", "text/html; charset=utf-8").set("Cache-Control", "public, max-age=900").send(html);
}
const fromCache = (key) => {
  const hit = cache.get(key);
  return hit && hit.exp > Date.now() ? hit.html : null;
};

router.get("/prerender/product/:idOrSlug", async (req, res) => {
  try {
    const key = `p:${req.params.idOrSlug}`;
    const hit = fromCache(key);
    if (hit) return res.set("Content-Type", "text/html; charset=utf-8").send(hit);

    const p = await findProduct(req.params.idOrSlug);
    if (!p) return res.status(404).type("html").send("<!doctype html><title>Product not found</title><h1>Product not found</h1>");

    const url = `${SITE}${productPath(p)}`;
    const faq = buildProductFaq(p);
    const sizes = p.showStringSizePicker && p.stringSizes?.length ? [...p.stringSizes].sort((a, b) => a.inches - b.inches) : [];
    const priceText = sizes.length
      ? `From ₹${Math.min(...sizes.map((s) => s.price)).toLocaleString("en-IN")}`
      : `₹${Number(p.price).toLocaleString("en-IN")}`;
    const desc = (p.seoDescription || p.description || `${p.name} — handcrafted at ${SITE_NAME}, shipped across India.`).replace(/\s+/g, " ");

    const schema = [
      organization,
      productSchema(p, url),
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { name: "Home", item: SITE },
          { name: "Products", item: `${SITE}/products` },
          ...(p.category ? [{ name: p.category, item: `${SITE}/products?category=${encodeURIComponent(p.category)}` }] : []),
          { name: p.name, item: url },
        ].map((c, i) => ({ "@type": "ListItem", position: i + 1, ...c })),
      },
      faqJsonLd(faq),
    ].filter(Boolean);

    const body = `<header><a href="${SITE}">${SITE_NAME}</a></header>
<main>
<nav aria-label="Breadcrumb"><a href="${SITE}">Home</a> › <a href="${SITE}/products">Products</a>${p.category ? ` › ${esc(p.category)}` : ""}</nav>
<article>
<h1>${esc(p.name)}</h1>
<img src="${esc(imageOf(p))}" alt="${esc(p.name)}" width="600">
<p><strong>${esc(priceText)}</strong> · ${p.trackInventory === false || p.stock > 0 ? "In stock" : "Out of stock"}</p>
<p>${esc(p.description || "")}</p>
${sizes.length ? `<h2>Available lengths and prices</h2><ul>${sizes.map((s) => `<li>${s.inches} inch — ₹${s.price.toLocaleString("en-IN")}</li>`).join("")}</ul>` : ""}
<p>Category: ${esc([p.category, p.subCategory].filter(Boolean).join(" › "))}</p>
${faq.length ? `<h2>Frequently asked questions</h2>${faq.map((f) => `<h3>${esc(f.q)}</h3><p>${esc(f.a)}</p>`).join("")}` : ""}
<p><a href="${esc(url)}">View ${esc(p.name)} on ${SITE_NAME}</a></p>
</article></main>`;

    send(res, key, page({ title: `${p.name} - ${SITE_NAME}`, description: desc, canonical: url, image: imageOf(p), ogType: "product", body, schema }));
  } catch (err) {
    console.error("[seo] product prerender failed:", err.message);
    res.status(500).type("text").send("Error");
  }
});

router.get("/prerender/home", async (_req, res) => {
  try {
    const hit = fromCache("home");
    if (hit) return res.set("Content-Type", "text/html; charset=utf-8").send(hit);

    const [products, categories] = await Promise.all([
      Product.find({ isActive: { $ne: false } }).sort({ averageRating: -1, createdAt: -1 }).limit(60).select("name slug price category showStringSizePicker stringSizes").lean(),
      Category.find({}).select("name description").lean().catch(() => []),
    ]);
    const description =
      "Infinity Craft Space is an Indian online store for handcrafted gifts, custom resin art, jewellery, artificial flower hair accessories, embroidery hoops and craft supplies, delivered across India.";
    const schema = [
      organization,
      { "@type": "WebSite", "@id": `${SITE}/#website`, url: SITE, name: SITE_NAME, publisher: { "@id": `${SITE}/#organization` },
        potentialAction: { "@type": "SearchAction", target: `${SITE}/products?q={search_term_string}`, "query-input": "required name=search_term_string" } },
      { "@type": "ItemList", itemListElement: products.map((p, i) => ({ "@type": "ListItem", position: i + 1, url: `${SITE}${productPath(p)}`, name: p.name })) },
    ];
    const body = `<header><h1>${SITE_NAME} — Handcrafted Gifts &amp; Craft Supplies</h1></header><main>
<p>${esc(description)}</p>
${categories.length ? `<h2>Categories</h2><ul>${categories.map((c) => `<li><a href="${SITE}/products?category=${encodeURIComponent(c.name)}">${esc(c.name)}</a>${c.description ? ` — ${esc(c.description)}` : ""}</li>`).join("")}</ul>` : ""}
<h2>Popular products</h2><ul>${products.map((p) => `<li><a href="${SITE}${productPath(p)}">${esc(p.name)}</a> — ${p.showStringSizePicker && p.stringSizes?.length ? "from " : ""}₹${Number(p.price).toLocaleString("en-IN")}</li>`).join("")}</ul>
</main>`;
    send(res, "home", page({ title: `${SITE_NAME} — Handcrafted Gifts & Craft Supplies`, description, canonical: SITE, image: `${SITE}/ICS_Logo.jpeg`, body, schema }));
  } catch (err) {
    console.error("[seo] home prerender failed:", err.message);
    res.status(500).type("text").send("Error");
  }
});

module.exports = router;
