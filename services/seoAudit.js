/**
 * SEO & website-health audit.
 *
 * Everything here is measured, not guessed: it reads your products/blog/Instagram data from the database and
 * fetches your LIVE website the way Google would (robots.txt, sitemap.xml, pages, images). The AI never decides
 * what is broken — it only helps write fixes (see seoSuggest.js).
 *
 *   products     missing/thin descriptions, no images / alt text, no keywords, duplicates, too-long titles …
 *   links        broken product images, blog/Instagram links to products that no longer exist
 *   indexing     robots.txt, sitemap coverage (does Google's sitemap list your products?), host consistency,
 *                what crawlers see, duplicate www / non-www
 *   performance  page speed (Google PageSpeed if a key is set) and how fast your own server answers
 */
const Product = require("../models/Product");
const BlogPost = require("../models/BlogPost");
const InstagramPost = require("../models/InstagramPost");

/** The address customers (and Google) use — must match the canonical tags the pages emit. */
const SITE_ORIGIN = () => (process.env.SEO_SITE_URL || process.env.SITE_URL || "https://infinitycraftspace.com").replace(/\/+$/, "");
const BOT_UA = "Mozilla/5.0 (compatible; GPTBot/1.1; +https://openai.com/gptbot)";
const GOOGLEBOT_UA = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";

const SEVERITY_POINTS = { critical: 30, warning: 12, info: 4 };
const productPath = (p) => `/product/${p.slug || p._id}`;
const norm = (u) => String(u || "").trim().replace(/\/+$/, "").toLowerCase();
const words = (s) => String(s || "").trim().split(/\s+/).filter(Boolean).length;
const stripMd = (s) => String(s || "").replace(/[*_`>#\[\]()]/g, "").replace(/\s+/g, " ").trim();

// ── Small network helpers ────────────────────────────────────────────────────

async function timedFetch(url, { method = "GET", headers = {}, timeoutMs = 15000, redirect = "follow", readBody = true } = {}) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { method, headers: { "user-agent": GOOGLEBOT_UA, ...headers }, redirect, signal: AbortSignal.timeout(timeoutMs) });
    const ttfbMs = Date.now() - t0;
    let text = null;
    if (readBody && method !== "HEAD") text = await res.text();
    else res.body?.cancel?.().catch(() => {});
    return { ok: res.ok, status: res.status, headers: res.headers, text, ttfbMs, totalMs: Date.now() - t0, url: res.url };
  } catch (e) {
    return { ok: false, status: 0, error: e.name === "TimeoutError" ? "timed out" : e.message, ttfbMs: Date.now() - t0, totalMs: Date.now() - t0 };
  }
}

/** Run `fn` over `items` with a small concurrency limit. */
async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

// ── 1. Products ──────────────────────────────────────────────────────────────

const issue = (code, severity, message, fix) => ({ code, severity, message, fix });

/** Pure function: one product → list of SEO issues. */
function productIssues(p, ctx = {}) {
  const out = [];
  const desc = stripMd(p.description);
  const imgs = (p.images?.length ? p.images : p.image?.url ? [p.image] : []).filter((i) => i?.url);

  if (!desc || desc.length < 20) out.push(issue("no_description", "critical", "No product description — Google has almost nothing to rank this page on.", "Write 2–3 sentences about what it is, colours, and who it suits (the ✨ Suggest SEO button can draft one)."));
  else if (words(desc) < 20) out.push(issue("thin_description", "warning", `Description is only ${words(desc)} words — too thin to rank well.`, "Aim for 40+ words covering colours, occasion and what makes it special."));

  if (imgs.length === 0) out.push(issue("no_images", "critical", "No product photo — the page can't appear in image search or look good in results.", "Add at least one clear photo."));

  if (imgs.length === 1) out.push(issue("single_image", "info", "Only one photo — more angles help shoppers and image search.", "Add 2–4 more photos."));

  if (!(Number(p.price) > 0)) out.push(issue("no_price", "critical", "Price is missing or zero — Google can't show price in results.", "Set the price."));

  const hasSeoDesc = Boolean(p.seoDescription && p.seoDescription.trim().length >= 50);
  if (!hasSeoDesc && desc) out.push(issue("no_meta_description", desc.length > 160 ? "warning" : "info", desc.length > 160 ? "No search-result summary — Google will cut the long description at a random point." : "No dedicated search-result summary (the description is used instead).", "Add a 120–155 character summary (✨ Suggest SEO writes one)."));
  else if (hasSeoDesc && p.seoDescription.length > 165) out.push(issue("long_meta_description", "info", "Search-result summary is longer than 160 characters and will be cut off.", "Shorten it to 155 characters."));

  if (!p.seoKeywords || p.seoKeywords.length === 0) out.push(issue("no_keywords", "warning", "No search keywords set for this product.", "Add 6–10 phrases shoppers would type (✨ Suggest SEO)."));

  const titleLen = (p.seoTitle?.trim() || `${p.name} - Infinity Craft Space`).length;
  if (titleLen > 62) out.push(issue("long_title", "info", `Page title is ${titleLen} characters — Google cuts titles at about 60.`, "Shorten the name, or set a custom search title."));
  if (String(p.name || "").trim().length < 8) out.push(issue("short_name", "info", "Product name is very short — add what it is (e.g. “Kundan Thread Bangles – Purple”).", "Make the name more descriptive."));

  if (!p.slug) out.push(issue("no_slug", "warning", "No friendly web address (slug) — the page uses an ugly ID in its URL.", "Re-save the product to generate one."));
  if (ctx.dupNames?.has(String(p.name || "").trim().toLowerCase())) out.push(issue("duplicate_name", "warning", "Another product has exactly the same name — Google may treat the pages as duplicates.", "Make each product name unique."));
  if (desc.length >= 40 && ctx.dupDescs?.has(desc.toLowerCase())) out.push(issue("duplicate_description", "warning", "Another product has an identical description — duplicate text weakens both pages.", "Write a unique description for each product."));
  return out;
}

const scoreOf = (issues) => Math.max(0, 100 - issues.reduce((n, i) => n + SEVERITY_POINTS[i.severity], 0));

function auditProducts(products) {
  const nameCount = new Map(), descCount = new Map();
  for (const p of products) {
    const n = String(p.name || "").trim().toLowerCase(); nameCount.set(n, (nameCount.get(n) || 0) + 1);
    const d = stripMd(p.description).toLowerCase(); if (d.length >= 40) descCount.set(d, (descCount.get(d) || 0) + 1);
  }
  const ctx = { dupNames: new Set([...nameCount].filter(([, c]) => c > 1).map(([k]) => k)), dupDescs: new Set([...descCount].filter(([, c]) => c > 1).map(([k]) => k)) };
  return products.map((p) => {
    const issues = productIssues(p, ctx);
    return { productId: String(p._id), name: p.name, slug: p.slug || null, category: p.category, score: scoreOf(issues), issues };
  });
}

// ── 2. Links ─────────────────────────────────────────────────────────────────

async function checkLinks(products, publishedPosts, instaPosts) {
  const issues = [];
  const byKey = new Map();
  for (const p of products) { byKey.set(String(p._id), p); if (p.slug) byKey.set(p.slug, p); }

  // Blog posts must only link to products that exist and are active
  for (const post of publishedPosts) {
    for (const m of String(post.content || "").matchAll(/\]\((\/product\/([A-Za-z0-9_-]+))\)/g)) {
      if (!byKey.has(m[2])) issues.push({ kind: "blog_link", severity: "critical", where: `Blog post “${post.title}”`, target: m[1], message: "Links to a product that no longer exists or is hidden.", fix: "Edit the post and remove or replace the link." });
    }
  }
  // Instagram "shop the look" tags
  const activeIds = new Set(products.map((p) => String(p._id)));
  const tagged = await Product.find({ _id: { $in: instaPosts.flatMap((i) => i.tags.map((t) => t.product)) } }).select("name isActive").lean();
  const taggedMap = new Map(tagged.map((t) => [String(t._id), t]));
  for (const ig of instaPosts) {
    for (const t of ig.tags) {
      const pr = taggedMap.get(String(t.product));
      if (!pr || pr.isActive === false || !activeIds.has(String(t.product))) issues.push({ kind: "instagram_tag", severity: "warning", where: `Instagram photo${ig.caption ? ` “${String(ig.caption).slice(0, 40)}”` : ""}`, target: pr?.name || String(t.product), message: "A tagged product is gone or hidden — its pin no longer shows.", fix: "Re-tag the photo in Admin → Instagram." });
    }
  }

  // Product / blog / Instagram image URLs must load
  const imageJobs = [];
  for (const p of products) {
    const u = p.images?.find((i) => i?.url)?.url || p.image?.url;
    if (u) imageJobs.push({ url: u, where: `Product “${p.name}”`, productId: String(p._id) });
  }
  for (const post of publishedPosts) if (post.coverImage?.url) imageJobs.push({ url: post.coverImage.url, where: `Blog post “${post.title}” cover` });
  for (const ig of instaPosts) if (ig.imageUrl) imageJobs.push({ url: ig.imageUrl, where: "Instagram feed photo" });

  const jobs = imageJobs.slice(0, 300);
  const results = await pool(jobs, 10, (j) => timedFetch(j.url, { method: "HEAD", timeoutMs: 8000, readBody: false, headers: { "user-agent": "Mozilla/5.0" } }));
  results.forEach((r, i) => {
    if (r.status === 0 || r.status >= 400) issues.push({ kind: "broken_image", severity: "critical", where: jobs[i].where, productId: jobs[i].productId, target: jobs[i].url, message: `Photo does not load (${r.status || r.error}).`, fix: "Upload the photo again." });
  });
  return { issues, imagesChecked: jobs.length, imagesSkipped: Math.max(0, imageJobs.length - jobs.length) };
}

// ── 3. Sitemap & indexing ────────────────────────────────────────────────────

/** Pure: read title / description / canonical / og:image / robots from raw HTML (handles quotes and line breaks properly). */
function htmlMeta(html) {
  const attrs = (tag) => {
    const o = {};
    for (const m of tag.matchAll(/([a-zA-Z:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) o[m[1].toLowerCase()] = (m[2] ?? m[3] ?? "").trim();
    return o;
  };
  const out = { title: "", description: "", canonical: "", ogImage: "", robots: "" };
  out.title = (String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "").replace(/\s+/g, " ").trim();
  for (const tag of String(html).match(/<meta\b[^>]*>/gi) || []) {
    const a = attrs(tag);
    if (a.name?.toLowerCase() === "description") out.description = a.content || "";
    if (a.name?.toLowerCase() === "robots") out.robots = a.content || "";
    if (a.property?.toLowerCase() === "og:image") out.ogImage = a.content || "";
  }
  for (const tag of String(html).match(/<link\b[^>]*>/gi) || []) { const a = attrs(tag); if (a.rel?.toLowerCase() === "canonical") out.canonical = a.href || ""; }
  return out;
}

const check = (id, status, title, detail, fix) => ({ id, status, title, detail, fix: fix || null });

/** Pull every <loc> (and its lastmod) out of a sitemap. Pure. */
function parseSitemap(xml) {
  const urls = [];
  for (const m of String(xml || "").matchAll(/<url>([\s\S]*?)<\/url>/g)) {
    const loc = m[1].match(/<loc>\s*([^<]+?)\s*<\/loc>/)?.[1];
    const lastmod = m[1].match(/<lastmod>\s*([^<]+?)\s*<\/lastmod>/)?.[1];
    if (loc) urls.push({ loc: loc.replace(/&amp;/g, "&"), lastmod: lastmod || null });
  }
  return urls;
}

/** Pure: does robots.txt shut Google out, and which sitemaps does it declare? */
function parseRobots(text) {
  const sitemaps = [...String(text || "").matchAll(/^\s*sitemap:\s*(\S+)/gim)].map((m) => m[1]);
  let blocksAll = false, group = [];
  let groupIsStar = false, inGroup = false;
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    if (!line) continue;
    const [k, ...rest] = line.split(":");
    const key = k.trim().toLowerCase(), val = rest.join(":").trim();
    if (key === "user-agent") { if (!inGroup) group = []; group.push(val.toLowerCase()); inGroup = true; groupIsStar = group.includes("*") || group.includes("googlebot"); }
    else { inGroup = false; if (key === "disallow" && val === "/" && groupIsStar) blocksAll = true; }
  }
  return { sitemaps, blocksAll };
}

async function checkIndexing(products, publishedPosts) {
  const origin = SITE_ORIGIN();
  const host = new URL(origin).host;
  const checks = [];

  // robots.txt
  const robots = await timedFetch(`${origin}/robots.txt`);
  if (!robots.ok) checks.push(check("robots", "fail", "robots.txt can't be read", `Fetching ${origin}/robots.txt returned ${robots.status || robots.error}.`, "Make sure public/robots.txt is deployed."));
  else {
    const r = parseRobots(robots.text);
    if (r.blocksAll) checks.push(check("robots", "fail", "robots.txt blocks Google from your whole site", "A “Disallow: /” rule applies to all crawlers.", "Remove the “Disallow: /” line."));
    else if (r.sitemaps.length === 0) checks.push(check("robots", "warn", "robots.txt doesn't point to a sitemap", "There is no “Sitemap:” line.", `Add “Sitemap: ${origin}/sitemap.xml”.`));
    else checks.push(check("robots", "pass", "robots.txt is fine", `Allows crawling and declares: ${r.sitemaps.join(", ")}`));
  }

  // The sitemap Google actually reads
  const sm = await timedFetch(`${origin}/sitemap.xml`);
  const sitemapOk = sm.ok && /<urlset|<sitemapindex/.test(sm.text || "");
  if (!sitemapOk) {
    checks.push(check("sitemap_reachable", "fail", "Google can't read your sitemap", `${origin}/sitemap.xml returned ${sm.status || sm.error}.`, "Serve a valid sitemap.xml at that address."));
  } else {
    const urls = parseSitemap(sm.text);
    const locSet = new Set(urls.map((u) => norm(u.loc)));
    checks.push(check("sitemap_reachable", "pass", "Sitemap is reachable", `${urls.length} page${urls.length === 1 ? "" : "s"} listed at ${origin}/sitemap.xml.`));

    // Coverage: are the products really in it?
    const expected = products.map((p) => norm(`${origin}${productPath(p)}`));
    const missing = expected.filter((u) => !locSet.has(u));
    const coverage = expected.length ? Math.round(((expected.length - missing.length) / expected.length) * 100) : 100;
    if (expected.length === 0) checks.push(check("sitemap_products", "pass", "No products to list yet", ""));
    else if (coverage < 50) checks.push(check("sitemap_products", "fail", `Your sitemap lists only ${expected.length - missing.length} of ${expected.length} products`, `Google is told about ${coverage}% of your products. The sitemap it reads is probably an old static file: your server can build a complete one (${expected.length} product pages), but it isn't the one served at ${origin}/sitemap.xml.`, `Redeploy the website: its build now regenerates sitemap.xml from your live product list (scripts/generate-sitemap.mjs). Then submit ${origin}/sitemap.xml in Google Search Console. Redeploy again after adding many new products to keep it current.`));
    else if (coverage < 100) checks.push(check("sitemap_products", "warn", `${missing.length} product${missing.length > 1 ? "s are" : " is"} missing from the sitemap`, `Coverage is ${coverage}%.`, "Regenerate/redeploy the sitemap so every active product is listed."));
    else checks.push(check("sitemap_products", "pass", "Every product is in the sitemap", `${expected.length} of ${expected.length} products listed.`));

    // Blog
    if (publishedPosts.length > 0) {
      const blogMissing = publishedPosts.filter((p) => !locSet.has(norm(`${origin}/blog/${p.slug}`))).length;
      checks.push(blogMissing ? check("sitemap_blog", blogMissing === publishedPosts.length ? "fail" : "warn", `${blogMissing} of ${publishedPosts.length} blog posts missing from the sitemap`, "Google may take much longer to find new posts.", "Redeploy the website so the sitemap is regenerated with your blog posts (it is rebuilt on every deploy).") : check("sitemap_blog", "pass", "Blog posts are in the sitemap", `${publishedPosts.length} listed.`));
    }

    // Stale entries (pages that no longer exist) and host consistency
    const liveSet = new Set([...expected, ...publishedPosts.map((p) => norm(`${origin}/blog/${p.slug}`))]);
    const stale = urls.filter((u) => /\/(product|blog)\//.test(u.loc) && !liveSet.has(norm(u.loc)));
    if (stale.length) checks.push(check("sitemap_stale", "warn", `${stale.length} sitemap URL${stale.length > 1 ? "s" : ""} point to pages that no longer exist`, stale.slice(0, 3).map((u) => u.loc).join(", "), "Redeploy the website to regenerate the sitemap from the current product list."));
    const hosts = [...new Set(urls.map((u) => { try { return new URL(u.loc).host; } catch { return "?"; } }))];
    if (hosts.some((h) => h !== host)) checks.push(check("sitemap_host", "fail", "Sitemap uses a different web address than your pages", `Sitemap URLs use ${hosts.join(", ")} but your pages declare ${host} as the main address — Google may ignore these entries.`, `Redeploy the website (its build rewrites the sitemap to ${origin}), and set SITE_URL=${origin} on the server.`));
    else checks.push(check("sitemap_host", "pass", "Sitemap addresses match your site", host));
    const latest = urls.map((u) => u.lastmod).filter(Boolean).sort().pop();
    if (latest && Date.now() - new Date(latest).getTime() > 45 * 86400000) checks.push(check("sitemap_fresh", "warn", "The sitemap hasn't been updated for over 45 days", `Latest entry: ${latest}.`, "Redeploy the website: the sitemap is regenerated from your products on every deploy."));
  }

  // Home page as a crawler sees it
  const home = await timedFetch(`${origin}/`);
  if (!home.ok) checks.push(check("home", "fail", "The home page didn't load", `${origin}/ returned ${home.status || home.error}.`, "Check the site is up."));
  else {
    const m = htmlMeta(home.text || "");
    const miss = [];
    if (m.title.length < 5) miss.push("page title");
    if (m.description.length < 50) miss.push("meta description");
    if (!m.ogImage) miss.push("social-share image");
    if (/noindex/i.test(m.robots)) checks.push(check("home_noindex", "fail", "The home page tells Google NOT to index it", "A noindex tag is present on the home page.", "Remove the noindex tag from index.html."));
    checks.push(miss.length
      ? check("home_meta", "warn", `Home page is missing: ${miss.join(", ")}`, "", "Add the missing tags in index.html.")
      : check("home_meta", "pass", "Home page has a title, description and share image", m.canonical ? "" : "The canonical link is added after the page loads (fine for Google)."));
  }

  // What non-JavaScript crawlers (AI search, social previews) see on a product page
  const sample = products[0];
  if (sample) {
    const page = await timedFetch(`${origin}${productPath(sample)}`, { headers: { "user-agent": BOT_UA } });
    const firstWord = String(sample.name || "").split(/\s+/)[0];
    if (page.ok && firstWord && !new RegExp(firstWord.replace(/[^\w]/g, ""), "i").test(page.text || "")) {
      checks.push(check("crawler_view", "warn", "AI search and social crawlers see an empty page", `Fetching a product page without running JavaScript doesn't show the product (“${sample.name}”). Google runs JavaScript so it's mostly fine, but ChatGPT/Perplexity-style crawlers and link previews can't read your products.`, "Deploy the website with the new vercel.json: it sends AI/social crawlers to the server's ready-made /prerender pages. The server needs to be redeployed too."));
    } else if (page.ok) checks.push(check("crawler_view", "pass", "Crawlers can read product pages", ""));
  }

  // Both www and non-www serving the site = duplicate content
  if (!host.startsWith("www.")) {
    const www = await timedFetch(`https://www.${host}/`, { redirect: "manual", readBody: false, timeoutMs: 10000 });
    if (www.status === 200) checks.push(check("www_duplicate", "warn", "Your site answers on both www and non-www addresses", `https://www.${host} serves the site instead of redirecting to https://${host}.`, `Deploy the website with the new vercel.json (it redirects www to the main address), or set the redirect in Vercel → Domains.`));
    else if ([301, 302, 307, 308].includes(www.status)) checks.push(check("www_duplicate", "pass", "www redirects to the main address", ""));
  }
  return checks;
}

// ── 4. Performance ───────────────────────────────────────────────────────────

const psiRating = (score) => (score >= 90 ? "pass" : score >= 50 ? "warn" : "fail");

async function pageSpeed(url, key) {
  const api = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(url)}&strategy=mobile&category=performance&key=${encodeURIComponent(key)}`;
  const r = await timedFetch(api, { timeoutMs: 90000, headers: { "user-agent": "seo-audit" } });
  if (!r.ok) return { url, error: r.status === 429 ? "Google's PageSpeed quota was reached" : `PageSpeed returned ${r.status || r.error}` };
  try {
    const d = JSON.parse(r.text);
    const a = d.lighthouseResult.audits;
    const score = Math.round((d.lighthouseResult.categories.performance.score || 0) * 100);
    return { url, score, rating: psiRating(score), lcp: a["largest-contentful-paint"]?.displayValue, cls: a["cumulative-layout-shift"]?.displayValue, tbt: a["total-blocking-time"]?.displayValue, fcp: a["first-contentful-paint"]?.displayValue, si: a["speed-index"]?.displayValue };
  } catch {
    return { url, error: "Unreadable PageSpeed answer" };
  }
}

async function checkPerformance(products) {
  const origin = SITE_ORIGIN();
  const checks = [];
  const out = { lighthouse: [], api: [], checks };

  // Home page speed as a visitor's browser gets it
  // One slow request proves nothing (a single hiccup once read 14 s while five fresh tests took under 1 s), so
  // take three and judge by the middle one.
  const samples = [];
  for (let i = 0; i < 3; i++) samples.push(await timedFetch(`${origin}/`, { timeoutMs: 30000 }));
  const okSamples = samples.filter((s) => s.ok).sort((a, b) => a.ttfbMs - b.ttfbMs);
  if (okSamples.length) {
    const mid = okSamples[Math.floor(okSamples.length / 2)];
    const kb = Math.round(Buffer.byteLength(mid.text || "") / 1024);
    const all = samples.map((s) => (s.ok ? `${s.ttfbMs} ms` : "failed")).join(", ");
    checks.push(check("home_ttfb", mid.ttfbMs > 1800 ? "fail" : mid.ttfbMs > 800 ? "warn" : "pass", `Home page starts loading in ${mid.ttfbMs} ms`, `Typical of 3 tests (${all}). Page shell ${kb} KB. Under 800 ms is good.`, mid.ttfbMs > 800 ? "Check your hosting region and caching." : null));
  }

  // How fast your own server answers (this is what shoppers wait for while products load)
  const base = `http://127.0.0.1:${process.env.PORT || 5000}`;
  for (const [label, path] of [["Product list", "/api/products?limit=12"], ["Categories", "/api/categories/public/list"], ["Blog list", "/api/blog?limit=6"], ["Instagram feed", "/api/instagram?limit=6"]]) {
    const first = await timedFetch(`${base}${path}`, { headers: { origin, "user-agent": "seo-audit" }, timeoutMs: 20000 });
    const second = await timedFetch(`${base}${path}`, { headers: { origin, "user-agent": "seo-audit" }, timeoutMs: 20000 });
    out.api.push({ label, path, firstMs: first.totalMs, warmMs: second.totalMs, status: second.status });
    const ms = second.totalMs;
    checks.push(check(`api_${label}`, second.status !== 200 ? "fail" : ms > 1500 ? "fail" : ms > 600 ? "warn" : "pass", `${label} answers in ${ms} ms`, second.status !== 200 ? `Returned ${second.status || second.error}.` : `First call ${first.totalMs} ms.`, ms > 600 ? "Add a database index or caching for this endpoint." : null));
  }

  // Full Lighthouse test, if the owner added a free Google key
  const key = process.env.PAGESPEED_API_KEY;
  if (!key) {
    checks.push(check("pagespeed", "info", "Full Google PageSpeed test is switched off", "A free Google key is needed to measure real-world loading speed (Core Web Vitals) on a phone.", "Create a free PageSpeed Insights API key in Google Cloud and set PAGESPEED_API_KEY on the server."));
  } else {
    const urls = [`${origin}/`, ...(products[0] ? [`${origin}${productPath(products[0])}`] : [])];
    out.lighthouse = await Promise.all(urls.map((u) => pageSpeed(u, key)));
    for (const l of out.lighthouse) {
      checks.push(l.error ? check(`psi_${l.url}`, "info", `PageSpeed couldn't test ${new URL(l.url).pathname}`, l.error) : check(`psi_${l.url}`, l.rating, `Phone speed score ${l.score}/100 — ${new URL(l.url).pathname === "/" ? "home page" : "product page"}`, `Largest content ${l.lcp}, layout shift ${l.cls}, blocking time ${l.tbt}.`, l.rating !== "pass" ? "Compress images, defer unused scripts, and check the largest content element." : null));
    }
  }
  return out;
}

// ── Scoring & summary ────────────────────────────────────────────────────────

const statusPoints = { fail: 35, warn: 12 };
function scoreReport({ productResults, linkIssues, indexingChecks, perf }) {
  const products = productResults.length ? Math.round(productResults.reduce((n, p) => n + p.score, 0) / productResults.length) : 100;
  const links = Math.max(0, 100 - linkIssues.reduce((n, i) => n + (i.severity === "critical" ? 15 : 5), 0));
  const indexing = Math.max(0, 100 - indexingChecks.reduce((n, c) => n + (statusPoints[c.status] || 0), 0));
  // pass = 100, warn = 65, fail = 30, averaged (informational notes don't count)
  const perfChecks = perf.checks.filter((c) => c.status !== "info");
  const performance = perfChecks.length ? Math.round(perfChecks.reduce((n, c) => n + (c.status === "fail" ? 30 : c.status === "warn" ? 65 : 100), 0) / perfChecks.length) : null;
  const parts = [[products, 0.4], [links, 0.15], [indexing, 0.3], ...(performance === null ? [] : [[performance, 0.15]])];
  const w = parts.reduce((n, [, x]) => n + x, 0);
  return { overall: Math.round(parts.reduce((n, [v, x]) => n + v * x, 0) / w), products, links, indexing, performance };
}

/** Plain-English "what to fix first" list, most valuable first. */
function topActions({ productResults, linkIssues, indexingChecks, perf }) {
  const acts = [];
  for (const c of [...indexingChecks, ...perf.checks]) {
    if (c.status === "fail" || c.status === "warn") acts.push({ severity: c.status === "fail" ? "critical" : "warning", area: "Site", title: c.title, detail: c.detail, fix: c.fix, weight: c.status === "fail" ? 1000 : 300 });
  }
  const byCode = new Map();
  for (const p of productResults) for (const i of p.issues) { const e = byCode.get(i.code) || { ...i, count: 0 }; e.count++; byCode.set(i.code, e); }
  for (const e of byCode.values()) {
    if (e.severity === "info" && e.count < 5) continue;
    acts.push({ severity: e.severity, area: "Products", title: `${e.count} product${e.count > 1 ? "s" : ""}: ${e.message.replace(/ — .*$/, "").replace(/\.$/, "")}`, detail: e.message, fix: e.fix, weight: SEVERITY_POINTS[e.severity] * e.count });
  }
  const crit = linkIssues.filter((i) => i.severity === "critical").length;
  if (crit) acts.push({ severity: "critical", area: "Links", title: `${crit} broken link${crit > 1 ? "s" : ""} or missing photo${crit > 1 ? "s" : ""}`, detail: linkIssues.filter((i) => i.severity === "critical").slice(0, 3).map((i) => `${i.where}: ${i.message}`).join(" · "), fix: "See the Links section below.", weight: 700 });
  return acts.sort((a, b) => b.weight - a.weight).slice(0, 8).map(({ weight, ...a }) => a);
}

/** Run the whole audit. Never throws — a failing section is reported, not fatal. */
async function runAudit() {
  const [products, posts, insta] = await Promise.all([
    Product.find({ isActive: { $ne: false } }).select("name slug price description category images image seoTitle seoDescription seoKeywords updatedAt").sort({ updatedAt: -1 }).lean(),
    BlogPost.find({ status: "published" }).select("title slug content coverImage").lean(),
    InstagramPost.find({ isActive: true }).select("caption imageUrl tags").lean(),
  ]);

  const productResults = auditProducts(products).sort((a, b) => a.score - b.score);
  const section = async (name, fn, fallback) => {
    try { return await fn(); } catch (e) { console.error(`[SeoAudit] ${name} failed:`, e.message); return fallback(e.message); }
  };
  const [links, indexingChecks, perf] = await Promise.all([
    section("links", () => checkLinks(products, posts, insta), (m) => ({ issues: [], imagesChecked: 0, error: m })),
    section("indexing", () => checkIndexing(products, posts), (m) => [check("indexing_error", "info", "Indexing checks couldn't run", m)]),
    section("performance", () => checkPerformance(products), (m) => ({ lighthouse: [], api: [], checks: [check("perf_error", "info", "Performance checks couldn't run", m)] })),
  ]);

  const scores = scoreReport({ productResults, linkIssues: links.issues, indexingChecks, perf });
  const counts = { products: products.length, blogPosts: posts.length, critical: 0, warning: 0, info: 0 };
  for (const p of productResults) for (const i of p.issues) counts[i.severity]++;

  return {
    scores,
    counts,
    productsClean: productResults.filter((p) => p.issues.length === 0).length,
    productIssues: productResults.filter((p) => p.issues.length > 0).slice(0, 500),
    linkIssues: links.issues.slice(0, 200),
    imagesChecked: links.imagesChecked,
    indexingChecks,
    performance: { lighthouse: perf.lighthouse, api: perf.api, checks: perf.checks },
    actions: topActions({ productResults, linkIssues: links.issues, indexingChecks, perf }),
  };
}

module.exports = { runAudit, auditProducts, productIssues, parseSitemap, parseRobots, htmlMeta, scoreReport, topActions, SITE_ORIGIN };
