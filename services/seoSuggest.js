/**
 * AI helpers for the SEO agent:
 *   suggestForProduct — search title, meta description, keywords, alt text and a tidier description for ONE product
 *   answerQuestion    — answers the owner's questions ("which products aren't optimised?") from the latest audit
 *
 * The model only sees data we give it. Suggestions are checked on the server (lengths, no prices/offers, no
 * unprovable claims) and are never saved until the admin clicks Apply.
 */
const Anthropic = require("@anthropic-ai/sdk");
const Product = require("../models/Product");

const MODEL = process.env.SEO_AGENT_MODEL || "claude-opus-5-5";
let _client = null;
const client = () => (_client ||= new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY }));

const stripMd = (s) => String(s || "").replace(/[*_`>#]/g, "").replace(/\s+/g, " ").trim();
const wordCount = (s) => String(s || "").split(/\s+/).filter(Boolean).length;

// The model thinks before it answers and thinking counts toward max_tokens, so leave generous room
async function callClaude({ system, content, schema, maxTokens = 6000 }) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set on the server");
  let response;
  try {
    response = await client().beta.messages.create({
      model: MODEL,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content }],
      output_config: { effort: "low", ...(schema ? { format: { type: "json_schema", schema } } : {}) },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
  } catch (err) {
    throw new Error(`Claude API error${err?.status ? ` ${err.status}` : ""}: ${err?.message || err}`);
  }
  if (response.stop_reason === "refusal") throw new Error("The model declined this request");
  if (response.stop_reason === "max_tokens") throw new Error("The answer was cut off — please try again");
  const text = response.content.find((b) => b.type === "text")?.text || "";
  return { text, usage: { inputTokens: response.usage?.input_tokens || 0, outputTokens: response.usage?.output_tokens || 0 } };
}

// ── Product suggestions ──────────────────────────────────────────────────────

const SUGGEST_SCHEMA = {
  type: "object",
  properties: {
    seoTitle: { type: "string", description: "The page title shown on Google. 35–60 characters. Starts with what the product is; ends with ' | Infinity Craft Space' only if it fits." },
    seoDescription: { type: "string", description: "The grey summary under the title on Google. 120–155 characters, natural, no keyword stuffing." },
    keywords: { type: "array", items: { type: "string" }, description: "6 to 10 phrases an Indian shopper would type to find this (e.g. 'purple thread bangles online'), lowercase, most important first" },
    description: { type: "string", description: "A better product description, 50–110 words, based only on the product details and what is visible in the photos" },
    notes: { type: "string", description: "One or two sentences: what you changed and anything the owner should double-check (e.g. a material you couldn't confirm)" },
  },
  required: ["seoTitle", "seoDescription", "keywords", "description", "notes"],
  additionalProperties: false,
};

const SUGGEST_SYSTEM = `You are the SEO assistant for Infinity Craft Space, an Indian handmade jewellery and craft shop. You improve one product page at a time so it ranks better on Google India.

Honesty rules (strict):
- Use ONLY the product details given and what is visible in the photos. Never guess materials (gold, silver, real gemstones, silk), sizes, weights or origin — say "stone-style", "thread-wrapped", "metal-tone" if unsure.
- No prices, discounts, offers, shipping promises, reviews, awards or superlatives ("best", "No.1", "premium quality", "guaranteed", "100%", "authentic").
- Keep every fact already in the current description; you may reorganise and improve the wording but not invent anything.
Style: warm, clear Indian English ("colour", "jewellery"). Written for shoppers first, search engines second — no keyword stuffing.
Keywords: phrases shoppers actually type (product type + colour/occasion + "online"/"for wedding"/"India" where natural). You cannot measure search volume, so don't claim any.`;

const BAD_CLAIMS = /\b(best|no\.?\s?1|guarantee[d]?|100\s?%|authentic|premium quality|cheapest|lowest price|pure (gold|silver)|real (gold|silver|diamond)|certified)\b/i;

/** Server-side checks on what the model returned. Returns a list of problems. */
function checkSuggestion(s) {
  const p = [];
  if (s.seoTitle.length < 20 || s.seoTitle.length > 65) p.push(`seoTitle must be 20–65 characters (it is ${s.seoTitle.length})`);
  if (s.seoDescription.length < 100 || s.seoDescription.length > 165) p.push(`seoDescription must be 100–165 characters (it is ${s.seoDescription.length})`);
  if (s.keywords.length < 5 || s.keywords.length > 12) p.push("give 5–10 keywords");
  const w = wordCount(s.description);
  if (w < 35 || w > 140) p.push(`description has ${w} words; write 50–110`);
  const all = `${s.seoTitle} ${s.seoDescription} ${s.description}`;
  if (/₹|\brs\.?\s?\d|\brupees?\b/i.test(all)) p.push("do not mention prices");
  if (/\b(free shipping|discount|sale|offer|coupon|% off)\b/i.test(all)) p.push("do not mention offers or discounts");
  if (BAD_CLAIMS.test(all)) p.push(`remove unprovable claims (${all.match(BAD_CLAIMS)[0]})`);
  return p;
}

const imageUrlsOf = (p) => (p.images?.length ? p.images : p.image?.url ? [p.image] : []).map((i) => i.url).filter(Boolean).slice(0, 2);
const thumb = (url) => url.replace(/\/upload\/(?!.*\/upload\/)/, "/upload/w_1000,c_limit,q_auto,f_jpg/");

async function suggestForProduct(productId) {
  const p = await Product.findById(productId).lean();
  if (!p) throw new Error("Product not found");

  const facts = [
    `Name: ${p.name}`,
    `Category: ${p.category}${p.subCategory ? ` › ${p.subCategory}` : ""}`,
    p.isCustomizable ? "Can be personalised/customised." : null,
    p.colors?.length ? `Colour options: ${p.colors.map((c) => c.name).filter(Boolean).join(", ")}` : null,
    `Current description: ${stripMd(p.description) || "(none)"}`,
    p.seoTitle ? `Current search title: ${p.seoTitle}` : null,
    p.seoDescription ? `Current search summary: ${p.seoDescription}` : null,
    p.seoKeywords?.length ? `Current keywords: ${p.seoKeywords.join(", ")}` : null,
  ].filter(Boolean).join("\n");

  const content = [
    ...imageUrlsOf(p).map((url) => ({ type: "image", source: { type: "url", url: /cloudinary\.com/.test(url) ? thumb(url) : url } })),
    { type: "text", text: `Improve the SEO for this product.\n\n${facts}` },
  ];

  let problems = [];
  let usage = { inputTokens: 0, outputTokens: 0 };
  for (let attempt = 1; attempt <= 2; attempt++) {
    const retry = problems.length ? `\n\nYour previous answer had problems. Fix them: ${problems.join("; ")}.` : "";
    const { text, usage: u } = await callClaude({ system: SUGGEST_SYSTEM, content: [...content.slice(0, -1), { ...content[content.length - 1], text: content[content.length - 1].text + retry }], schema: SUGGEST_SCHEMA });
    usage = { inputTokens: usage.inputTokens + u.inputTokens, outputTokens: usage.outputTokens + u.outputTokens };
    let s;
    try { s = JSON.parse(text); } catch { problems = ["the answer was not valid JSON"]; continue; }
    s = {
      seoTitle: String(s.seoTitle || "").trim(),
      seoDescription: String(s.seoDescription || "").trim(),
      keywords: [...new Set((s.keywords || []).map((k) => String(k).toLowerCase().trim().slice(0, 60)).filter(Boolean))].slice(0, 10),
      description: String(s.description || "").trim(),
      notes: String(s.notes || "").trim().slice(0, 300),
    };
    problems = checkSuggestion(s);
    if (problems.length === 0 || attempt === 2) {
      return { suggestion: s, warnings: problems, product: { _id: p._id, name: p.name, currentDescription: p.description || "" }, usage, model: MODEL };
    }
  }
  // Both attempts produced unreadable output
  throw new Error("The AI didn't return a usable suggestion — please try again");
}

// ── Ask the agent ────────────────────────────────────────────────────────────

const ASK_SYSTEM = `You are the SEO & website-health assistant for Infinity Craft Space. The owner asks questions about the shop's Google/search health. You are given the latest audit results as JSON.

Rules:
- Answer ONLY from the audit data. If the data doesn't cover the question, say so and suggest running a new audit. Never invent products, numbers or problems.
- Be concrete: name the products and the exact problem, and say what to do. Put the most valuable fix first.
- Short, plain language for a shop owner who is not technical. Use short paragraphs or simple "-" lists. No markdown headings or bold.
- If they ask for products "not optimised", list the worst ones (name + what's missing) and how many more there are.
- You cannot measure Google rankings or search volume — don't claim to.`;

function auditContext(report) {
  const lines = (report.productIssues || []).slice(0, 80).map((p) => `${p.name} (score ${p.score}): ${p.issues.map((i) => i.code).join(", ")}`);
  return JSON.stringify({
    scores: report.scores,
    counts: report.counts,
    productsWithNoIssues: report.productsClean,
    topActions: report.actions,
    siteChecks: (report.indexingChecks || []).map((c) => ({ status: c.status, title: c.title, detail: c.detail, fix: c.fix })),
    performance: (report.performance?.checks || []).map((c) => ({ status: c.status, title: c.title })),
    linkProblems: (report.linkIssues || []).slice(0, 20).map((i) => `${i.where}: ${i.message}`),
    worstProducts: lines,
    issueCodeMeaning: { no_description: "no description", thin_description: "description under 20 words", no_images: "no photo", no_keywords: "no search keywords", no_meta_description: "no search-result summary", duplicate_name: "same name as another product", duplicate_description: "same description as another product", long_title: "title too long for Google", single_image: "only one photo", no_price: "no price", no_slug: "no friendly URL", short_name: "very short name", long_meta_description: "search summary too long" },
  });
}

async function answerQuestion(question, report) {
  const { text, usage } = await callClaude({
    system: ASK_SYSTEM,
    content: `Latest audit data:\n${auditContext(report)}\n\nOwner's question: ${String(question).slice(0, 500)}`,
    maxTokens: 8000,
  });
  return { answer: text.trim(), usage, model: MODEL };
}

module.exports = { suggestForProduct, answerQuestion, checkSuggestion, MODEL };
