/**
 * Customers see orders as "#c401a380" — the LAST 8 characters of the real 24-character id (see formatOrderId on
 * the Orders page). This turns whatever they type (that short code, a full id, or nothing = "my latest order")
 * into the real id of one of THEIR OWN orders. It never looks at anyone else's orders.
 */
const Order = require("../models/Order");

/**
 * @param {string|undefined} raw  what the customer typed, e.g. "#c401a380", "C401A380", a full id, or empty
 * @param {*} userId              the logged-in customer
 * @returns {Promise<{ id: string } | { notFound: true, message: string } | { ambiguous: true, matches: object[] }>}
 */
async function resolveUserOrderId(raw, userId) {
  const clean = String(raw ?? "").trim().replace(/^#/, "").replace(/\s+/g, "").toLowerCase();

  // "where is my order" with no number → their most recent order
  if (!clean) {
    const latest = await Order.findOne({ userId }).sort({ createdAt: -1 }).select("_id").lean();
    return latest ? { id: String(latest._id) } : { notFound: true, message: "There are no orders on this account yet." };
  }

  if (!/^[a-f0-9]{4,24}$/.test(clean)) {
    return { notFound: true, message: "That doesn't look like an order number. Order numbers look like #c401a380 and are shown on the My Orders page." };
  }

  // Full id — the order must still belong to this customer (checked by the caller's query), so just pass it on
  if (clean.length === 24) return { id: clean };

  // Short code: match the end of the id among this customer's own orders
  const mine = await Order.find({ userId }).sort({ createdAt: -1 }).limit(300).select("_id createdAt totalAmount status").lean();
  const matches = mine.filter((o) => String(o._id).endsWith(clean));
  if (matches.length === 0) return { notFound: true, message: `I couldn't find an order ending in #${clean} on this account. Please double-check the number on the My Orders page.` };
  if (matches.length > 1) {
    return {
      ambiguous: true,
      matches: matches.slice(0, 5).map((o) => ({
        orderId: `#${String(o._id).slice(-8)}`,
        placedOn: new Date(o.createdAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }),
        status: o.status,
        total: o.totalAmount,
      })),
    };
  }
  return { id: String(matches[0]._id) };
}

module.exports = { resolveUserOrderId };
