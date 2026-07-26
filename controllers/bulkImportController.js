/**
 * Bulk product import + AI autofill controller.
 *
 * Routes (all admin-protected):
 *   GET  /api/admin/products/csv-template   — download blank CSV template
 *   POST /api/admin/products/bulk-import    — create products from parsed CSV rows
 *   POST /api/admin/products/ai-autofill    — Claude-generated description/tags/SEO
 */

const Anthropic = require("@anthropic-ai/sdk");
const { Parser }  = require("json2csv");
const Product  = require("../models/Product");
const Category = require("../models/Category");

const claude = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── CSV template download ─────────────────────────────────────────────────────
async function getCsvTemplate(req, res) {
  const fields = [
    "name", "category", "subCategory", "sku",
    "price", "compareAtPrice", "stock", "lowStockThreshold",
    "description", "tags",
    "weightInGrams", "estimatedDelivery",
    "isCustomizable", "processingDaysMin", "processingDaysMax",
    "seoTitle", "seoDescription", "seoKeywords",
  ];

  const sample = {
    name:             "Handmade Kundan Bangle",
    category:         "Jewellery",
    subCategory:      "Bangles",
    sku:              "KUN-001",
    price:            "499",
    compareAtPrice:   "699",
    stock:            "50",
    lowStockThreshold:"5",
    description:      "Beautiful handcrafted kundan bangle with traditional Rajasthani design. Perfect for festive occasions.",
    tags:             "kundan;bangle;traditional;handmade;festive",
    weightInGrams:    "50",
    estimatedDelivery:"5",
    isCustomizable:   "false",
    processingDaysMin:"",
    processingDaysMax:"",
    seoTitle:         "Handmade Kundan Bangle | Infinity Craft Space",
    seoDescription:   "Shop beautiful handcrafted kundan bangles. Traditional Rajasthani design, perfect for festivals.",
    seoKeywords:      "kundan bangle;handmade jewellery;traditional bangle",
  };

  try {
    const parser = new Parser({ fields });
    const csv = parser.parse([sample]);
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", 'attachment; filename="products_template.csv"');
    res.send(csv);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}

// ── Bulk import ───────────────────────────────────────────────────────────────
async function bulkImport(req, res) {
  const { rows } = req.body;

  if (!Array.isArray(rows) || !rows.length) {
    return res.status(400).json({ success: false, error: "No product rows provided" });
  }
  if (rows.length > 500) {
    return res.status(400).json({ success: false, error: "Maximum 500 products per import batch" });
  }

  const created = [];
  const failed  = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNum = i + 1;

    try {
      const name     = String(row.name || "").trim();
      const category = String(row.category || "").trim();
      const price    = parseFloat(row.price);

      if (!name)           { failed.push({ row: rowNum, name, error: "Name is required" }); continue; }
      if (!category)       { failed.push({ row: rowNum, name, error: "Category is required" }); continue; }
      if (isNaN(price) || price <= 0) { failed.push({ row: rowNum, name, error: "Valid price is required" }); continue; }

      const productData = {
        name,
        category,
        subCategory:       String(row.subCategory || "").trim() || undefined,
        sku:               String(row.sku || "").trim() || undefined,
        price,
        compareAtPrice:    row.compareAtPrice ? parseFloat(row.compareAtPrice) : undefined,
        description:       String(row.description || "").trim(),
        stock:             row.stock !== "" && row.stock != null ? parseInt(row.stock) : 0,
        lowStockThreshold: row.lowStockThreshold ? parseInt(row.lowStockThreshold) : 5,
        trackInventory:    true,
        estimatedDelivery: row.estimatedDelivery ? parseInt(row.estimatedDelivery) : 5,
        weightInGrams:     row.weightInGrams ? parseInt(row.weightInGrams) : 500,
        isCustomizable:    String(row.isCustomizable).toLowerCase() === "true",
        processingDaysMin: row.processingDaysMin ? parseInt(row.processingDaysMin) : 10,
        processingDaysMax: row.processingDaysMax ? parseInt(row.processingDaysMax) : 12,
        tags:              row.tags ? String(row.tags).split(";").map(t => t.trim()).filter(Boolean) : [],
        seoTitle:          String(row.seoTitle || "").trim() || undefined,
        seoDescription:    String(row.seoDescription || "").trim() || undefined,
        seoKeywords:       row.seoKeywords ? String(row.seoKeywords).split(";").map(k => k.trim()).filter(Boolean) : [],
        isActive:          true,
        createdAt:         new Date(),
        updatedAt:         new Date(),
      };

      const product = new Product(productData);
      await product.save();
      created.push({ row: rowNum, name, id: product._id, slug: product.slug });
    } catch (err) {
      const name = String(row.name || "").trim() || "(unnamed)";
      // Duplicate name/slug → readable message
      const msg = err.code === 11000
        ? `Duplicate product name: "${name}" already exists`
        : err.message;
      failed.push({ row: rowNum, name, error: msg });
    }
  }

  res.json({
    success: true,
    summary: { total: rows.length, created: created.length, failed: failed.length },
    created,
    failed,
  });
}

// ── AI autofill ───────────────────────────────────────────────────────────────
async function aiAutofill(req, res) {
  const { name, keywords, category } = req.body;

  if (!name?.trim()) {
    return res.status(400).json({ success: false, error: "Product name is required" });
  }

  // Fetch available categories to help Claude pick the right one
  let categoryContext = "";
  try {
    const cats = await Category.find({ isActive: true })
      .select("name subcategories")
      .lean();
    categoryContext = cats
      .map(c => `${c.name}: ${c.subcategories.filter(s => s.isActive !== false).map(s => s.name).join(", ")}`)
      .join("\n");
  } catch { /* non-fatal */ }

  const prompt = `You are a product content writer for "Infinity Craft Space" — an Indian handcraft and ethnic jewellery brand selling on their own website.

Generate product content for this item:
Product name: ${name.trim()}${keywords ? `\nMaterials / keywords: ${keywords.trim()}` : ""}${category ? `\nCategory hint: ${category.trim()}` : ""}

Available categories and subcategories:
${categoryContext || "Jewellery, Home Decor, Bags, Clothing"}

Respond ONLY with a single valid JSON object — no markdown fences, no commentary:
{
  "description": "Warm, detailed description in 3-4 sentences. Include materials, craftsmanship, cultural context. Write for customers who love handmade Indian ethnic products.",
  "tags": ["tag1","tag2","tag3","tag4","tag5"],
  "seoTitle": "SEO title, under 60 characters",
  "seoDescription": "Meta description 120-160 characters",
  "seoKeywords": ["keyword1","keyword2","keyword3","keyword4"],
  "suggestedCategory": "exact category name from the list above, or empty string",
  "suggestedSubCategory": "exact subcategory name from the list above, or empty string"
}`;

  try {
    const response = await claude.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 900,
      messages: [{ role: "user", content: prompt }],
    });

    const text = response.content[0]?.text || "{}";
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) {
      return res.status(500).json({ success: false, error: "AI returned an unparseable response" });
    }

    const data = JSON.parse(match[0]);
    res.json({ success: true, ...data });
  } catch (err) {
    console.error("[AI Autofill] Error:", err.message);
    res.status(500).json({ success: false, error: "AI generation failed. Please try again." });
  }
}

module.exports = { getCsvTemplate, bulkImport, aiAutofill };
