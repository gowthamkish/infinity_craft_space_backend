/**
 * Scheduler for the blog agent.
 *
 * The schedule lives in the database (BlogAgentConfig), so changing "every N days / at what hour / on or off"
 * in Admin → Blog takes effect immediately — no redeploy.
 *
 * "Is a run due?" is checked by tick(), which is called from three places so a run is never missed:
 *   1. an in-process cron every 15 minutes,
 *   2. shortly after the server boots (catches a run that came due while the host was asleep),
 *   3. POST/GET /api/blog-agent/tick — for an external pinger (UptimeRobot / cron-job.org), which also keeps a
 *      free-tier host awake.
 * A database lock guarantees two ticks can never write two posts at once.
 */
const BlogAgentConfig = require("../models/BlogAgentConfig");
const BlogAgentRun = require("../models/BlogAgentRun");
const Notification = require("../models/Notification");
const { runBlogAgent, nextPillar, MODEL } = require("./blogAgent");

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const LOCK_TIMEOUT_MS = 20 * 60 * 1000; // a run that has been "running" longer than this is considered dead
const MAX_CONSECUTIVE_FAILURES = 5;

/** The given hour (IST) on the same IST calendar day as `date`. */
function atHourIST(date, hourIST) {
  const ist = new Date(date.getTime() + IST_OFFSET_MS);
  ist.setUTCHours(hourIST, 0, 0, 0);
  return new Date(ist.getTime() - IST_OFFSET_MS);
}

/** Next time (from now) it is `hourIST` o'clock in India. */
function nextOccurrence(hourIST, now = new Date()) {
  const today = atHourIST(now, hourIST);
  return today.getTime() > now.getTime() ? today : new Date(today.getTime() + DAY_MS);
}

/** When the run after a run at `from` is due. */
function nextRunAfter(from, intervalDays, hourIST) {
  return atHourIST(new Date(from.getTime() + intervalDays * DAY_MS), hourIST);
}

/** Loads (creating on first use) the single config document. */
async function getConfig() {
  let cfg = await BlogAgentConfig.findOne({ key: "default" });
  if (!cfg) {
    try {
      cfg = await BlogAgentConfig.create({ key: "default", nextRunAt: nextOccurrence(10) });
    } catch (e) {
      cfg = await BlogAgentConfig.findOne({ key: "default" }); // another instance created it first
    }
  }
  return cfg;
}

const publicOrigin = () => (process.env.FRONTEND_URL || "https://www.infinitycraftspace.com").replace(/\/+$/, "");

async function notifyAdmin(message, meta = {}) {
  await Notification.create({ type: "system", message, read: false, meta }).catch(() => {});
}

async function emailAdmin(subject, html) {
  try {
    const { sendAdminNotification } = require("../utils/emailService");
    await sendAdminNotification(subject, html);
  } catch (e) {
    console.error("[BlogAgent] Admin email failed:", e.message);
  }
}

/** The actual work of one run. Never throws. */
async function executeRun(run, config) {
  const finish = {};
  let failed = null;
  try {
    const pillar = await nextPillar();
    run.pillar = pillar.label;
    await run.save();

    const { post, usage } = await runBlogAgent({
      config,
      runId: run._id,
      pillar,
      onStep: (tool, note) => run.steps.push({ tool, note }),
    });

    finish.status = "succeeded";
    finish.postId = post._id;
    finish.postTitle = post.title;
    finish.published = post.status === "published";
    finish.usage = usage;

    const editUrl = `${publicOrigin()}/admin/blog/${post._id}`;
    if (finish.published) {
      await notifyAdmin(`📝 Blog agent published: “${post.title}”`, { postId: post._id });
    } else {
      await notifyAdmin(`📝 New blog draft ready for your review: “${post.title}”`, { postId: post._id });
      await emailAdmin(
        `📝 Blog draft ready for review: ${post.title}`,
        `<div style="font-family:Arial,sans-serif;max-width:600px"><h2>A new blog post is ready</h2><p><strong>${post.title.replace(/</g, "&lt;")}</strong></p><p>${post.excerpt.replace(/</g, "&lt;")}</p><p><a href="${editUrl}" style="background:#e8623d;color:#fff;padding:10px 20px;border-radius:5px;text-decoration:none">Review &amp; publish</a></p><p style="color:#666;font-size:12px">Written by the blog agent (${MODEL}). Please read it before publishing.</p></div>`,
      );
    }
  } catch (err) {
    failed = err;
    finish.status = "failed";
    finish.error = String(err?.message || err).slice(0, 600);
    console.error("[BlogAgent] Run failed:", finish.error);
  }

  // Update the run record
  run.set({ ...finish, finishedAt: new Date() });
  await run.save().catch((e) => console.error("[BlogAgent] Could not save run:", e.message));

  // Update the schedule
  const now = new Date();
  const cfg = await BlogAgentConfig.findOne({ key: "default" });
  if (cfg) {
    if (!failed) {
      cfg.lastRunAt = now;
      cfg.nextRunAt = nextRunAfter(now, cfg.intervalDays, cfg.runHourIST);
      cfg.consecutiveFailures = 0;
    } else {
      cfg.consecutiveFailures += 1;
      // Back off: retry in 6h, 12h, 18h… (max 24h), and stop trying after repeated failures
      cfg.nextRunAt = new Date(now.getTime() + Math.min(cfg.consecutiveFailures * 6, 24) * 3600 * 1000);
      await notifyAdmin(`⚠️ Blog agent failed (attempt ${cfg.consecutiveFailures}): ${finish.error}`);
      if (cfg.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        cfg.enabled = false;
        await notifyAdmin(`⛔ Blog agent paused after ${MAX_CONSECUTIVE_FAILURES} failures in a row. Fix the problem, then switch it back on in Admin → Blog.`);
        await emailAdmin("⛔ Blog agent paused", `<p>The blog agent failed ${MAX_CONSECUTIVE_FAILURES} times in a row and has been switched off. Last error:</p><pre>${finish.error.replace(/</g, "&lt;")}</pre>`);
      }
    }
    cfg.runningSince = null;
    await cfg.save();
  }
}

/**
 * Start a run now (if none is already running). Returns immediately; the agent keeps working in the background.
 * @returns {Promise<{ started: boolean, reason?: string, runId?: string }>}
 */
async function startRun(trigger) {
  if (!process.env.ANTHROPIC_API_KEY) return { started: false, reason: "ANTHROPIC_API_KEY is not set on the server" };
  await getConfig();

  const now = new Date();
  // Atomic lock: succeeds only if nothing is running (or the previous run died long ago)
  const locked = await BlogAgentConfig.findOneAndUpdate(
    { key: "default", $or: [{ runningSince: null }, { runningSince: { $lt: new Date(now.getTime() - LOCK_TIMEOUT_MS) } }] },
    { $set: { runningSince: now } },
    { new: true },
  );
  if (!locked) return { started: false, reason: "The agent is already writing a post" };

  // A previous run that died without finishing shouldn't stay "running" forever
  await BlogAgentRun.updateMany({ status: "running" }, { $set: { status: "failed", error: "Interrupted (server restarted or timed out)", finishedAt: now } });

  const run = await BlogAgentRun.create({ trigger, model: MODEL, status: "running" });
  // Fire and forget — executeRun never throws and always releases the lock
  executeRun(run, locked).catch(async (e) => {
    console.error("[BlogAgent] Unexpected error:", e);
    await BlogAgentConfig.updateOne({ key: "default" }, { $set: { runningSince: null } }).catch(() => {});
  });
  return { started: true, runId: String(run._id) };
}

/** Starts a scheduled run if one is due. Safe to call as often as you like. */
async function tick() {
  const cfg = await getConfig();
  if (!cfg.enabled) return { started: false, reason: "disabled" };
  if (!cfg.nextRunAt || cfg.nextRunAt.getTime() > Date.now()) return { started: false, reason: "not due", nextRunAt: cfg.nextRunAt };
  return startRun("schedule");
}

/** Call once at server start. */
function startScheduler(cron) {
  cron.schedule("*/15 * * * *", () => {
    tick().then((r) => r.started && console.log("[BlogAgent] Scheduled run started"), (e) => console.error("[BlogAgent] Tick error:", e.message));
  });
  // Catch up on a run that came due while the host was asleep or restarting
  setTimeout(() => tick().catch((e) => console.error("[BlogAgent] Boot tick error:", e.message)), 30 * 1000);
  console.log("[BlogAgent] Scheduler ready (checks every 15 min)");
}

module.exports = { getConfig, tick, startRun, startScheduler, nextOccurrence, nextRunAfter, atHourIST };
