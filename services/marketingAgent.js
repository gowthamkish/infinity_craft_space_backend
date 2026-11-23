/**
 * Marketing agent — turns a one-line brief ("Prepare a Diwali promotion for handcrafted gift collections") into a
 * ready-to-review campaign package: strategy + timing, Instagram posts, WhatsApp messages, an email draft, and who
 * to send it to.
 *
 * It is a tool-using agent (it looks at the catalog, real coupons, the calendar and audience sizes before writing),
 * and the server checks everything it submits: only real products and coupons, no invented prices or discounts, no
 * unprovable claims, no off-site links, channel length limits. Nothing is ever sent to customers by this agent.
 */
const Anthropic = require("@anthropic-ai/sdk");
const Product = require("../models/Product");
const Category = require("../models/Category");
const Coupon = require("../models/Coupon");
const MarketingCampaign = require("../models/MarketingCampaign");
const { segmentSummary } = require("./marketingSegments");
const { OFFER_START, OFFER_END, FREE_SHIPPING_ABOVE } = require("../utils/launchOffer");

const MODEL = process.env.MARKETING_AGENT_MODEL || "claude-opus-5-5";
const MAX_TURNS = 14;
const SITE = () => (process.env.SITE_URL || "https://infinitycraftspace.com").replace(/\/+$/, "").replace(/^(https?:\/\/)www\./i, "$1");

const SYSTEM_PROMPT = `You are the marketing manager for Infinity Craft Space, an Indian handcraft and jewellery shop based in Bangalore that ships across India. The owner gives you a one-line brief. You produce a complete, honest, ready-to-review campaign.

How you work
1. Call get_store_facts and get_occasions first, then list_categories and search_products several times to find the right real products. Call list_coupons to see which offers really exist, list_recent_campaigns to avoid repeating, and get_audience to see who could receive it.
2. Write the campaign, then call submit_campaign. If it returns errors, fix exactly those and submit again.

If the brief names an occasion whose date has already passed this year (check get_occasions and today's date), say so in dateNote and pivot sensibly — e.g. the next relevant occasion or the current wedding/gifting season — instead of pretending it is still ahead.

Honesty rules (strict)
- Only feature products returned by search_products. Describe them only with what the tool says; never invent materials, sizes, origin or features.
- Mention a rupee amount only if it is a real product price from a tool result, or the offer details from list_coupons / get_store_facts.
- Offers: you may promote ONLY a coupon returned by list_coupons (set offer.couponCode) or the free-shipping offer if get_store_facts says it is active. Otherwise offer.couponCode must be null and you must not mention any discount, sale, coupon, "% off" or free shipping anywhere.
- No invented urgency ("only 3 left", "selling fast", "last chance") and no superlatives or unprovable claims ("best", "No.1", "guaranteed", "100%", "authentic", "pure gold").
- No reviews, testimonials, awards or sales numbers. No claims about your artisans or workshop beyond tool facts.
- Never explain how products are made (no step-by-step process, no DIY).
- Festival and lunar-calendar dates can be uncertain: say "around <month>" and set dateNote asking the owner to confirm the exact date.

Channel rules
- Instagram: 3 to 5 posts of mixed formats (feed, carousel, reel, story). First line is the hook. Warm, visual, Indian English. 5 to 12 relevant hashtags (without the # symbol in the list). Include a clear visualIdea the owner can shoot or pick from their photos.
- WhatsApp: a short broadcast (under 700 characters) that sounds like a person, one link, a few emojis at most; a separate one-line status; and a follow-up for people who didn't reply. Remind that it is only for customers who agreed to hear from the shop.
- Email: a specific subject (under 70 characters), a preheader, 2 to 5 short paragraphs, ONE call-to-action button linking to /products or one /product/<slug> you looked up, and 2 to 4 featured products. No emoji overload.
- Links in WhatsApp text must use the website address from get_store_facts.
- Audience: choose segments only from get_audience, each with a one-sentence reason. Prefer people who have opted in.`;

const TOOLS = [
  { name: "get_store_facts", description: "Verified facts about the shop, today's date, and any shipping offer that is active right now. Call first.", input_schema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "get_occasions", description: "Today's date and the next occurrence of fixed-date occasions (Valentine's, Mother's Day, Christmas…), plus notes on festivals whose dates move.", input_schema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "list_categories", description: "The shop's active product categories and subcategories.", input_schema: { type: "object", properties: {}, additionalProperties: false } },
  {
    name: "search_products",
    description: "Search the live catalog. Returns up to 8 active products with id, name, price in rupees, category, description, stock and url. Leave query empty to browse a category.",
    input_schema: { type: "object", properties: { query: { type: "string" }, category: { type: "string", description: "Exact category name from list_categories (optional)" } }, additionalProperties: false },
  },
  { name: "list_coupons", description: "Coupons that really exist and are valid today. These are the ONLY discounts you may promote.", input_schema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "list_recent_campaigns", description: "Titles of recent campaigns, to avoid repeating one.", input_schema: { type: "object", properties: {}, additionalProperties: false } },
  {
    name: "get_audience",
    description: "How many customers fall in each segment for the categories you plan to feature, and how many of them have opted in to marketing emails.",
    input_schema: { type: "object", properties: { categories: { type: "array", items: { type: "string" } } }, additionalProperties: false },
  },
  {
    name: "submit_campaign",
    description: "Submit the finished campaign. The server validates it; on an error, fix the problem and submit again.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        goal: { type: "string", description: "What this campaign should achieve, one sentence" },
        summary: { type: "string", description: "The idea and why it should work, 2–4 sentences" },
        timing: { type: "string", description: "A suggested schedule, e.g. which day to post what" },
        dateNote: { type: "string", description: "Anything about dates the owner must confirm; empty string if none" },
        featuredProductIds: { type: "array", items: { type: "string" } },
        instagram: {
          type: "array",
          items: {
            type: "object",
            properties: {
              format: { type: "string", enum: ["feed", "carousel", "reel", "story"] },
              hook: { type: "string" },
              caption: { type: "string" },
              hashtags: { type: "array", items: { type: "string" } },
              visualIdea: { type: "string" },
              productIds: { type: "array", items: { type: "string" } },
            },
            required: ["format", "hook", "caption", "hashtags", "visualIdea", "productIds"],
            additionalProperties: false,
          },
        },
        whatsapp: {
          type: "object",
          properties: { broadcast: { type: "string" }, status: { type: "string" }, followUp: { type: "string" } },
          required: ["broadcast", "status", "followUp"],
          additionalProperties: false,
        },
        email: {
          type: "object",
          properties: {
            subject: { type: "string" },
            preheader: { type: "string" },
            paragraphs: { type: "array", items: { type: "string" } },
            ctaLabel: { type: "string" },
            ctaUrl: { type: "string", description: "/products or /product/<slug>" },
            productIds: { type: "array", items: { type: "string" } },
          },
          required: ["subject", "preheader", "paragraphs", "ctaLabel", "ctaUrl", "productIds"],
          additionalProperties: false,
        },
        audience: {
          type: "array",
          items: { type: "object", properties: { segmentId: { type: "string" }, why: { type: "string" } }, required: ["segmentId", "why"], additionalProperties: false },
        },
        offer: {
          type: "object",
          properties: { couponCode: { type: ["string", "null"] }, freeShipping: { type: "boolean" }, note: { type: "string" } },
          required: ["couponCode", "freeShipping", "note"],
          additionalProperties: false,
        },
      },
      required: ["title", "goal", "summary", "timing", "dateNote", "featuredProductIds", "instagram", "whatsapp", "email", "audience", "offer"],
      additionalProperties: false,
    },
  },
];

let _client = null;
const client = () => (_client ||= new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY }));

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const productUrl = (p) => `/product/${p.slug || p._id}`;
const productImage = (p) => p.images?.find((i) => i?.isPrimary && i.url)?.url || p.images?.find((i) => i?.url)?.url || p.image?.url || null;
const istNow = () => new Date(Date.now() + 5.5 * 3600 * 1000);
const dateText = (d) => d.toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

// ── Calendar ─────────────────────────────────────────────────────────────────

function nthWeekday(year, month, weekday, n) { // month 0-11, weekday 0=Sun
  const first = new Date(Date.UTC(year, month, 1)).getUTCDay();
  return new Date(Date.UTC(year, month, 1 + ((weekday - first + 7) % 7) + (n - 1) * 7));
}
const FIXED = [
  ["Makar Sankranti / Pongal (around)", (y) => new Date(Date.UTC(y, 0, 14))],
  ["Republic Day", (y) => new Date(Date.UTC(y, 0, 26))],
  ["Valentine's Day", (y) => new Date(Date.UTC(y, 1, 14))],
  ["International Women's Day", (y) => new Date(Date.UTC(y, 2, 8))],
  ["Mother's Day", (y) => nthWeekday(y, 4, 0, 2)],
  ["Father's Day", (y) => nthWeekday(y, 5, 0, 3)],
  ["Friendship Day", (y) => nthWeekday(y, 7, 0, 1)],
  ["Independence Day", (y) => new Date(Date.UTC(y, 7, 15))],
  ["Teachers' Day", (y) => new Date(Date.UTC(y, 8, 5))],
  ["Children's Day", (y) => new Date(Date.UTC(y, 10, 14))],
  ["Christmas", (y) => new Date(Date.UTC(y, 11, 25))],
  ["New Year", (y) => new Date(Date.UTC(y + 1, 0, 1))],
];

function occasions(now = istNow()) {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const list = FIXED.map(([name, f]) => {
    let d = f(today.getUTCFullYear());
    if (d < today) d = f(today.getUTCFullYear() + 1);
    return { name, date: dateText(d), daysAway: Math.round((d - today) / 864e5), _d: d };
  }).sort((a, b) => a._d - b._d).map(({ _d, ...o }) => o);
  return {
    today: dateText(today),
    fixedDateOccasions: list,
    movingFestivals: "Diwali, Dhanteras, Navratri/Dussehra, Raksha Bandhan, Karva Chauth, Ganesh Chaturthi, Onam, Eid and Holi follow lunar calendars. You may name them, but say 'around <month>' and tell the owner (dateNote) to confirm the exact date. Do not state precise dates for them.",
    seasons: "Main wedding seasons in India run roughly November–February and April–June. Gifting peaks around Diwali (Oct–Nov), Christmas/New Year, Raksha Bandhan (Aug) and Valentine's.",
  };
}

// ── Tools ────────────────────────────────────────────────────────────────────

function storeFacts() {
  const now = Date.now();
  const active = now >= OFFER_START.getTime() && now < OFFER_END.getTime();
  return {
    brand: "Infinity Craft Space",
    location: "Bangalore, Karnataka, India",
    ships_to: "All over India",
    payment: "Online payment only (UPI, cards, net banking). Cash on delivery is NOT available.",
    website: SITE(),
    customisation: "Some products can be personalised; the product page says so.",
    freeShippingOffer: active
      ? { active: true, rule: `FREE shipping on orders above ₹${FREE_SHIPPING_ABOVE}`, validUntil: dateText(new Date(OFFER_END.getTime() + 5.5 * 3600 * 1000)) }
      : { active: false },
    today: dateText(istNow()),
  };
}

async function searchProducts({ query, category } = {}, ctx) {
  const filter = { isActive: { $ne: false } };
  if (category) filter.category = new RegExp(`^${escapeRegex(category)}$`, "i");
  const q = String(query || "").trim().slice(0, 80);
  if (q) {
    const words = q.split(/\s+/).filter(Boolean).slice(0, 5).map((w) => new RegExp(escapeRegex(w), "i"));
    filter.$and = words.map((re) => ({ $or: [{ name: re }, { description: re }, { category: re }, { subCategory: re }] }));
  }
  const products = await Product.find(filter).select("name slug price description category subCategory stock trackInventory isCustomizable images image").sort({ createdAt: -1 }).limit(8).lean();
  for (const p of products) { ctx.products.set(String(p._id), p); ctx.prices.add(Math.round(p.price)); }
  return {
    count: products.length,
    products: products.map((p) => ({ id: String(p._id), name: p.name, price_rupees: p.price, category: p.category, subcategory: p.subCategory, description: String(p.description || "").replace(/\s+/g, " ").slice(0, 300), in_stock: p.trackInventory === false || p.stock > 0, customisable: Boolean(p.isCustomizable), url: productUrl(p) })),
  };
}

async function listCoupons(ctx) {
  const now = new Date();
  const coupons = await Coupon.find({ isActive: true, validFrom: { $lte: now }, $or: [{ validUntil: { $gte: now } }, { validUntil: null }] }).lean();
  const usable = coupons.filter((c) => !c.maxUses || c.useCount < c.maxUses);
  for (const c of usable) { ctx.coupons.set(c.code, c); for (const n of [c.discountValue, c.maxDiscount, c.minCartValue]) if (n) ctx.allowedAmounts.add(Math.round(n)); }
  return {
    count: usable.length,
    note: usable.length ? "These are the only discounts you may promote." : "There are no active coupons. Do not mention any discount, sale or coupon.",
    coupons: usable.map((c) => ({ code: c.code, description: c.description || "", discount: c.discountType === "percentage" ? `${c.discountValue}% off${c.maxDiscount ? ` (up to ₹${c.maxDiscount})` : ""}` : `₹${c.discountValue} off`, minimumOrder: c.minCartValue || 0, validUntil: c.validUntil ? dateText(new Date(c.validUntil.getTime() + 5.5 * 3600 * 1000)) : "no end date" })),
  };
}

async function recentCampaigns() {
  const rows = await MarketingCampaign.find({ status: "succeeded" }).sort({ createdAt: -1 }).limit(15).select("brief campaign.title").lean();
  return { campaigns: rows.map((r) => ({ title: r.campaign?.title, brief: r.brief })) };
}

async function audience({ categories = [] } = {}, ctx) {
  const cats = (Array.isArray(categories) ? categories : []).map(String).slice(0, 6);
  const segs = await segmentSummary({ categories: cats });
  ctx.segmentIds = new Set(segs.map((s) => s.id));
  ctx.audienceCategories = cats;
  return { note: "'reachable' = people who have opted in to marketing emails. Prefer segments with reachable people.", segments: segs };
}

// ── Validation ───────────────────────────────────────────────────────────────

const BAD_CLAIMS = /\b(best|no\.?\s?1|guarantee[d]?|100\s?%|authentic|premium quality|cheapest|lowest price|pure (gold|silver)|real (gold|silver|diamond)|certified|award[- ]winning)\b/i;
const FAKE_URGENCY = /\b(only \d+ (left|pieces?|remaining)|selling fast|last chance|almost gone|few (pieces|left)|hurry)\b/i;
const MAKING = /step[- ]by[- ]step|\bdiy\b|do[- ]it[- ]yourself|\btutorial\b|how (?:it|they)(?:'s| is| are) made|how to make/i;
const OFFER_WORDS = /\b(discount|sale|coupon|promo(?:tion)? code|use code|\d{1,2}\s?%\s*off|off your|flat \d+)\b/i;
const str = (v) => String(v ?? "").trim();

/** Validates & cleans the submitted campaign. Returns { problems, campaign }. */
function cleanCampaign(input, ctx) {
  const p = [];
  const c = {
    title: str(input.title), goal: str(input.goal), summary: str(input.summary), timing: str(input.timing), dateNote: str(input.dateNote),
    featuredProductIds: [...new Set((input.featuredProductIds || []).map(String))],
    instagram: (input.instagram || []).map((i) => ({ format: i.format, hook: str(i.hook), caption: str(i.caption), hashtags: [...new Set((i.hashtags || []).map((h) => str(h).replace(/^#+/, "").replace(/\s+/g, "")).filter(Boolean))], visualIdea: str(i.visualIdea), productIds: [...new Set((i.productIds || []).map(String))] })),
    whatsapp: { broadcast: str(input.whatsapp?.broadcast), status: str(input.whatsapp?.status), followUp: str(input.whatsapp?.followUp) },
    email: { subject: str(input.email?.subject), preheader: str(input.email?.preheader), paragraphs: (input.email?.paragraphs || []).map(str).filter(Boolean), ctaLabel: str(input.email?.ctaLabel), ctaUrl: str(input.email?.ctaUrl), productIds: [...new Set((input.email?.productIds || []).map(String))] },
    audience: (input.audience || []).map((a) => ({ segmentId: str(a.segmentId), why: str(a.why) })),
    offer: { couponCode: input.offer?.couponCode ? str(input.offer.couponCode).toUpperCase() : null, freeShipping: Boolean(input.offer?.freeShipping), note: str(input.offer?.note) },
  };

  if (c.title.length < 8 || c.title.length > 90) p.push("title must be 8–90 characters");
  if (c.summary.length < 60 || c.summary.length > 700) p.push("summary must be 60–700 characters");
  if (!c.goal || !c.timing) p.push("goal and timing are required");

  const known = (id) => ctx.products.has(id);
  const unknown = (ids) => ids.filter((id) => !known(id));
  if (c.featuredProductIds.length < 1 || c.featuredProductIds.length > 8) p.push("feature 1–8 products");
  const allIds = [...c.featuredProductIds, ...c.instagram.flatMap((i) => i.productIds), ...c.email.productIds];
  if (unknown(allIds).length) p.push(`these product ids were not returned by search_products: ${[...new Set(unknown(allIds))].join(", ")}`);

  if (c.instagram.length < 2 || c.instagram.length > 6) p.push("write 3–5 Instagram posts");
  c.instagram.forEach((i, n) => {
    if (i.caption.length < 40 || i.caption.length > 1800) p.push(`Instagram post ${n + 1}: caption must be 40–1800 characters`);
    if (i.hook.length < 5 || i.hook.length > 150) p.push(`Instagram post ${n + 1}: hook must be 5–150 characters`);
    if (i.hashtags.length < 3 || i.hashtags.length > 15) p.push(`Instagram post ${n + 1}: use 3–15 hashtags`);
    if (!i.visualIdea) p.push(`Instagram post ${n + 1}: add a visualIdea`);
  });

  const wa = c.whatsapp;
  if (wa.broadcast.length < 60 || wa.broadcast.length > 700) p.push(`WhatsApp broadcast must be 60–700 characters (it is ${wa.broadcast.length})`);
  if (!wa.status || wa.status.length > 220) p.push("WhatsApp status must be 1–220 characters");
  if (!wa.followUp || wa.followUp.length > 320) p.push("WhatsApp followUp must be 1–320 characters");
  for (const m of `${wa.broadcast} ${wa.status} ${wa.followUp}`.matchAll(/https?:\/\/[^\s)]+/g)) {
    try { if (new URL(m[0]).host.replace(/^www\./, "") !== new URL(SITE()).host.replace(/^www\./, "")) p.push(`WhatsApp links must point to ${SITE()} (found ${m[0]})`); } catch { p.push("a WhatsApp link is not valid"); }
  }

  const e = c.email;
  if (e.subject.length < 10 || e.subject.length > 75) p.push(`email subject must be 10–75 characters (it is ${e.subject.length})`);
  if (e.preheader.length > 140) p.push("email preheader must be at most 140 characters");
  if (e.paragraphs.length < 2 || e.paragraphs.length > 6 || e.paragraphs.some((x) => x.length > 600)) p.push("email needs 2–6 paragraphs of up to 600 characters");
  if (!e.ctaLabel || e.ctaLabel.length > 32) p.push("ctaLabel must be 1–32 characters");
  const m = e.ctaUrl.match(/^\/product\/([A-Za-z0-9_-]+)$/);
  if (e.ctaUrl !== "/products" && !m) p.push("ctaUrl must be /products or /product/<slug> of a product you looked up");
  else if (m && ![...ctx.products.values()].some((x) => x.slug === m[1] || String(x._id) === m[1])) p.push("ctaUrl points at a product you did not look up");
  if (e.productIds.length < 1 || e.productIds.length > 4) p.push("feature 1–4 products in the email");

  // Segments must come from get_audience
  if (c.audience.length < 1) p.push("choose at least one audience segment from get_audience");
  const badSeg = c.audience.filter((a) => !ctx.segmentIds.has(a.segmentId));
  if (badSeg.length) p.push(`unknown audience segments: ${badSeg.map((a) => a.segmentId).join(", ")} (call get_audience and use its ids)`);

  // Offers: only what really exists
  const offerOk = (code) => ctx.coupons.has(code);
  if (c.offer.couponCode && !offerOk(c.offer.couponCode)) p.push(`coupon ${c.offer.couponCode} does not exist or is not active — use one from list_coupons, or null`);
  if (c.offer.freeShipping && !ctx.facts.freeShippingOffer.active) p.push("the free-shipping offer is not active — set freeShipping to false");

  const text = [c.title, c.summary, c.timing, ...c.instagram.flatMap((i) => [i.hook, i.caption, i.visualIdea]), wa.broadcast, wa.status, wa.followUp, e.subject, e.preheader, ...e.paragraphs, e.ctaLabel].join("\n");
  const emailable = [...c.instagram.flatMap((i) => [i.hook, i.caption]), wa.broadcast, wa.status, wa.followUp, e.subject, e.preheader, ...e.paragraphs].join("\n");
  const code = c.offer.couponCode && offerOk(c.offer.couponCode) ? c.offer.couponCode : null;

  if (BAD_CLAIMS.test(emailable)) p.push(`remove unprovable claims (“${emailable.match(BAD_CLAIMS)[0]}”)`);
  if (FAKE_URGENCY.test(emailable)) p.push(`remove invented urgency (“${emailable.match(FAKE_URGENCY)[0]}”)`);
  if (MAKING.test(text)) p.push("do not explain how products are made");

  if (/free shipping|free delivery/i.test(emailable) && !(c.offer.freeShipping && ctx.facts.freeShippingOffer.active)) p.push("free shipping is mentioned but not an active offer (set offer.freeShipping only if get_store_facts says it is active)");
  if (OFFER_WORDS.test(emailable) && !code) p.push("a discount/sale/coupon is mentioned but offer.couponCode is null — remove it, or promote a real coupon from list_coupons");
  if (code) {
    for (const t of emailable.matchAll(/\b(?:code|coupon)\s*[:\-]?\s*([A-Z0-9]{4,20})\b/g)) if (t[1] !== code) p.push(`the text uses code ${t[1]} but the real coupon is ${code}`);
    for (const t of emailable.matchAll(/(\d{1,3})\s?%/g)) { const cp = ctx.coupons.get(code); if (!(cp.discountType === "percentage" && Number(t[1]) === cp.discountValue)) p.push(`“${t[0]}” does not match coupon ${code}`); }
  }
  const stated = [...emailable.matchAll(/₹\s?([\d,]+(?:\.\d+)?)/g)].map((x) => Math.round(parseFloat(x[1].replace(/,/g, ""))));
  const allowed = new Set([...ctx.prices, ...ctx.allowedAmounts, ...(c.offer.freeShipping && ctx.facts.freeShippingOffer.active ? [FREE_SHIPPING_ABOVE] : [])]);
  const badAmt = [...new Set(stated.filter((n) => !allowed.has(n)))];
  if (badAmt.length) p.push(`these rupee amounts are not real prices or offers from the tools: ${badAmt.map((n) => `₹${n}`).join(", ")}`);

  return { problems: p, campaign: c };
}

// ── Agent loop ───────────────────────────────────────────────────────────────

const stepNote = (name, input, r) => {
  if (name === "search_products") return `“${input?.query || input?.category || "browse"}” → ${r?.count ?? 0} products`;
  if (name === "submit_campaign") return r?.error ? `rejected: ${String(r.message).split("\n").slice(1, 3).join("; ")}`.slice(0, 220) : "accepted";
  if (name === "list_coupons") return `${r?.count ?? 0} active coupon${r?.count === 1 ? "" : "s"}`;
  if (name === "get_audience") return `${r?.segments?.length ?? 0} segments`;
  return "ok";
};

async function runCampaign(campaignId) {
  const doc = await MarketingCampaign.findById(campaignId);
  if (!doc) return;
  const ctx = { products: new Map(), prices: new Set(), allowedAmounts: new Set(), coupons: new Map(), segmentIds: new Set(), audienceCategories: [], facts: storeFacts() };
  const usage = { inputTokens: 0, outputTokens: 0, turns: 0 };

  const handlers = {
    get_store_facts: async () => ctx.facts,
    get_occasions: async () => occasions(),
    list_categories: async () => ({ categories: (await Category.find({ isActive: { $ne: false } }).select("name subcategories").lean()).map((c) => ({ name: c.name, subcategories: (c.subcategories || []).filter((s) => s.isActive !== false).map((s) => s.name) })) }),
    search_products: (i) => searchProducts(i, ctx),
    list_coupons: () => listCoupons(ctx),
    list_recent_campaigns: () => recentCampaigns(),
    get_audience: (i) => audience(i, ctx),
    submit_campaign: async (input) => {
      const { problems, campaign } = cleanCampaign(input, ctx);
      if (problems.length) return { error: true, message: `The campaign was not accepted. Fix these and submit again:\n- ${problems.join("\n- ")}` };
      const featured = [...new Set([...campaign.featuredProductIds, ...campaign.email.productIds, ...campaign.instagram.flatMap((i) => i.productIds)])];
      campaign.products = featured.map((id) => { const p = ctx.products.get(id); return { id, name: p.name, slug: p.slug || null, price: p.price, category: p.category, image: productImage(p) }; });
      doc.campaign = campaign;
      doc.audienceQuery = { categories: [...new Set(campaign.products.map((p) => p.category).filter(Boolean))], productIds: featured };
      doc.markModified("campaign");
      ctx.saved = true;
      return { ok: true, message: "Campaign saved for the owner to review. You are done." };
    },
  };

  const messages = [{ role: "user", content: `Today is ${ctx.facts.today} (India).\n\nOwner's brief: ${doc.brief}\n\nPrepare the campaign.` }];
  let nudges = 0;
  try {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set on the server");
    for (let turn = 1; turn <= MAX_TURNS && !ctx.saved; turn++) {
      let response;
      try {
        response = await client().beta.messages.create({
          model: MODEL, max_tokens: 16000, system: SYSTEM_PROMPT, tools: TOOLS, messages,
          output_config: { effort: "high" },
          betas: ["server-side-fallback-2026-07-01"], fallbacks: "default",
        });
      } catch (err) {
        throw new Error(`Claude API error${err?.status ? ` ${err.status}` : ""}: ${err?.message || err}`);
      }
      usage.turns = turn;
      usage.inputTokens += response.usage?.input_tokens || 0;
      usage.outputTokens += response.usage?.output_tokens || 0;
      if (response.stop_reason === "refusal") throw new Error(`The model declined to write this campaign (${response.stop_details?.category || "policy"})`);
      if (response.stop_reason === "max_tokens") throw new Error("The model ran out of output space before finishing");
      messages.push({ role: "assistant", content: response.content });

      const uses = response.content.filter((b) => b.type === "tool_use");
      if (!uses.length) {
        if (++nudges > 2) throw new Error("The agent stopped without submitting a campaign");
        messages.push({ role: "user", content: "You have not called submit_campaign yet. Finish and call submit_campaign now." });
        continue;
      }
      const results = [];
      for (const tu of uses) {
        let result, isError = false;
        try { result = handlers[tu.name] ? await handlers[tu.name](tu.input || {}) : { error: true, message: `Unknown tool ${tu.name}` }; isError = Boolean(result?.error); }
        catch (err) { console.error(`[Marketing] Tool ${tu.name} failed:`, err.message); result = { error: true, message: `The tool failed: ${err.message}` }; isError = true; }
        doc.steps.push({ tool: tu.name, note: stepNote(tu.name, tu.input, result) });
        results.push({ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(result), ...(isError ? { is_error: true } : {}) });
      }
      messages.push({ role: "user", content: results });
      await doc.save().catch(() => {}); // lets the screen show progress while the agent works
    }
    if (!ctx.saved) throw new Error(`The agent could not produce a campaign that passed the checks within ${MAX_TURNS} turns`);
    doc.set({ status: "succeeded", usage, model: MODEL, finishedAt: new Date() });
  } catch (err) {
    console.error("[Marketing] Campaign failed:", err.message);
    doc.set({ status: "failed", usage, model: MODEL, error: String(err.message || err).slice(0, 600), finishedAt: new Date() });
  }
  await doc.save().catch((e) => console.error("[Marketing] Could not save campaign:", e.message));
}

module.exports = { runCampaign, cleanCampaign, occasions, storeFacts, MODEL, _internal: { nthWeekday } };
