/**
 * Blog agent control.
 *   Admin : GET /api/blog-agent/config · PUT /api/blog-agent/config · POST /api/blog-agent/run · GET /api/blog-agent/runs
 *   Pinger: GET|POST /api/blog-agent/tick  (header x-cron-secret, or ?key=) — for UptimeRobot / cron-job.org
 */
const express = require("express");
const crypto = require("crypto");
const router = express.Router();
const { protect, isAdmin } = require("../middlewares/authMiddleware");
const BlogAgentRun = require("../models/BlogAgentRun");
const { getConfig, tick, startRun, nextOccurrence, nextRunAfter } = require("../services/blogAgentScheduler");
const { MODEL } = require("../services/blogAgent");

const configView = (cfg) => ({
  enabled: cfg.enabled,
  intervalDays: cfg.intervalDays,
  runHourIST: cfg.runHourIST,
  autoPublish: cfg.autoPublish,
  focusNotes: cfg.focusNotes,
  lastRunAt: cfg.lastRunAt,
  nextRunAt: cfg.nextRunAt,
  running: Boolean(cfg.runningSince),
  consecutiveFailures: cfg.consecutiveFailures,
  model: MODEL,
  apiKeyConfigured: Boolean(process.env.ANTHROPIC_API_KEY),
  externalTickEnabled: Boolean(process.env.BLOG_AGENT_TICK_SECRET),
});

// ── External trigger (no login — protected by a shared secret) ───────────────
const safeEqual = (a, b) => {
  const x = Buffer.from(String(a || ""));
  const y = Buffer.from(String(b || ""));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
async function tickHandler(req, res) {
  const secret = process.env.BLOG_AGENT_TICK_SECRET;
  if (!secret) return res.status(404).json({ success: false });
  if (!safeEqual(req.get("x-cron-secret") || req.query.key, secret)) return res.status(401).json({ success: false });
  try {
    const r = await tick();
    res.status(r.started ? 202 : 200).json({ success: true, ...r });
  } catch (e) {
    console.error("[BlogAgent] Tick endpoint error:", e.message);
    res.status(500).json({ success: false });
  }
}
router.get("/tick", tickHandler);
router.post("/tick", tickHandler);

// ── Admin ────────────────────────────────────────────────────────────────────
router.use(protect, isAdmin);

router.get("/config", async (_req, res) => {
  res.json({ success: true, config: configView(await getConfig()) });
});

router.put("/config", async (req, res) => {
  try {
    const cfg = await getConfig();
    const b = req.body || {};
    const wasEnabled = cfg.enabled;
    const oldInterval = cfg.intervalDays;
    const oldHour = cfg.runHourIST;

    if (b.enabled !== undefined) cfg.enabled = Boolean(b.enabled);
    if (b.autoPublish !== undefined) cfg.autoPublish = Boolean(b.autoPublish);
    if (b.focusNotes !== undefined) cfg.focusNotes = String(b.focusNotes).trim().slice(0, 500);
    if (b.intervalDays !== undefined) {
      const n = Number(b.intervalDays);
      if (!Number.isInteger(n) || n < 1 || n > 30) return res.status(400).json({ success: false, message: "Interval must be 1–30 days" });
      cfg.intervalDays = n;
    }
    if (b.runHourIST !== undefined) {
      const h = Number(b.runHourIST);
      if (!Number.isInteger(h) || h < 0 || h > 23) return res.status(400).json({ success: false, message: "Hour must be 0–23" });
      cfg.runHourIST = h;
    }

    // Re-plan the next run when the schedule changes or the agent is switched back on
    if (cfg.enabled && !wasEnabled) {
      // Switched back on: start fresh at the next scheduled hour
      cfg.consecutiveFailures = 0;
      cfg.nextRunAt = nextOccurrence(cfg.runHourIST);
    } else if (cfg.intervalDays !== oldInterval || cfg.runHourIST !== oldHour) {
      let next = cfg.lastRunAt ? nextRunAfter(cfg.lastRunAt, cfg.intervalDays, cfg.runHourIST) : nextOccurrence(cfg.runHourIST);
      if (next.getTime() < Date.now()) next = nextOccurrence(cfg.runHourIST);
      cfg.nextRunAt = next;
    }
    await cfg.save();
    res.json({ success: true, config: configView(cfg) });
  } catch (e) {
    console.error("[BlogAgent] Save config failed:", e.message);
    res.status(500).json({ success: false, message: "Could not save the settings" });
  }
});

router.post("/run", async (_req, res) => {
  try {
    const r = await startRun("manual");
    if (!r.started) return res.status(409).json({ success: false, message: r.reason });
    res.status(202).json({ success: true, runId: r.runId });
  } catch (e) {
    console.error("[BlogAgent] Manual run failed to start:", e.message);
    res.status(500).json({ success: false, message: "Could not start the agent" });
  }
});

router.get("/runs", async (_req, res) => {
  const runs = await BlogAgentRun.find({}).sort({ startedAt: -1 }).limit(15).lean();
  res.json({ success: true, runs });
});

module.exports = router;
