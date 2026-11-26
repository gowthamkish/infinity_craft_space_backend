// Short in-memory cache for the public product list (GET /api/products).
// Any product write through Mongoose clears it (hooks in models/Product.js); the TTL covers writes made
// elsewhere, e.g. from a local server sharing the same database.
const TTL_MS = 60 * 1000;
const MAX_ENTRIES = 200;

const store = new Map();
let version = 0;

exports.version = () => version;

exports.get = (key) => {
  const hit = store.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > TTL_MS) { store.delete(key); return null; }
  return hit.body;
};

/** `startedAt` is version() taken before the query, so a result that raced with a write is never stored. */
exports.set = (key, body, startedAt) => {
  if (startedAt !== version) return;
  if (store.size >= MAX_ENTRIES) store.delete(store.keys().next().value);
  store.set(key, { body, at: Date.now() });
};

exports.clear = () => { version++; store.clear(); };
