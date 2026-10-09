const router = require("express").Router();
const crypto = require("crypto");
const { body, validationResult } = require("express-validator");
const NewsletterSubscriber = require("../models/NewsletterSubscriber");
const { protect, isAdmin } = require("../middlewares/authMiddleware");
const { newsletterLimiter } = require("../middlewares/rateLimiter");
const { enqueueEmail } = require("../utils/emailQueue");
const { sendNewsletterWelcome } = require("../utils/emailService");

const SUBSCRIBE_MESSAGE = "Thanks for subscribing! Watch your inbox for new collections and offers.";

// Absolute URL of THIS API (behind Render's proxy `trust proxy` makes req.protocol correct)
const apiBase = (req) => process.env.API_PUBLIC_URL || `${req.protocol}://${req.get("host")}`;

const page = (title, message) => `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/><title>${title}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f7f4ee;color:#232420;font-family:Inter,system-ui,sans-serif;padding:24px}
.c{max-width:440px;text-align:center;background:#fffdf9;border:1px solid rgba(20,24,30,.1);border-radius:20px;padding:40px 32px;box-shadow:0 12px 32px rgba(35,36,32,.1)}
h1{margin:0 0 12px;font-size:1.5rem}p{margin:0 0 24px;color:#5b5d58;line-height:1.6}
a{display:inline-block;background:linear-gradient(135deg,#e8623d,#d24e33);color:#fff;text-decoration:none;font-weight:600;padding:12px 22px;border-radius:12px}</style></head>
<body><div class="c"><h1>${title}</h1><p>${message}</p><a href="${process.env.FRONTEND_URL || "https://www.infinitycraftspace.com"}">Back to the shop</a></div></body></html>`;

// POST /api/newsletter/subscribe  (public)
router.post(
  "/subscribe",
  newsletterLimiter,
  [
    body("email").isString().trim().toLowerCase().isEmail().withMessage("Please enter a valid email address").isLength({ max: 254 }),
    body("source").optional().isIn(["home", "footer", "other"]),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, error: errors.array()[0].msg });
    }
    const { email } = req.body;
    const source = req.body.source || "other";

    try {
      const token = crypto.randomBytes(24).toString("hex");
      // Atomic upsert → concurrent submits of the same address can't create duplicates
      const result = await NewsletterSubscriber.findOneAndUpdate(
        { email },
        { $setOnInsert: { email, unsubscribeToken: token, source, status: "subscribed", subscribedAt: new Date() } },
        { upsert: true, new: true, includeResultMetadata: true },
      );
      const doc = result.value;
      const inserted = !result.lastErrorObject?.updatedExisting;
      let shouldWelcome = inserted;

      if (!inserted && doc.status === "unsubscribed") {
        doc.status = "subscribed";
        doc.subscribedAt = new Date();
        doc.unsubscribedAt = null;
        await doc.save();
        shouldWelcome = true;
      }

      if (shouldWelcome) {
        const unsubscribeUrl = `${apiBase(req)}/api/newsletter/unsubscribe?token=${doc.unsubscribeToken}`;
        enqueueEmail(() => sendNewsletterWelcome(email, unsubscribeUrl));
      }

      // Same answer whether the address was new or already on the list (no enumeration)
      res.status(201).json({ success: true, message: SUBSCRIBE_MESSAGE });
    } catch (err) {
      if (err.code === 11000) return res.status(201).json({ success: true, message: SUBSCRIBE_MESSAGE }); // lost a race — already subscribed
      console.error("Newsletter subscribe error:", err);
      res.status(500).json({ success: false, error: "Could not subscribe right now. Please try again." });
    }
  },
);

// GET /api/newsletter/unsubscribe?token=...  (public, linked from emails)
router.get("/unsubscribe", async (req, res) => {
  const token = typeof req.query.token === "string" ? req.query.token : "";
  if (!/^[a-f0-9]{48}$/.test(token)) {
    return res.status(400).type("html").send(page("Link not valid", "This unsubscribe link looks incomplete. Please use the link from your email."));
  }
  try {
    const sub = await NewsletterSubscriber.findOneAndUpdate(
      { unsubscribeToken: token },
      { $set: { status: "unsubscribed", unsubscribedAt: new Date() } },
    );
    if (!sub) return res.status(404).type("html").send(page("Link not valid", "We couldn't find that subscription."));
    res.type("html").send(page("You're unsubscribed", "You won't receive any more marketing emails from us. Order updates will still reach you."));
  } catch (err) {
    console.error("Newsletter unsubscribe error:", err);
    res.status(500).type("html").send(page("Something went wrong", "Please try the link again in a moment."));
  }
});

// GET /api/newsletter/admin  (admin only) — subscriber list for the dashboard / exports
router.get("/admin", protect, isAdmin, async (_req, res) => {
  try {
    const [subscribers, total, subscribed] = await Promise.all([
      NewsletterSubscriber.find().sort({ createdAt: -1 }).limit(1000).select("-unsubscribeToken").lean(),
      NewsletterSubscriber.countDocuments(),
      NewsletterSubscriber.countDocuments({ status: "subscribed" }),
    ]);
    res.json({ success: true, total, subscribed, subscribers });
  } catch (err) {
    console.error("Newsletter admin list error:", err);
    res.status(500).json({ success: false, error: "Failed to load subscribers" });
  }
});

module.exports = router;
