/**
 * Who might be interested? — customer segments worked out from real data (orders, wishlists, carts, subscribers).
 *
 * Consent matters: only newsletter subscribers have explicitly opted in to marketing emails. Everyone else is a
 * customer we can see in our own records, but shouldn't be sent promotions without permission. Every member
 * therefore carries `optedIn`, and counts report how many are reachable.
 */
const Order = require("../models/Order");
const User = require("../models/User");
const Cart = require("../models/Cart");
const Product = require("../models/Product");
const NewsletterSubscriber = require("../models/NewsletterSubscriber");

const DAY = 864e5;
const LAPSED_DAYS = 90;
const ABANDONED_HOURS = 24;
const lc = (s) => String(s || "").trim().toLowerCase();

const SEGMENTS = {
  subscribers: { label: "Newsletter subscribers", why: "People who signed up to hear from you — the only group who have clearly said yes to marketing emails." },
  past_buyers: { label: "Bought something similar before", why: "Customers who already bought from these categories — the warmest audience for a new collection." },
  wishlist: { label: "Saved these products to their wishlist", why: "They liked these products enough to save them." },
  abandoned: { label: "Left items in their cart", why: "They added products to the cart but didn't buy." },
  repeat_buyers: { label: "Repeat customers (2+ orders)", why: "Your most loyal customers." },
  lapsed: { label: `Haven't ordered for ${LAPSED_DAYS}+ days`, why: "Past customers worth a gentle nudge." },
  all_customers: { label: "All customers who have paid for an order", why: "Everyone who has bought from you." },
};

/** Loads everything needed once, as plain lookups. */
async function loadData({ categories = [], productIds = [] } = {}) {
  const cats = new Set(categories.map(lc));
  const pids = new Set(productIds.map(String));

  // Products that belong to the campaign (for wishlist/cart matching)
  const related = cats.size || pids.size
    ? await Product.find({ isActive: { $ne: false }, $or: [{ category: { $in: categories.map((c) => new RegExp(`^${c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i")) } }, { _id: { $in: [...pids].filter((id) => /^[a-f0-9]{24}$/i.test(id)) } }] }).select("_id").lean()
    : [];
  const relatedIds = new Set([...pids, ...related.map((p) => String(p._id))]);

  const [orders, subs] = await Promise.all([
    Order.find({ paymentStatus: "completed" }).select("userId items.product._id items.product.category createdAt shippingAddress.phone").sort({ createdAt: -1 }).limit(20000).lean(),
    NewsletterSubscriber.find({ status: "subscribed" }).select("email subscribedAt").lean(),
  ]);
  const optedIn = new Set(subs.map((s) => lc(s.email)));

  const byUser = new Map(); // userId -> { orders: n, last: Date, phone, matched: bool }
  for (const o of orders) {
    const id = String(o.userId);
    const u = byUser.get(id) || { orders: 0, last: null, phone: o.shippingAddress?.phone || "", matched: false };
    u.orders++;
    if (!u.last || o.createdAt > u.last) u.last = o.createdAt;
    if (!u.matched && (o.items || []).some((i) => cats.has(lc(i.product?.category)) || relatedIds.has(String(i.product?._id)))) u.matched = true;
    byUser.set(id, u);
  }
  return { byUser, optedIn, relatedIds, subs, cats };
}

const idsOf = (arr) => arr.filter((id) => /^[a-f0-9]{24}$/i.test(String(id)));

/** Segment id → [{ userId?, email, name?, phone?, reason }] */
async function membersFor(segmentId, query = {}) {
  const d = await loadData(query);
  const now = Date.now();

  if (segmentId === "subscribers") return d.subs.map((s) => ({ email: s.email, name: "", reason: "Subscribed to the newsletter" }));

  let userIds = [];
  let reasonOf = () => "";
  if (segmentId === "past_buyers") { userIds = [...d.byUser].filter(([, u]) => u.matched).map(([id]) => id); reasonOf = () => "Bought from these categories before"; }
  else if (segmentId === "repeat_buyers") { userIds = [...d.byUser].filter(([, u]) => u.orders >= 2).map(([id]) => id); reasonOf = (id) => `${d.byUser.get(id).orders} orders`; }
  else if (segmentId === "lapsed") { userIds = [...d.byUser].filter(([, u]) => u.last && now - new Date(u.last).getTime() > LAPSED_DAYS * DAY).map(([id]) => id); reasonOf = (id) => `Last ordered ${Math.round((now - new Date(d.byUser.get(id).last).getTime()) / DAY)} days ago`; }
  else if (segmentId === "all_customers") { userIds = [...d.byUser.keys()]; reasonOf = (id) => `${d.byUser.get(id).orders} order${d.byUser.get(id).orders > 1 ? "s" : ""}`; }
  else if (segmentId === "wishlist") {
    const users = d.relatedIds.size ? await User.find({ wishlist: { $in: idsOf([...d.relatedIds]) } }).select("_id").lean() : [];
    userIds = users.map((u) => String(u._id)); reasonOf = () => "Has these products on their wishlist";
  } else if (segmentId === "abandoned") {
    const carts = await Cart.find({ "items.0": { $exists: true }, updatedAt: { $lt: new Date(now - ABANDONED_HOURS * 3600 * 1000) } }).select("userId").lean();
    userIds = carts.map((c) => String(c.userId)); reasonOf = () => "Items left in the cart";
  } else throw new Error("Unknown segment");

  const valid = idsOf(userIds);
  const users = valid.length ? await User.find({ _id: { $in: valid } }).select("username email").lean() : [];
  return users.map((u) => ({ userId: String(u._id), email: u.email, name: u.username, phone: d.byUser.get(String(u._id))?.phone || "", reason: reasonOf(String(u._id)), optedIn: d.optedIn.has(lc(u.email)) }));
}

/** Sizes of every segment for a campaign's categories/products. */
async function segmentSummary(query = {}) {
  const hasFocus = (query.categories?.length || 0) + (query.productIds?.length || 0) > 0;
  const ids = Object.keys(SEGMENTS).filter((id) => hasFocus || !["past_buyers", "wishlist"].includes(id));
  const out = [];
  for (const id of ids) {
    const members = await membersFor(id, query);
    const reachable = id === "subscribers" ? members.length : members.filter((m) => m.optedIn).length;
    out.push({ id, label: SEGMENTS[id].label, why: SEGMENTS[id].why, count: members.length, reachable });
  }
  return out;
}

/** Customers who left items in the cart and haven't bought since. (Carts live in the `Cart` collection.) */
async function abandonedCarts({ idleHours = ABANDONED_HOURS, limit = 30 } = {}) {
  const cutoff = new Date(Date.now() - idleHours * 3600 * 1000);
  const carts = await Cart.find({ "items.0": { $exists: true }, updatedAt: { $lt: cutoff } }).sort({ updatedAt: -1 }).limit(limit).lean();
  if (!carts.length) return [];
  const userIds = idsOf(carts.map((c) => c.userId));
  const [users, paid, subs] = await Promise.all([
    User.find({ _id: { $in: userIds } }).select("username email").lean(),
    Order.find({ userId: { $in: userIds }, paymentStatus: "completed" }).select("userId createdAt").lean(),
    NewsletterSubscriber.find({ status: "subscribed" }).select("email").lean(),
  ]);
  const uMap = new Map(users.map((u) => [String(u._id), u]));
  const optedIn = new Set(subs.map((s) => lc(s.email)));
  const lastPaid = new Map();
  for (const o of paid) { const k = String(o.userId); if (!lastPaid.has(k) || o.createdAt > lastPaid.get(k)) lastPaid.set(k, o.createdAt); }
  const products = await Product.find({ _id: { $in: carts.flatMap((c) => c.items.map((i) => i.productId)).filter(Boolean) } }).select("name slug price stock trackInventory isActive").lean();
  const pMap = new Map(products.map((p) => [String(p._id), p]));

  return carts
    .filter((c) => { const u = uMap.get(String(c.userId)); return u && !(lastPaid.get(String(c.userId)) > c.updatedAt); }) // skip carts followed by a purchase
    .map((c) => {
      const u = uMap.get(String(c.userId));
      const items = c.items.map((i) => ({ i, p: pMap.get(String(i.productId)) })).filter(({ p }) => p && p.isActive !== false)
        .map(({ i, p }) => ({ productId: String(p._id), name: p.name, slug: p.slug, quantity: i.quantity, price: i.priceAtTimeOfAdd || p.price, inStock: p.trackInventory === false || p.stock > 0 }));
      return { cartId: String(c._id), userId: String(c.userId), name: u.username, email: u.email, idleHours: Math.round((Date.now() - new Date(c.updatedAt).getTime()) / 3600000), items, subtotal: items.reduce((n, i) => n + i.price * i.quantity, 0), optedIn: optedIn.has(lc(u.email)) };
    })
    .filter((c) => c.items.length > 0);
}

module.exports = { SEGMENTS, membersFor, segmentSummary, abandonedCarts };
