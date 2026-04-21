/**
 * Abandoned Cart Recovery Job
 * Runs daily at 10:00 AM via node-cron (wired in server.js).
 *
 * Logic:
 *  - Find carts abandoned > 24h ago where reminder hasn't been sent (or < 3 total)
 *  - Send recovery email with a tokenised link
 *  - Mark reminderSent = true, increment remindersCount
 */

const AbandonedCart = require("../models/AbandonedCart");
const { enqueueEmail } = require("../utils/emailQueue");
const { sendAbandonedCartReminder } = require("../utils/emailService");
const crypto = require("crypto");

const FRONTEND_URL = process.env.FRONTEND_URL || "https://www.infinitycraftspace.com";
const MAX_REMINDERS = 3;
const ABANDON_HOURS = 24;

module.exports = async function abandonedCartJob() {
  try {
    const cutoff = new Date(Date.now() - ABANDON_HOURS * 60 * 60 * 1000);

    const carts = await AbandonedCart.find({
      abandoned: true,
      recoveredAt: null,
      remindersCount: { $lt: MAX_REMINDERS },
      createdAt: { $lte: cutoff },
      $or: [
        { reminderSent: false },
        // Allow a second reminder 48h after the first
        { lastReminderAt: { $lte: new Date(Date.now() - 48 * 60 * 60 * 1000) } },
      ],
    })
      .populate("items.product", "name price images")
      .limit(200) // safety cap per run
      .lean();

    console.log(`[AbandonedCartJob] Found ${carts.length} carts to remind`);

    for (const cart of carts) {
      const token = crypto.randomBytes(16).toString("hex");
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const recoveryLink = `${FRONTEND_URL}/cart/recover?token=${token}`;

      const cartItems = (cart.items || []).map((item) => ({
        productName: item.productName || item.product?.name || "Product",
        quantity: item.quantity,
        price: item.price || item.product?.price,
      }));

      const user = { username: cart.userEmail.split("@")[0], email: cart.userEmail };

      enqueueEmail(() => sendAbandonedCartReminder(user, cartItems, recoveryLink));

      await AbandonedCart.findByIdAndUpdate(cart._id, {
        reminderSent: true,
        $inc: { remindersCount: 1 },
        lastReminderAt: new Date(),
        "recoveryLink.token": token,
        "recoveryLink.expiresAt": expiresAt,
      });
    }

    console.log(`[AbandonedCartJob] Queued ${carts.length} reminder emails`);
  } catch (err) {
    console.error("[AbandonedCartJob] Error:", err.message);
  }
};
