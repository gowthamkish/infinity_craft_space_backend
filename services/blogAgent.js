/**
 * blog_agent — writes one "Behind the Craft" blog post per run.
 *
 * It is a real tool-using agent (Claude decides what to look up and when it is done), not a single prompt:
 *   1. looks at the existing posts (so it never repeats a topic),
 *   2. researches the live catalog (real products, categories, prices),
 *   3. writes the post and calls `submit_post`,
 *   4. the server checks the draft (length, structure, links, prices, no invented facts) and sends it back for
 *      revision if it fails — the agent loops until the post passes or it runs out of turns.
 *
 * Passing posts are saved as a draft (default) or published, depending on the admin setting.
 */
const Anthropic = require("@anthropic-ai/sdk");
const Product = require("../models/Product");
const Category = require("../models/Category");
const BlogPost = require("../models/BlogPost");
const { uniqueSlug, readingMinutes, cleanTags } = require("../utils/blogHelpers");
const { OFFER_START, OFFER_END, FREE_SHIPPING_ABOVE } = require("../utils/launchOffer");

// Claude Opus 5.5. Override with BLOG_AGENT_MODEL (e.g. a cheaper model) without a code change.
const MODEL = process.env.BLOG_AGENT_MODEL || "claude-opus-5-5";
const MAX_TURNS = 14;
const MAX_NUDGES = 2;

/** Content pillars — the agent rotates through them so the blog stays varied. */
const PILLARS = [
  { id: "craft", label: "The craft explained", brief: "How a type of jewellery/craft piece is made: materials, techniques and what makes it special. Stay general and educational — do not claim anything about OUR workshop or artisans beyond what tools tell you." },
  { id: "care", label: "Care guide", brief: "Practical care, storage and cleaning advice for a kind of piece we sell (e.g. oxidised silver, kundan, resin, string/flower jewellery)." },
  { id: "gifting", label: "Gifting guide", brief: "A gifting guide for an occasion or recipient, recommending real products from the catalog." },
  { id: "style", label: "Style guide", brief: "How to style or wear a kind of piece for different outfits and occasions, featuring real products from the catalog." },
  { id: "season", label: "Festival & season special", brief: "A timely post tied to an upcoming Indian festival, wedding season or occasion, with relevant real products." },
  { id: "spotlight", label: "Collection spotlight", brief: "A story-led spotlight on one category or collection from the catalog: what it is, who it suits, how to choose." },
];

const SYSTEM_PROMPT = `You are the blog writer for Infinity Craft Space, an Indian handcraft and jewellery brand based in Bangalore that ships across India. You write the "Behind the Craft" blog. Readers are Indian shoppers looking for handmade jewellery and craft gifts; the posts should help them (care, styling, gifting, understanding craft) and also help the shop's pages rank on Google.

How you work
1. Call list_existing_posts first so you never repeat a topic or title.
2. Call get_store_facts, list_categories and search_products to ground the post in what the shop really sells. Look at several products before choosing which to feature.
3. Write the post, then call submit_post. If submit_post returns an error, fix exactly what it says and call submit_post again.

Honesty rules (the most important part)
- Everything about Infinity Craft Space — its products, prices, offers, shipping, location, policies — must come from tool results. Never invent facts about the brand, its workshop, its artisans, its history, customers, reviews, awards, certifications or sales numbers. Do not write "our artisans in <place>" or "we have been making … for N years" unless a tool says so.
- Never state a price, discount or offer unless it appears in a tool result. Only mention rupee amounts you received from tools.
- General craft knowledge (how kundan or oxidised silver is made, how to clean silver, what suits which outfit) is welcome, but write only what you are confident is accurate. Avoid statistics, medical or "skin-safe/allergy-free" claims, and claims about gemstone powers.
- Do not describe a product's materials, size or features beyond what its tool result says.

Style
- Warm, clear Indian English ("colour", "jewellery"). Written for people, not for search engines; no keyword stuffing, no clichés like "In today's fast-paced world".
- 900–1400 words. Open with a concrete hook, not a definition. Use "## " section headings (3–6 of them). Short paragraphs. A bullet list where it genuinely helps.
- Link to real products with Markdown links in the form [Product name](/product/<slug-or-id>) using the exact url from search_products, and link to [our collection](/products) once. Feature 2–5 products naturally where they fit the story — it should read as helpful advice, not an advert.
- Markdown only: ## headings, **bold**, *italic*, - bullets, 1. numbered lists, > quotes, [links](/relative-path). No HTML, no images, no external links.
- A short, natural closing line pointing readers to the collection is fine; no hard sell.

submit_post fields: title (≤ 90 characters, specific, not clickbait), excerpt (one or two sentences, 80–280 characters), content (the Markdown post), tags (2–5 lowercase topic words), metaTitle (≤ 65 characters), metaDescription (≤ 160 characters), coverProductId (the id of one product from search_products whose photo suits the post), coverAlt (a short description of that photo).`;

const TOOLS = [
  {
    name: "list_existing_posts",
    description: "List the blog posts that already exist (title, tags, status) so you can avoid repeating a topic. Call this first.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_store_facts",
    description: "Verified facts about the shop that you may state in the post: location, shipping, payment, and any offer running right now.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_categories",
    description: "List the shop's active product categories and subcategories.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "search_products",
    description: "Search the live catalog. Returns up to 8 active products with id, name, price in rupees, category, description, availability and the url to link to. Leave `query` empty to browse a category.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Words to look for in product names, descriptions, categories, e.g. 'kundan necklace'" },
        category: { type: "string", description: "Exact category name from list_categories (optional)" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "submit_post",
    description: "Submit the finished blog post. The server validates it; on an error, fix the problem and submit again.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        excerpt: { type: "string" },
        content: { type: "string", description: "The post body in Markdown" },
        tags: { type: "array", items: { type: "string" } },
        metaTitle: { type: "string" },
        metaDescription: { type: "string" },
        coverProductId: { type: "string", description: "id of a product returned by search_products" },
        coverAlt: { type: "string" },
      },
      required: ["title", "excerpt", "content", "tags", "metaTitle", "metaDescription", "coverProductId"],
      additionalProperties: false,
    },
  },
];

let _client = null;
const client = () => (_client ||= new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY }));

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const productUrl = (p) => `/product/${p.slug || p._id}`;
const productImage = (p) => p.images?.find((i) => i?.isPrimary && i.url)?.url || p.images?.find((i) => i?.url)?.url || p.image?.url || null;

// ── Tool implementations ─────────────────────────────────────────────────────

async function toolListExistingPosts() {
  const posts = await BlogPost.find({}).select("title tags status").sort({ createdAt: -1 }).limit(60).lean();
  return { count: posts.length, posts: posts.map((p) => ({ title: p.title, tags: p.tags, status: p.status })) };
}

function toolGetStoreFacts() {
  const now = Date.now();
  const offerActive = now >= OFFER_START.getTime() && now < OFFER_END.getTime();
  return {
    brand: "Infinity Craft Space",
    location: "Bangalore, Karnataka, India",
    ships_to: "All over India",
    payment: "Online payment only (UPI, cards, net banking via Razorpay). Cash on delivery is NOT available.",
    shipping: "A shipping charge applies, calculated at checkout from the delivery location and parcel weight.",
    customisation: "Some products can be personalised — the product page says so.",
    current_offer: offerActive
      ? `Launch offer: FREE shipping on orders above ₹${FREE_SHIPPING_ABOVE}, valid until ${OFFER_END.toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Kolkata" })}.`
      : "No offer is running right now — do not mention any offer or discount.",
    contact: "infinitycraftspacejsag@gmail.com",
  };
}

async function toolListCategories() {
  const cats = await Category.find({ isActive: { $ne: false } }).select("name subcategories").lean();
  return {
    categories: cats.map((c) => ({
      name: c.name,
      subcategories: (c.subcategories || []).filter((s) => s.isActive !== false).map((s) => s.name),
    })),
  };
}

async function toolSearchProducts({ query, category } = {}, ctx) {
  const filter = { isActive: { $ne: false } };
  if (category) filter.category = new RegExp(`^${escapeRegex(category)}$`, "i");
  const q = String(query || "").trim().slice(0, 80);
  if (q) {
    const words = q.split(/\s+/).filter(Boolean).slice(0, 5).map((w) => new RegExp(escapeRegex(w), "i"));
    filter.$and = words.map((re) => ({ $or: [{ name: re }, { description: re }, { category: re }, { subCategory: re }, { tags: re }] }));
  }
  const products = await Product.find(filter)
    .select("name slug price description category subCategory stock trackInventory isCustomizable images image")
    .sort({ createdAt: -1 })
    .limit(8)
    .lean();

  for (const p of products) {
    ctx.seenProducts.set(String(p._id), p);
    ctx.seenPrices.add(Math.round(p.price));
  }
  return {
    count: products.length,
    products: products.map((p) => ({
      id: String(p._id),
      name: p.name,
      price_rupees: p.price,
      category: p.category,
      subcategory: p.subCategory,
      description: String(p.description || "").replace(/\s+/g, " ").slice(0, 350),
      in_stock: p.trackInventory === false || p.stock > 0,
      customisable: Boolean(p.isCustomizable),
      url: productUrl(p),
    })),
  };
}

// ── Draft validation — returns a list of problems (empty = good) ─────────────

async function validateDraft(input, ctx) {
  const problems = [];
  const title = String(input.title || "").trim();
  const excerpt = String(input.excerpt || "").trim();
  const content = String(input.content || "").trim();
  const tags = cleanTags(input.tags);
  const metaTitle = String(input.metaTitle || "").trim();
  const metaDescription = String(input.metaDescription || "").trim();

  if (title.length < 12 || title.length > 90) problems.push("title must be 12–90 characters");
  if (excerpt.length < 80 || excerpt.length > 300) problems.push("excerpt must be 80–300 characters");
  if (metaTitle.length > 70) problems.push("metaTitle must be at most 70 characters");
  if (metaDescription.length > 170) problems.push("metaDescription must be at most 170 characters");
  if (tags.length < 2 || tags.length > 6) problems.push("provide 2–6 tags");

  const words = content.split(/\s+/).filter(Boolean).length;
  if (words < 700) problems.push(`the post has ${words} words; write at least 700 (aim for 900–1400)`);
  if (words > 2200) problems.push(`the post has ${words} words; keep it under 2200`);
  if ((content.match(/^##\s+\S/gm) || []).length < 3) problems.push('use at least 3 "## " section headings');
  if (/<\/?[a-z][^>]*>/i.test(content)) problems.push("no HTML — use Markdown only");
  if (/!\[/.test(content)) problems.push("do not include images in the body (the cover photo is added automatically)");
  if (/\]\(\s*(https?:|mailto:|\/\/)/i.test(content)) problems.push("no external links — only relative links like /product/<slug> and /products");

  if (await BlogPost.exists({ title: new RegExp(`^${escapeRegex(title)}$`, "i") })) problems.push("a post with this title already exists — choose a different angle");

  // Internal links must point at real products (or /products)
  const links = [...content.matchAll(/\]\((\/[^)\s]*)\)/g)].map((m) => m[1]);
  if (!links.length) problems.push("link to at least one real product with [name](/product/<slug-or-id>) and to /products");
  for (const href of new Set(links)) {
    if (href === "/products" || href === "/blog") continue;
    const m = href.match(/^\/product\/([A-Za-z0-9_-]+)$/);
    if (!m) { problems.push(`link ${href} is not allowed (use /product/<slug-or-id> or /products)`); continue; }
    const key = m[1];
    const known = [...ctx.seenProducts.values()].some((p) => String(p._id) === key || p.slug === key);
    if (!known) problems.push(`link ${href} does not match any product you looked up with search_products`);
  }

  // Money: only amounts that came from tools; no invented discounts
  const stated = [...content.matchAll(/₹\s?([\d,]+(?:\.\d+)?)/g)].map((m) => Math.round(parseFloat(m[1].replace(/,/g, ""))));
  const bad = [...new Set(stated.filter((n) => !ctx.seenPrices.has(n) && n !== FREE_SHIPPING_ABOVE))];
  if (bad.length) problems.push(`these rupee amounts did not come from tool results: ${bad.map((n) => `₹${n}`).join(", ")} — remove them or use real prices from search_products`);
  if (/\b\d{1,2}\s?%\s*(off|discount)/i.test(content)) problems.push("do not mention percentage discounts");

  const cover = ctx.seenProducts.get(String(input.coverProductId || ""));
  if (!cover) problems.push("coverProductId must be the id of a product returned by search_products");
  else if (!productImage(cover)) problems.push("that cover product has no photo — pick another one");

  return { problems, cleaned: { title, excerpt, content, tags, metaTitle, metaDescription, cover, coverAlt: String(input.coverAlt || "").trim().slice(0, 200) } };
}

async function toolSubmitPost(input, ctx) {
  const { problems, cleaned } = await validateDraft(input, ctx);
  if (problems.length) return { error: true, message: `The post was not accepted. Fix these and submit again:\n- ${problems.join("\n- ")}` };

  const publish = ctx.config.autoPublish === true;
  const post = await BlogPost.create({
    title: cleaned.title,
    slug: await uniqueSlug(cleaned.title),
    excerpt: cleaned.excerpt,
    content: cleaned.content,
    tags: cleaned.tags,
    metaTitle: cleaned.metaTitle,
    metaDescription: cleaned.metaDescription,
    // No publicId on purpose: the photo belongs to the product, so deleting this post must never delete it from Cloudinary
    coverImage: { url: productImage(cleaned.cover), alt: cleaned.coverAlt || cleaned.cover.name },
    authorName: "Infinity Craft Space",
    readingMinutes: readingMinutes(cleaned.content),
    status: publish ? "published" : "draft",
    publishedAt: publish ? new Date() : null,
    generatedBy: "agent",
    aiModel: MODEL,
    agentRunId: ctx.runId,
  });
  ctx.savedPost = post;
  return { ok: true, status: post.status, message: publish ? "Post published." : "Post saved as a draft for the owner to review. You are done." };
}

// ── Agent loop ───────────────────────────────────────────────────────────────

const TOOL_HANDLERS = {
  list_existing_posts: () => toolListExistingPosts(),
  get_store_facts: () => toolGetStoreFacts(),
  list_categories: () => toolListCategories(),
  search_products: (input, ctx) => toolSearchProducts(input, ctx),
  submit_post: (input, ctx) => toolSubmitPost(input, ctx),
};

const stepNote = (name, input, result) => {
  if (name === "search_products") return `"${input?.query || input?.category || "browse"}" → ${result?.count ?? 0} products`;
  if (name === "submit_post") return result?.error ? `rejected: ${String(result.message).split("\n").slice(1, 3).join("; ")}`.slice(0, 220) : `accepted (${result?.status})`;
  if (name === "list_existing_posts") return `${result?.count ?? 0} existing posts`;
  return "ok";
};

/**
 * Run the agent once.
 * @param {{ config: object, runId: any, pillar: object, onStep?: (tool: string, note: string) => void }} args
 * @returns {Promise<{ post: object, usage: object }>}
 */
async function runBlogAgent({ config, runId, pillar, onStep }) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set on the server");

  const today = new Date().toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Kolkata" });
  const userPrompt = [
    `Today is ${today} (India).`,
    `Write the next blog post. Content pillar for this post: "${pillar.label}" — ${pillar.brief}`,
    config.focusNotes ? `The owner asked for this focus: ${config.focusNotes}` : null,
    "Pick a specific, useful topic within the pillar that suits the season and the products we actually sell.",
  ].filter(Boolean).join("\n\n");

  const ctx = { config, runId, seenProducts: new Map(), seenPrices: new Set(), savedPost: null };
  const usage = { inputTokens: 0, outputTokens: 0, turns: 0 };
  const messages = [{ role: "user", content: userPrompt }];
  let nudges = 0;

  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    let response;
    try {
      response = await client().beta.messages.create({
        model: MODEL,
        max_tokens: 16000,
        system: SYSTEM_PROMPT,
        tools: TOOLS,
        messages,
        output_config: { effort: "high" },
        // If a safety classifier declines the request, retry it on the server-defined fallback model
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      });
    } catch (err) {
      throw new Error(`Claude API error${err?.status ? ` ${err.status}` : ""}: ${err?.message || err}`);
    }

    usage.turns = turn;
    usage.inputTokens += response.usage?.input_tokens || 0;
    usage.outputTokens += response.usage?.output_tokens || 0;

    if (response.stop_reason === "refusal") throw new Error(`The model declined to write this post (${response.stop_details?.category || "policy"})`);
    if (response.stop_reason === "max_tokens") throw new Error("The model ran out of output space before finishing the post");

    // Keep the whole assistant turn (thinking blocks must be passed back unchanged)
    messages.push({ role: "assistant", content: response.content });

    const toolUses = response.content.filter((b) => b.type === "tool_use");
    if (toolUses.length === 0) {
      if (++nudges > MAX_NUDGES) throw new Error("The agent stopped without submitting a post");
      messages.push({ role: "user", content: "You have not called submit_post yet. Finish the post and call submit_post now." });
      continue;
    }

    const results = [];
    for (const tu of toolUses) {
      let result;
      let isError = false;
      try {
        const handler = TOOL_HANDLERS[tu.name];
        result = handler ? await handler(tu.input || {}, ctx) : { error: true, message: `Unknown tool ${tu.name}` };
        isError = Boolean(result?.error);
      } catch (err) {
        console.error(`[BlogAgent] Tool ${tu.name} failed:`, err.message);
        result = { error: true, message: `The tool failed: ${err.message}` };
        isError = true;
      }
      onStep?.(tu.name, stepNote(tu.name, tu.input, result));
      results.push({ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(result), ...(isError ? { is_error: true } : {}) });
    }
    messages.push({ role: "user", content: results });

    if (ctx.savedPost) return { post: ctx.savedPost, usage };
  }

  throw new Error(`The agent could not produce a post that passed the checks within ${MAX_TURNS} turns`);
}

/** The pillar to use next — rotates through PILLARS based on how many posts the agent has already written. */
async function nextPillar() {
  const written = await BlogPost.countDocuments({ generatedBy: "agent" });
  return PILLARS[written % PILLARS.length];
}

module.exports = { runBlogAgent, nextPillar, MODEL, PILLARS, _internal: { validateDraft, toolSearchProducts, toolSubmitPost } };
