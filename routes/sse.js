/**
 * Server-Sent Events (SSE) — real-time order status push to authenticated users.
 *
 * GET /api/sse/stream  → open event stream
 *
 * Usage from frontend:
 *   const es = new EventSource(`${API_URL}/api/sse/stream`, { withCredentials: true });
 *   es.onmessage = (e) => { const data = JSON.parse(e.data); ... };
 */

const express = require("express");
const router = express.Router();
const { protect } = require("../middlewares/authMiddleware");

// In-memory client map: userId (string) → res (SSE response)
// For multi-instance deployments swap with Redis Pub/Sub.
const sseClients = new Map();

/**
 * Push an order update to a specific user's open SSE connection.
 * Called from payment.js and shipping webhook after status changes.
 */
function pushOrderUpdate(userId, order, previousStatus) {
  const client = sseClients.get(String(userId));
  if (!client) return;
  try {
    // Named event so the frontend can use addEventListener("ORDER_UPDATE")
    const payload = JSON.stringify({ order, previousStatus: previousStatus || null });
    client.write(`event: ORDER_UPDATE\ndata: ${payload}\n\n`);
  } catch (err) {
    console.warn("[SSE] Failed to push to client:", err.message);
    sseClients.delete(String(userId));
  }
}

/**
 * Push a custom event to a user.
 */
function pushEvent(userId, type, payload) {
  const client = sseClients.get(String(userId));
  if (!client) return;
  try {
    client.write(`data: ${JSON.stringify({ type, ...payload })}\n\n`);
  } catch {
    sseClients.delete(String(userId));
  }
}

// GET /api/sse/stream
router.get("/stream", protect, (req, res) => {
  const userId = req.user._id.toString();

  // SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // Disable Nginx buffering
  res.flushHeaders();

  // Register client
  sseClients.set(userId, res);
  console.log(`[SSE] Client connected: ${userId} (${sseClients.size} total)`);

  // Send initial heartbeat so the connection is confirmed
  res.write(`data: ${JSON.stringify({ type: "CONNECTED", userId })}\n\n`);

  // Keep-alive heartbeat every 25 seconds (prevents proxy timeouts)
  const heartbeat = setInterval(() => {
    try {
      res.write(": heartbeat\n\n");
    } catch {
      clearInterval(heartbeat);
    }
  }, 25_000);

  // Cleanup on disconnect
  req.on("close", () => {
    clearInterval(heartbeat);
    sseClients.delete(userId);
    console.log(`[SSE] Client disconnected: ${userId} (${sseClients.size} remaining)`);
  });
});

// Expose helpers so other modules can push updates
router.pushOrderUpdate = pushOrderUpdate;
router.pushEvent = pushEvent;

module.exports = router;
module.exports.pushOrderUpdate = pushOrderUpdate;
module.exports.pushEvent = pushEvent;
