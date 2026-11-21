/**
 * Order items only snapshot name/price, not the picture. This adds the product's current primary image
 * URL to each item (as `item.imageUrl`) so order screens can show a thumbnail. Products deleted since
 * the order was placed simply get no image (the UI shows a placeholder).
 */
const Product = require("../models/Product");

const primaryImage = (p) =>
  (p.images || []).find((i) => i?.isPrimary && i.url)?.url ||
  (p.images || []).find((i) => i?.url)?.url ||
  p.image?.url ||
  null;

/** @param {object[]} orders lean order documents — mutated and returned */
async function attachItemImages(orders) {
  const ids = new Set();
  for (const o of orders) for (const i of o.items || []) if (i.product?._id) ids.add(String(i.product._id));
  if (ids.size === 0) return orders;

  const products = await Product.find({ _id: { $in: [...ids] } }, "images image").lean();
  const byId = new Map(products.map((p) => [String(p._id), primaryImage(p)]));
  for (const o of orders) {
    for (const i of o.items || []) i.imageUrl = byId.get(String(i.product?._id)) || null;
  }
  return orders;
}

module.exports = { attachItemImages };
