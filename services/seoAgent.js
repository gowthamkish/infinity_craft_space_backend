/**
 * SEO & website-health agent — runs the audit (services/seoAudit.js), stores the report, and keeps it fresh:
 * an in-process check every 6 hours, a catch-up shortly after the server boots, and (for free-tier hosts that
 * sleep) the same /tick endpoint the blog agent uses. A weekly audit emails you a short summary.
 */
const SeoAuditRun = require("../models/SeoAuditRun");
const Notification = require("../models/Notification");
const { runAudit } = require("./seoAudit");

const LOCK_MS = 15 * 60 * 1000; // an audit "running" longer than this is considered dead
const EVERY_MS = 7 * 24 * 60 * 60 * 1000; // weekly

const publicOrigin = () => (process.env.FRONTEND_URL || "https://infinitycraftspace.com").replace(/\/+$/, "");
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

async function emailSummary(report, previous) {
  try {
    const { sendAdminNotification } = require("../utils/emailService");
    const s = report.scores.overall;
    const delta = previous?.report?.scores ? s - previous.report.scores.overall : null;
    const arrow = delta === null ? "" : delta > 0 ? ` (▲ ${delta})` : delta < 0 ? ` (▼ ${-delta})` : " (no change)";
    const rows = report.actions.slice(0, 5).map((a) => `<li><strong>${esc(a.title)}</strong><br/><span style="color:#555">${esc(a.fix || a.detail || "")}</span></li>`).join("");
    await sendAdminNotification(
      `SEO health: ${s}/100${arrow}`,
      `<div style="font-family:Arial,sans-serif;max-width:600px"><h2>Your weekly SEO check: ${s}/100${arrow}</h2><p>${report.counts.critical} critical and ${report.counts.warning} warnings across ${report.counts.products} products.</p><h3>Fix these first</h3><ol>${rows}</ol><p><a href="${publicOrigin()}/admin/seo" style="background:#e8623d;color:#fff;padding:10px 20px;border-radius:5px;text-decoration:none">Open the full report</a></p></div>`,
    );
  } catch (e) {
    console.error("[SeoAgent] Summary email failed:", e.message);
  }
}

async function execute(run) {
  const previous = await SeoAuditRun.findOne({ status: "succeeded", _id: { $ne: run._id } }).sort({ startedAt: -1 }).lean();
  try {
    const report = await runAudit();
    run.set({ status: "succeeded", report, finishedAt: new Date() });
    await run.save();
    const s = report.scores.overall;
    await Notification.create({ type: "system", message: `🔎 SEO check finished: ${s}/100 — ${report.counts.critical} critical issue${report.counts.critical === 1 ? "" : "s"}`, read: false }).catch(() => {});
    if (run.trigger === "schedule") await emailSummary(report, previous);
  } catch (err) {
    console.error("[SeoAgent] Audit failed:", err.message);
    run.set({ status: "failed", error: String(err.message || err).slice(0, 500), finishedAt: new Date() });
    await run.save().catch(() => {});
  }
}

/** Start an audit in the background unless one is already running. */
async function startAudit(trigger) {
  const since = new Date(Date.now() - LOCK_MS);
  await SeoAuditRun.updateMany({ status: "running", startedAt: { $lt: since } }, { $set: { status: "failed", error: "Interrupted (server restarted or timed out)", finishedAt: new Date() } });
  if (await SeoAuditRun.exists({ status: "running" })) return { started: false, reason: "An audit is already running" };
  const run = await SeoAuditRun.create({ trigger, status: "running" });
  execute(run).catch((e) => console.error("[SeoAgent] Unexpected error:", e));
  return { started: true, runId: String(run._id) };
}

async function latest() {
  const [running, last] = await Promise.all([
    SeoAuditRun.findOne({ status: "running", startedAt: { $gt: new Date(Date.now() - LOCK_MS) } }).select("startedAt trigger").lean(),
    SeoAuditRun.findOne({ status: { $in: ["succeeded", "failed"] } }).sort({ startedAt: -1 }).lean(),
  ]);
  const lastGood = last?.status === "succeeded" ? last : await SeoAuditRun.findOne({ status: "succeeded" }).sort({ startedAt: -1 }).lean();
  return { running: Boolean(running), runningSince: running?.startedAt || null, last, lastGood };
}

async function history(limit = 12) {
  const runs = await SeoAuditRun.find({ status: "succeeded" }).sort({ startedAt: -1 }).limit(limit).select("startedAt trigger report.scores report.counts").lean();
  return runs.map((r) => ({ _id: r._id, startedAt: r.startedAt, trigger: r.trigger, scores: r.report?.scores, counts: r.report?.counts }));
}

/** Weekly: start an audit if none succeeded in the last 7 days. */
async function tick() {
  const last = await SeoAuditRun.findOne({ status: "succeeded" }).sort({ startedAt: -1 }).select("startedAt").lean();
  if (last && Date.now() - new Date(last.startedAt).getTime() < EVERY_MS) return { started: false, reason: "not due" };
  return startAudit("schedule");
}

function startScheduler(cron) {
  cron.schedule("0 */6 * * *", () => { tick().catch((e) => console.error("[SeoAgent] Tick error:", e.message)); });
  setTimeout(() => tick().catch((e) => console.error("[SeoAgent] Boot tick error:", e.message)), 60 * 1000);
  console.log("[SeoAgent] Weekly audit scheduler ready");
}

module.exports = { startAudit, latest, history, tick, startScheduler };
