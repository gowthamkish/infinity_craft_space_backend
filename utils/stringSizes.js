// Artificial flower "string" products (Jasmine string, Mullai string) are sold by length,
// each length with its own admin-set price.
const STRING_SIZE_OPTIONS = [4, 8, 12, 16, 24, 32];

// Sanitise admin input into [{ inches, price }] — allowed lengths only, no dupes, valid prices.
function sanitizeStringSizes(input) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  const out = [];
  for (const s of input) {
    const inches = Number(s?.inches);
    const price = Number(s?.price);
    if (!STRING_SIZE_OPTIONS.includes(inches) || seen.has(inches)) continue;
    if (!Number.isFinite(price) || price < 0) continue;
    seen.add(inches);
    out.push({ inches, price });
  }
  return out.sort((a, b) => a.inches - b.inches);
}

const hasStringSizes = (p) => !!p?.showStringSizePicker && Array.isArray(p.stringSizes) && p.stringSizes.length > 0;

// Normalise a client-sent size to a number or null.
const parseStringSize = (v) => (v === undefined || v === null || v === "" ? null : Number(v));

// Authoritative unit price. Returns { price } or { error } when a size is required/invalid.
function resolveUnitPrice(product, stringSize) {
  if (!hasStringSizes(product)) return { price: product.price, stringSize: null };
  const entry = product.stringSizes.find((s) => s.inches === parseStringSize(stringSize));
  if (!entry) return { error: `Please select a valid size for "${product.name}"` };
  return { price: entry.price, stringSize: entry.inches };
}

module.exports = { STRING_SIZE_OPTIONS, sanitizeStringSizes, hasStringSizes, parseStringSize, resolveUnitPrice };
