/**
 * AI-drafted abandoned-cart reminders. Customers' email addresses and phone numbers are NEVER sent to the AI —
 * only a first name and the names of the products left in the cart.
 */
const Anthropic = require("@anthropic-ai/sdk");
const Coupon = require("../models/Coupon");

const MODEL = process.env.MARKETING_AGENT_MODEL || "claude-opus-5-5";
let _client = null;
const client = () => (_client ||= new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY }));
const SITE = () => (process.env.SITE_URL || "https://infinitycraftspace.com").replace(/\/+$/, "").replace(/^(https?:\/\/)www\./i, "$1");

const SCHEMA = {
  type: "object",
  properties: {
    drafts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          cartId: { type: "string" },
          emailSubject: { type: "string", description: "Under 60 characters, friendly, names or hints at the product" },
          emailBody: { type: "string", description: "2–4 short sentences, plain text, starts with 'Hi <first name>,'" },
          whatsapp: { type: "string", description: "One short, warm message under 280 characters" },
        },
        required: ["cartId", "emailSubject", "emailBody", "whatsapp"],
        additionalProperties: false,
      },
    },
  },
  required: ["drafts"],
  additionalProperties: false,
};

const SYSTEM = `You write short, warm reminders for customers of Infinity Craft Space (Indian handmade jewellery & crafts) who left items in their cart.
Rules: use only the first name and the product names given; one gentle nudge, never pushy; no invented urgency ("only 2 left", "hurry"); no prices, discounts or free shipping unless a coupon code is given below, in which case mention exactly that code and nothing else about it; no claims about quality or materials; Indian English; no more than one emoji. Do not invent links — the owner adds the link. Each cart is different: refer to its products naturally rather than using one template.`;

/**
 * @param {Array} carts   from marketingSegments.abandonedCarts()
 * @param {{ couponCode?: string }} opts
 */
async function draftReminders(carts, { couponCode } = {}) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set on the server");
  let coupon = null;
  if (couponCode) {
    const now = new Date();
    coupon = await Coupon.findOne({ code: String(couponCode).toUpperCase(), isActive: true, validFrom: { $lte: now }, $or: [{ validUntil: { $gte: now } }, { validUntil: null }] }).lean();
    if (!coupon) throw new Error("That coupon doesn't exist or isn't active");
  }
  const input = carts.slice(0, 15).map((c) => ({ cartId: c.cartId, firstName: String(c.name || "there").split(/\s+/)[0], products: c.items.map((i) => `${i.name}${i.quantity > 1 ? ` ×${i.quantity}` : ""}`) }));
  let response;
  try {
    response = await client().beta.messages.create({
      model: MODEL, max_tokens: 8000, system: SYSTEM,
      messages: [{ role: "user", content: `${coupon ? `Mention this coupon code in each message: ${coupon.code}.` : "There is no coupon. Do not mention any discount."}\n\nCarts:\n${JSON.stringify(input)}` }],
      output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
      betas: ["server-side-fallback-2026-07-01"], fallbacks: "default",
    });
  } catch (err) {
    throw new Error(`Claude API error${err?.status ? ` ${err.status}` : ""}: ${err?.message || err}`);
  }
  if (response.stop_reason === "refusal") throw new Error("The model declined this request");
  if (response.stop_reason === "max_tokens") throw new Error("The answer was cut off — try fewer carts");
  let parsed;
  try { parsed = JSON.parse(response.content.find((b) => b.type === "text")?.text || ""); } catch { throw new Error("The AI returned an unreadable answer — please try again"); }

  const valid = new Set(input.map((i) => i.cartId));
  const BAD = /\b(only \d+ (left|remaining)|hurry|last chance|selling fast|best|guaranteed|100\s?%|free shipping)\b|₹|\brs\.?\s?\d|https?:\/\//i;
  const OFFER = /\b(discount|sale|coupon|promo|\d{1,2}\s?%\s*off|use code)\b/i;
  const drafts = [];
  for (const d of parsed.drafts || []) {
    if (!valid.has(d.cartId)) continue;
    const text = `${d.emailSubject} ${d.emailBody} ${d.whatsapp}`;
    const problems = [];
    if (BAD.test(text)) problems.push("contains a claim, price or link that wasn't allowed");
    if (!coupon && OFFER.test(text)) problems.push("mentions a discount that doesn't exist");
    if (coupon && /\b(?:code|coupon)\s*[:\-]?\s*([A-Z0-9]{4,20})\b/.exec(text)?.[1] && /\b(?:code|coupon)\s*[:\-]?\s*([A-Z0-9]{4,20})\b/.exec(text)[1] !== coupon.code) problems.push("uses the wrong coupon code");
    drafts.push({ cartId: d.cartId, emailSubject: String(d.emailSubject).trim().slice(0, 80), emailBody: String(d.emailBody).trim().slice(0, 900), whatsapp: String(d.whatsapp).trim().slice(0, 320), warnings: problems });
  }
  return { drafts, link: `${SITE()}/checkout`, couponCode: coupon?.code || null, model: MODEL, usage: { inputTokens: response.usage?.input_tokens || 0, outputTokens: response.usage?.output_tokens || 0 } };
}

module.exports = { draftReminders };
