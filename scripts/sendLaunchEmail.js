/**
 * Launch-day announcement to everyone on the newsletter list.
 *
 *   node scripts/sendLaunchEmail.js            -> DRY RUN: only counts who would receive it
 *   node scripts/sendLaunchEmail.js --send     -> really sends (throttled; safe to re-run: nobody gets it twice)
 *
 * Needs the same env as the server (MONGO_URI, EMAIL_USER/EMAIL_PASS, FRONTEND_URL, API_PUBLIC_URL).
 */
require("dotenv").config();
const mongoose = require("mongoose");
const NewsletterSubscriber = require("../models/NewsletterSubscriber");
const { sendLaunchAnnouncement } = require("../utils/emailService");

const SEND = process.argv.includes("--send");
const DELAY_MS = 400; // gentle pace, stays within typical SMTP rate limits
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const filter = { status: "subscribed", launchEmailSentAt: null };
  const total = await NewsletterSubscriber.countDocuments(filter);
  console.log(`${total} subscriber(s) have not yet received the launch email.`);
  if (!SEND) {
    console.log("Dry run - nothing sent. Re-run with --send to send.");
    return mongoose.disconnect();
  }
  const apiBase = process.env.API_PUBLIC_URL || "http://localhost:5000";
  let sent = 0;
  let failed = 0;
  for await (const sub of NewsletterSubscriber.find(filter).cursor()) {
    const ok = await sendLaunchAnnouncement(sub.email, `${apiBase}/api/newsletter/unsubscribe?token=${sub.unsubscribeToken}`);
    if (ok) { sub.launchEmailSentAt = new Date(); await sub.save(); sent++; } else failed++;
    await sleep(DELAY_MS);
  }
  console.log(`Done. Sent ${sent}, failed ${failed}${failed ? " (re-run to retry the failed ones)" : ""}.`);
  await mongoose.disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
