/**
 * Voyage AI embedding helper.
 * Model: voyage-3-lite — 1024 dimensions, Anthropic-recommended.
 *
 * All product/policy text goes through buildProductText() before embedding
 * so the vector space is consistent between indexing and query time.
 */

const VoyageAI = require("voyageai").VoyageAIClient;

let client;
function getClient() {
  if (!client) {
    if (!process.env.VOYAGE_API_KEY) throw new Error("VOYAGE_API_KEY not set");
    client = new VoyageAI({ apiKey: process.env.VOYAGE_API_KEY });
  }
  return client;
}

const MODEL = "voyage-3-lite";
const DIMENSIONS = 1024;

/**
 * Embed a single text string. Returns a Float32 array (1024 dims).
 */
async function embedText(text) {
  const c = getClient();
  const res = await c.embed({ input: [text], model: MODEL });
  return res.data[0].embedding;
}

/**
 * Embed a batch of strings. Returns array of float arrays.
 * Voyage supports up to 128 texts per request.
 */
async function embedBatch(texts) {
  if (!texts.length) return [];
  const c = getClient();
  const res = await c.embed({ input: texts, model: MODEL });
  return res.data.map((d) => d.embedding);
}

/**
 * Build the canonical embedding text for a Product document.
 * Concatenates every descriptive field so queries like
 * "customizable kundan bangle under 500" hit the right results.
 */
function buildProductText(product) {
  const parts = [
    product.name,
    product.description,
    product.category,
    product.subCategory,
  ];

  if (product.tags?.length) parts.push(product.tags.join(" "));
  if (product.isCustomizable) parts.push("customizable made to order");
  if (product.colors?.length)
    parts.push(product.colors.map((c) => c.name).join(" "));
  if (product.variants?.length)
    parts.push(product.variants.map((v) => v.name).join(" "));
  if (product.seoKeywords?.length) parts.push(product.seoKeywords.join(" "));

  // Price band — helps "under ₹500" queries
  const price = product.price;
  if (price) parts.push(`price ${price} rupees`);

  return parts
    .filter(Boolean)
    .map((s) => String(s).replace(/<[^>]+>/g, " ").trim()) // strip HTML
    .join(". ");
}

module.exports = { embedText, embedBatch, buildProductText, DIMENSIONS };
