/**
 * Simple in-memory cache with TTL.
 * Drop-in replacement interface for Redis — swap implementation when scaling.
 *
 * For multi-instance deployments replace with:
 *   const Redis = require("ioredis");
 *   const redis = new Redis(process.env.REDIS_URL);
 */

const store = new Map(); // key → { value, expiresAt }

const cache = {
  /**
   * Get a cached value. Returns null if missing or expired.
   */
  async get(key) {
    const entry = store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      store.delete(key);
      return null;
    }
    return entry.value;
  },

  /**
   * Set a value with TTL in seconds.
   */
  async set(key, value, ttlSeconds) {
    store.set(key, {
      value,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
  },

  /**
   * Delete a single key.
   */
  async del(key) {
    store.delete(key);
  },

  /**
   * Delete all keys matching a prefix pattern (e.g. "products:*").
   */
  async delPattern(pattern) {
    const prefix = pattern.replace(/\*$/, "");
    for (const key of store.keys()) {
      if (key.startsWith(prefix)) store.delete(key);
    }
  },

  /**
   * Flush the entire cache.
   */
  async flush() {
    store.clear();
  },
};

// Periodic cleanup of expired keys every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of store.entries()) {
    if (now > entry.expiresAt) store.delete(key);
  }
}, 5 * 60 * 1000);

module.exports = { cache };
