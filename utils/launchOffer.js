/**
 * Launch-week offer: free shipping on orders above ₹999.
 * Runs for 7 days from the website launch (20 Nov 2026, 08:00 IST) and ends by itself — no redeploy needed.
 * Mirror any change in frontend/src/config/offers.js.
 */
const OFFER_START = new Date("2026-11-20T08:00:00+05:30");
const OFFER_END = new Date("2026-11-27T08:00:00+05:30");
const FREE_SHIPPING_ABOVE = 999; // strictly more than this subtotal (₹)

function isFreeShipping(subtotal, now = Date.now()) {
  return now >= OFFER_START.getTime() && now < OFFER_END.getTime() && subtotal > FREE_SHIPPING_ABOVE;
}

module.exports = { OFFER_START, OFFER_END, FREE_SHIPPING_ABOVE, isFreeShipping };
