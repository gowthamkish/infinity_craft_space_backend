/**
 * Lightweight in-process email queue.
 * Decouples email sending from request/response lifecycle.
 * For high-volume production use, swap for BullMQ + Redis.
 */

const queue = [];
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
  while (queue.length > 0) {
    const fn = queue.shift();
    try {
      await fn();
    } catch (err) {
      console.error("[EmailQueue] Failed to send email:", err.message);
    }
    // Throttle: 100ms between sends to avoid SMTP rate limits
    await new Promise((r) => setTimeout(r, 100));
  }
  processing = false;
}

module.exports = { enqueueEmail };
