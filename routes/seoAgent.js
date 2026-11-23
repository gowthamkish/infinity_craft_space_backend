/**
 * SEO & website-health agent (admin only)
 *   GET  /api/seo-agent/latest            newest report (+ whether an audit is running)
 *   GET  /api/seo-agent/history           score over time
 *   POST /api/seo-agent/run               start an audit now
 *   POST /api/seo-agent/suggest/:id       AI suggestions for one product (not saved)
 *   POST /api/seo-agent/apply/:id         save the approved suggestions to the product
 *   POST /api/seo-agent/ask               ask a question about the audit
 *   GET|POST /api/seo-agent/tick          weekly check for an external pinger (x-cron-secret)
 */
const express = require("express");
const crypto = require("crypto");
const mongoose = require("mongoose");
const rateLimit = require("express-rate-limit");
const router = express.Router();
const { protect, isAdmin } = require("../middlewares/authMiddleware");
const Product = require("../models/Product");
const agent = require("../services/seoAgent");
const { suggestForProduct, answerQuestion, MODEL } = require("../services/seoSuggest");

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a || "")), y = Buffer.from(String(b || ""));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
async function tickHandler(req, res) {
  const secret = process.env.BLOG_AGENT_TICK_SECRET;
  if (!secret) return res.status(404).json({ success: false });
  if (!safeEqual(req.get("x-cron-secret") || req.query.key, secret)) return res.status(401).json({ success: false });
  try {
    const r = await agent.tick();
    res.status(r.started ? 202 : 200).json({ success: true, ...r });
  } catch (e) {
    res.status(500).json({ success: false });
  }
}
router.get("/tick", tickHandler);
router.post("/tick", tickHandler);

router.use(protect, isAdmin);

// Each of these calls the AI model — keep a runaway loop from running up a bill
const aiLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 40, standardHeaders: true, legacyHeaders: false, message: { success: false, message: "Too many AI requests — please wait a few minutes." } });

router.get("/latest", async (_req, res) => {
  try {
    const { running, runningSince, last, lastGood } = await agent.latest();
    res.json({
      success: true,
      running,
      runningSince,
      lastRun: last ? { status: last.status, trigger: last.trigger, startedAt: last.startedAt, finishedAt: last.finishedAt, error: last.error } : null,
      report: lastGood?.report || null,
      reportAt: lastGood?.startedAt || null,
      model: MODEL,
      apiKeyConfigured: Boolean(process.env.ANTHROPIC_API_KEY),
      pageSpeedConfigured: Boolean(process.env.PAGESPEED_API_KEY),
    });
  } catch (e) {
    console.error("[SeoAgent] latest failed:", e.message);
    res.status(500).json({ success: false, message: "Could not load the report" });
  }
});

router.get("/history", async (_req, res) => res.json({ success: true, history: await agent.history() }));

router.post("/run", async (_req, res) => {
  try {
    const r = await agent.startAudit("manual");
    if (!r.started) return res.status(409).json({ success: false, message: r.reason });
    res.status(202).json({ success: true, runId: r.runId });
  } catch (e) {
    console.error("[SeoAgent] run failed:", e.message);
    res.status(500).json({ success: false, message: "Could not start the audit" });
  }
});

router.post("/suggest/:id", aiLimiter, async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ success: false, message: "Invalid product" });
  try {
    res.json({ success: true, ...(await suggestForProduct(req.params.id)) });
  } catch (e) {
    console.error("[SeoAgent] suggest failed:", e.message);
    res.status(/not found/i.test(e.message) ? 404 : 502).json({ success: false, message: e.message });
  }
});

router.post("/apply/:id", async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ success: false, message: "Invalid product" });
  try {
    const p = await Product.findById(req.params.id);
    if (!p) return res.status(404).json({ success: false, message: "Product not found" });
    const b = req.body || {};
    const str = (v, n) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);

    if (b.seoTitle !== undefined) p.seoTitle = str(b.seoTitle, 70);
    if (b.seoDescription !== undefined) p.seoDescription = str(b.seoDescription, 170);
    if (b.keywords !== undefined) {
      if (!Array.isArray(b.keywords)) return res.status(400).json({ success: false, message: "Keywords must be a list" });
      p.seoKeywords = [...new Set(b.keywords.map((k) => str(k, 60).toLowerCase()).filter(Boolean))].slice(0, 12);
    }
    if (b.description !== undefined) {
      const d = String(b.description).trim().slice(0, 5000);
      if (d.length < 20) return res.status(400).json({ success: false, message: "The description is too short to save" });
      p.description = d;
    }
    await p.save();
    res.json({ success: true });
  } catch (e) {
    console.error("[SeoAgent] apply failed:", e.message);
    res.status(500).json({ success: false, message: "Could not save the changes" });
  }
});

router.post("/ask", aiLimiter, async (req, res) => {
  const question = String(req.body?.question || "").trim();
  if (question.length < 3) return res.status(400).json({ success: false, message: "Type a question first" });
  try {
    const { lastGood } = await agent.latest();
    if (!lastGood?.report) return res.status(409).json({ success: false, message: "Run an audit first — there's nothing to answer from yet." });
    res.json({ success: true, ...(await answerQuestion(question, lastGood.report)) });
  } catch (e) {
    console.error("[SeoAgent] ask failed:", e.message);
    res.status(502).json({ success: false, message: e.message });
  }
});

module.exports = router;
