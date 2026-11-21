/**
 * Coupon rules — the single source of truth for what a coupon is worth.
 * Used by POST /api/coupons/validate (preview in the cart) and POST /api/payment (what is charged).
 */
const Coupon = require("../models/Coupon");

class CouponError extends Error {}

const round2 = (n) => Math.round(n * 100) / 100;

/** Discount (₹) a coupon gives on a product subtotal. Never more than the subtotal. */
function discountFor(coupon, subtotal) {
  let discount =
    coupon.discountType === "percentage"
      ? (subtotal * coupon.discountValue) / 100
      : coupon.discountValue;
  if (coupon.discountType === "percentage" && coupon.maxDiscount) {
    discount = Math.min(discount, coupon.maxDiscount);
  }
  return round2(Math.max(0, Math.min(discount, subtotal)));
}

/**
 * Looks up and checks a coupon for this cart. Throws CouponError with a customer-facing message.
 * @param {{ code: string, subtotal: number, userId?: any }} args
 * @returns {Promise<{ coupon: object, discount: number }>}
 */
async function evaluateCoupon({ code, subtotal, userId = null }) {
  const normalised = String(code || "").trim().toUpperCase();
  if (!normalised) throw new CouponError("Please enter a coupon code");

  const now = new Date();
  const coupon = await Coupon.findOne({
    code: normalised,
    isActive: true,
    validFrom: { $lte: now },
    $or: [{ validUntil: { $gte: now } }, { validUntil: null }],
  }).lean();
  if (!coupon) throw new CouponError("Invalid or expired coupon code");

  if (coupon.maxUses && coupon.useCount >= coupon.maxUses) {
    throw new CouponError("Coupon usage limit exceeded");
  }
  if (coupon.minCartValue && subtotal < coupon.minCartValue) {
    throw new CouponError(`Minimum cart value of ₹${coupon.minCartValue} required for ${coupon.code}`);
  }
  if (userId && coupon.maxUsesPerUser) {
    const mine = (coupon.usedBy || []).find((u) => String(u.userId) === String(userId));
    if (mine && mine.usedCount >= coupon.maxUsesPerUser) {
      throw new CouponError("You have already used this coupon");
    }
  }

  return { coupon, discount: discountFor(coupon, subtotal) };
}

/** Records one use of a coupon by a user (call once, when the order is paid). */
async function recordCouponUse(code, userId, session = null) {
  const opts = session ? { session } : {};
  const now = new Date();
  const bumped = await Coupon.updateOne(
    { code, "usedBy.userId": userId },
    { $inc: { useCount: 1, "usedBy.$.usedCount": 1 }, $set: { "usedBy.$.lastUsedAt": now } },
    opts,
  );
  if (bumped.matchedCount === 0) {
    await Coupon.updateOne(
      { code },
      { $inc: { useCount: 1 }, $push: { usedBy: { userId, usedCount: 1, lastUsedAt: now } } },
      opts,
    );
  }
}

/** Gives a use back (e.g. the order was cancelled and refunded). */
async function releaseCouponUse(code, userId) {
  await Coupon.updateOne(
    { code, "usedBy.userId": userId, "usedBy.usedCount": { $gt: 0 } },
    { $inc: { useCount: -1, "usedBy.$.usedCount": -1 } },
  );
}

module.exports = { CouponError, evaluateCoupon, discountFor, recordCouponUse, releaseCouponUse };
