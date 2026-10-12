/**
 * Sends ONE test copy of the launch emails to an address, to check that email delivery works.
 *
 *   node scripts/sendTestEmail.js you@example.com             -> launch confirmation (what "Notify me" subscribers get)
 *   node scripts/sendTestEmail.js you@example.com announce    -> the launch-day "We're live!" email
 *
 * Needs EMAIL_USER and EMAIL_PASSWORD (Gmail: an App Password) in .env; EMAIL_HOST/EMAIL_PORT/EMAIL_FROM optional.
 * Nothing is saved to the database. The unsubscribe link in a test email is not a real subscription.
 */
require("dotenv").config();
const { sendLaunchWaitlistConfirmation, sendLaunchAnnouncement } = require("../utils/emailService");

const to = process.argv[2];
const which = process.argv[3] === "announce" ? "announce" : "confirmation";

if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(to)) {
  console.error("Usage: node scripts/sendTestEmail.js <email> [announce]");
  process.exit(1);
}
const missing = ["EMAIL_USER", "EMAIL_PASSWORD"].filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`Cannot send: ${missing.join(" and ")} ${missing.length > 1 ? "are" : "is"} not set in .env`);
  process.exit(1);
}

(async () => {
  const unsubscribeUrl = `${process.env.API_PUBLIC_URL || "http://localhost:5000"}/api/newsletter/unsubscribe?token=test`;
  const send = which === "announce" ? sendLaunchAnnouncement : sendLaunchWaitlistConfirmation;
  const ok = await send(to, unsubscribeUrl);
  console.log(ok ? `Sent the "${which}" email to ${to}. Check the inbox (and Spam/Junk).` : "Sending failed — see the error logged above.");
  process.exit(ok ? 0 : 1);
})();
