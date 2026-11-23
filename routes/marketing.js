/**
 * Marketing agent (admin only). Drafts campaigns and finds audiences — it never sends anything to customers.
 *   POST   /api/marketing/campaigns                       start a campaign from a one-line brief
 *   GET    /api/marketing/campaigns · GET /campaigns/:id  list / open
 *   PUT    /api/marketing/campaigns/:id                   save the owner's edits
 *   DELETE /api/marketing/campaigns/:id
 *   GET    /api/marketing/campaigns/:id/email-preview     rendered email HTML
 *   POST   /api/marketing/campaigns/:id/test-email        send the email to the SHOP inbox only
 *   GET    /api/marketing/campaigns/:id/audience[/:segmentId]
 *   GET    /api/marketing/segments[/:segmentId]           audiences not tied to one campaign
 *   GET    /api/marketing/abandoned-carts · POST /abandoned-carts/drafts
 *   GET    /api/marketing/coupons                          active coupons (for the reminder drafts)
 */
const express = require("express");
const mongoose = require("mongoose");
const rateLimit = require("express-rate-limit");
const router = express.Router();
const { protect, isAdmin } = require("../middlewares/authMiddleware");
const MarketingCampaign = require("../models/MarketingCampaign");
const Coupon = require("../models/Coupon");
const { runCampaign, MODEL } = require("../services/marketingAgent");
const { segmentSummary, membersFor, SEGMENTS, abandonedCarts } = require("../services/marketingSegments");
const { renderCampaignEmail } = require("../services/marketingEmail");
const { draftReminders } = require("../services/marketingCarts");

router.use(protect, isAdmin);

const aiLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false, message: { success: false, message: "Too many AI requests — please wait a few minutes." } });
const LOCK_MS = 15 * 60 * 1000;
const validId = (id) => mongoose.Types.ObjectId.isValid(id);
const str = (v, n) => String(v ?? "").trim().slice(0, n);

router.post("/campaigns", aiLimiter, async (req, res) => {
  try {
    const brief = str(req.body?.brief, 600);
    if (brief.length < 8) return res.status(400).json({ success: false, message: "Describe the campaign in a sentence, e.g. “Prepare a wedding-season promotion for kundan jewellery”." });
    if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ success: false, message: "ANTHROPIC_API_KEY is not set on the server" });

    await MarketingCampaign.updateMany({ status: "running", startedAt: { $lt: new Date(Date.now() - LOCK_MS) } }, { $set: { status: "failed", error: "Interrupted (server restarted or timed out)", finishedAt: new Date() } });
    if (await MarketingCampaign.exists({ status: "running" })) return res.status(409).json({ success: false, message: "A campaign is already being written — please wait for it to finish." });

    const doc = await MarketingCampaign.create({ brief, status: "running", model: MODEL, createdBy: req.user._id });
    runCampaign(doc._id).catch((e) => console.error("[Marketing] Unexpected error:", e));
    res.status(202).json({ success: true, id: doc._id });
  } catch (e) {
    console.error("[Marketing] Create failed:", e.message);
    res.status(500).json({ success: false, message: "Could not start the campaign" });
  }
});

router.get("/campaigns", async (_req, res) => {
  const rows = await MarketingCampaign.find({}).sort({ createdAt: -1 }).limit(30).select("brief status startedAt finishedAt error campaign.title campaign.products").lean();
  res.json({ success: true, campaigns: rows.map((r) => ({ _id: r._id, brief: r.brief, status: r.status, startedAt: r.startedAt, error: r.error, title: r.campaign?.title || null, productCount: r.campaign?.products?.length || 0 })) });
});

const load = async (req, res) => {
  if (!validId(req.params.id)) { res.status(400).json({ success: false, message: "Invalid campaign" }); return null; }
  const c = await MarketingCampaign.findById(req.params.id);
  if (!c) { res.status(404).json({ success: false, message: "Campaign not found" }); return null; }
  return c;
};

router.get("/campaigns/:id", async (req, res) => {
  const c = await load(req, res);
  if (c) res.json({ success: true, campaign: c });
});

router.put("/campaigns/:id", async (req, res) => {
  const c = await load(req, res);
  if (!c) return;
  if (c.status !== "succeeded" || !c.campaign) return res.status(400).json({ success: false, message: "Only finished campaigns can be edited" });
  const b = req.body || {};
  const cur = c.campaign;
  if (b.title !== undefined) cur.title = str(b.title, 90);
  if (b.summary !== undefined) cur.summary = str(b.summary, 800);
  if (b.timing !== undefined) cur.timing = str(b.timing, 800);
  if (Array.isArray(b.instagram) && b.instagram.length === cur.instagram.length) {
    cur.instagram = cur.instagram.map((p, i) => ({ ...p, hook: str(b.instagram[i].hook, 150), caption: str(b.instagram[i].caption, 2200), visualIdea: str(b.instagram[i].visualIdea, 500), hashtags: Array.isArray(b.instagram[i].hashtags) ? b.instagram[i].hashtags.map((h) => str(h, 40).replace(/^#+/, "")).filter(Boolean).slice(0, 20) : p.hashtags }));
  }
  if (b.whatsapp) cur.whatsapp = { broadcast: str(b.whatsapp.broadcast ?? cur.whatsapp.broadcast, 1000), status: str(b.whatsapp.status ?? cur.whatsapp.status, 300), followUp: str(b.whatsapp.followUp ?? cur.whatsapp.followUp, 400) };
  if (b.email) {
    const e = b.email;
    cur.email = { ...cur.email, subject: str(e.subject ?? cur.email.subject, 90), preheader: str(e.preheader ?? cur.email.preheader, 150), ctaLabel: str(e.ctaLabel ?? cur.email.ctaLabel, 40), paragraphs: Array.isArray(e.paragraphs) ? e.paragraphs.map((p) => str(p, 800)).filter(Boolean).slice(0, 8) : cur.email.paragraphs };
  }
  c.markModified("campaign");
  await c.save();
  res.json({ success: true, campaign: c });
});

router.delete("/campaigns/:id", async (req, res) => {
  if (!validId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid campaign" });
  await MarketingCampaign.findByIdAndDelete(req.params.id);
  res.json({ success: true });
});

router.get("/campaigns/:id/email-preview", async (req, res) => {
  const c = await load(req, res);
  if (!c?.campaign) return c && res.status(400).json({ success: false, message: "Not ready yet" });
  res.json({ success: true, html: renderCampaignEmail(c.campaign, { test: true }) });
});

router.post("/campaigns/:id/test-email", async (req, res) => {
  const c = await load(req, res);
  if (!c?.campaign) return c && res.status(400).json({ success: false, message: "Not ready yet" });
  const { sendEmail } = require("../utils/emailService");
  const to = process.env.SHOP_EMAIL || "infinitycraftspacejsag@gmail.com"; // only ever the shop's own inbox
  const ok = await sendEmail(to, { subject: `[TEST] ${c.campaign.email.subject}`, html: renderCampaignEmail(c.campaign, { test: true }) });
  if (!ok) return res.status(502).json({ success: false, message: "The test email could not be sent — check the email settings (BREVO_API_KEY)." });
  res.json({ success: true, to });
});

router.get("/campaigns/:id/audience", async (req, res) => {
  const c = await load(req, res);
  if (c) res.json({ success: true, segments: await segmentSummary(c.audienceQuery || {}) });
});
router.get("/campaigns/:id/audience/:segmentId", async (req, res) => {
  const c = await load(req, res);
  if (!c) return;
  if (!SEGMENTS[req.params.segmentId]) return res.status(404).json({ success: false, message: "Unknown audience" });
  res.json({ success: true, members: (await membersFor(req.params.segmentId, c.audienceQuery || {})).slice(0, 1000) });
});

router.get("/segments", async (_req, res) => res.json({ success: true, segments: await segmentSummary({}) }));
router.get("/segments/:segmentId", async (req, res) => {
  if (!SEGMENTS[req.params.segmentId]) return res.status(404).json({ success: false, message: "Unknown audience" });
  res.json({ success: true, members: (await membersFor(req.params.segmentId, {})).slice(0, 1000) });
});

router.get("/abandoned-carts", async (req, res) => {
  const idleHours = Math.min(720, Math.max(0, Number(req.query.idleHours) || 24));
  res.json({ success: true, carts: await abandonedCarts({ idleHours, limit: 30 }) });
});

router.post("/abandoned-carts/drafts", aiLimiter, async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.cartIds) ? req.body.cartIds.map(String).slice(0, 15) : [];
    if (!ids.length) return res.status(400).json({ success: false, message: "Choose at least one cart" });
    const carts = (await abandonedCarts({ idleHours: 0, limit: 100 })).filter((c) => ids.includes(c.cartId));
    if (!carts.length) return res.status(404).json({ success: false, message: "Those carts are no longer abandoned" });
    const out = await draftReminders(carts, { couponCode: req.body?.couponCode || undefined });
    const byId = new Map(carts.map((c) => [c.cartId, c]));
    res.json({ success: true, link: out.link, couponCode: out.couponCode, drafts: out.drafts.map((d) => ({ ...d, name: byId.get(d.cartId)?.name, email: byId.get(d.cartId)?.email, optedIn: byId.get(d.cartId)?.optedIn })) });
  } catch (e) {
    console.error("[Marketing] Reminder drafts failed:", e.message);
    res.status(/coupon/i.test(e.message) ? 400 : 502).json({ success: false, message: e.message });
  }
});

router.get("/coupons", async (_req, res) => {
  const now = new Date();
  const rows = await Coupon.find({ isActive: true, validFrom: { $lte: now }, $or: [{ validUntil: { $gte: now } }, { validUntil: null }] }).select("code description discountType discountValue").lean();
  res.json({ success: true, coupons: rows });
});

module.exports = router;
