/**
 * Lightweight in-process email queue.
 * Decouples email sending from request/response lifecycle.
 * For high-volume production use, swap for BullMQ + Redis.
 */

// FIFO queue backed by an array + head index. Array.shift() is O(n) (it
// re-indexes every element), which makes draining a large burst — e.g.
// back-in-stock alerts to many subscribers — O(n²). Advancing a head pointer
// is O(1); the consumed prefix is dropped once the queue drains.
let queue = [];
let head = 0;
let processing = false;

/**
 * Enqueue an email-sending function to run asynchronously.
 * @param {Function} emailFn - Async function that sends the email.
 */
function enqueueEmail(emailFn) {
  queue.push(emailFn);
  if (!processing) _processQueue();
}

async function _processQueue() {
  processing = true;
  while (head < queue.length) {
    const fn = queue[head];
    queue[head++] = undefined; // release the closure for GC
    try {
      await fn();
    } catch (err) {
      console.error("[EmailQueue] Failed to send email:", err.message);
    }
    // Throttle: 100ms between sends to avoid SMTP rate limits
    await new Promise((r) => setTimeout(r, 100));
  }
  queue = [];
  head = 0;
  processing = false;
}

module.exports = { enqueueEmail };
