/**
 * WhatsApp Cloud API Service (Meta)
 *
 * Setup:
 *  1. Create a Meta App at developers.facebook.com → WhatsApp → Getting Started
 *  2. Add a phone number and get a temporary/permanent access token
 *  3. Submit message templates in Meta Business Manager (Templates tab)
 *  4. Set env vars: WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_ADMIN_PHONE
 *
 * Template names used (must be approved in Meta Business Manager):
 *  - ic_order_placed_admin      (admin alert — new order)
 *  - ic_order_confirmed         (customer — confirmed)
 *  - ic_order_processing        (customer — processing)
 *  - ic_order_shipped           (customer — shipped)
 *  - ic_order_out_for_delivery  (customer — out for delivery)
 *  - ic_order_delivered         (customer — delivered)
 *  - ic_order_cancelled         (customer — cancelled)
 */

const https = require("https");
const WhatsAppLog = require("../models/WhatsAppLog");

const GRAPH_API_VERSION = "v19.0";
const BASE_URL = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

// ─── Template definitions ─────────────────────────────────────────────────────
// Each template maps to a Meta-approved template name + parameter builder.
// Variables are positional: {{1}}, {{2}}, ... in the approved template body.
// Register these exact names & bodies in Meta Business Manager.

const TEMPLATES = {
  // ── Admin: new order placed ────────────────────────────────────────────────
  // Template body (example):
  //   "🛒 New Order Alert!
  //    Order ID: #{{1}}
  //    Customer: {{2}} ({{3}})
  //    Products: {{4}}
  //    Total: ₹{{5}}
  //    Payment: {{6}}
  //    Address: {{7}}
  //    Time: {{8}}"
  order_placed_admin: {
    name: "ic_order_placed_admin",
    language: "en",
    buildParams: ({ shortId, customerName, customerPhone, products, total, paymentStatus, address, time }) => [
      shortId,
      customerName,
      customerPhone || "N/A",
      products,
      total,
      paymentStatus,
      address,
      time,
    ],
  },

  // ── Customer: order confirmed ──────────────────────────────────────────────
  // "Hi {{1}}! 🎉 Your order #{{2}} has been confirmed.
  //  We're preparing your items and will notify you when they ship.
  //  Total: ₹{{3}} | Questions? Reply here."
  order_confirmed: {
    name: "ic_order_confirmed",
    language: "en",
    buildParams: ({ customerName, shortId, total }) => [customerName, shortId, total],
  },

  // ── Customer: processing ───────────────────────────────────────────────────
  // "Hi {{1}}! ⏳ Order #{{2}} is now being processed.
  //  Our team is carefully packing your items. You'll get a shipping update soon!"
  order_processing: {
    name: "ic_order_processing",
    language: "en",
    buildParams: ({ customerName, shortId }) => [customerName, shortId],
  },

  // ── Customer: shipped ─────────────────────────────────────────────────────
  // "Hi {{1}}! 🚚 Great news! Order #{{2}} has been shipped.
  //  Estimated delivery: {{3}}. We'll notify you when it's out for delivery."
  order_shipped: {
    name: "ic_order_shipped",
    language: "en",
    buildParams: ({ customerName, shortId, eta }) => [customerName, shortId, eta || "2–5 business days"],
  },

  // ── Customer: out for delivery ─────────────────────────────────────────────
  // "Hi {{1}}! 🛵 Your order #{{2}} is out for delivery today!
  //  Please keep your phone handy. Delivery expected by end of day."
  order_out_for_delivery: {
    name: "ic_order_out_for_delivery",
    language: "en",
    buildParams: ({ customerName, shortId }) => [customerName, shortId],
  },

  // ── Customer: delivered ────────────────────────────────────────────────────
  // "Hi {{1}}! 🎉 Your order #{{2}} has been delivered!
  //  We hope you love your purchase. Have questions? Reply here. Thank you!"
  order_delivered: {
    name: "ic_order_delivered",
    language: "en",
    buildParams: ({ customerName, shortId }) => [customerName, shortId],
  },

  // ── Customer: cancelled ────────────────────────────────────────────────────
  // "Hi {{1}}, your order #{{2}} has been cancelled.
  //  If a payment was made, a refund will be processed in 5–7 business days.
  //  Need help? Reply here."
  order_cancelled: {
    name: "ic_order_cancelled",
    language: "en",
    buildParams: ({ customerName, shortId }) => [customerName, shortId],
  },
};

// Status → template key mapping
const STATUS_TEMPLATE_MAP = {
  confirmed:        "order_confirmed",
  processing:       "order_processing",
  shipped:          "order_shipped",
  out_for_delivery: "order_out_for_delivery",
  delivered:        "order_delivered",
  cancelled:        "order_cancelled",
};

// ─── Core API call ────────────────────────────────────────────────────────────

function isConfigured() {
  return !!(
    process.env.WHATSAPP_ACCESS_TOKEN &&
    process.env.WHATSAPP_PHONE_NUMBER_ID
  );
}

/**
 * Send a template message via WhatsApp Cloud API.
 * Returns { messageId } on success, throws on failure.
 */
async function sendTemplateMessage(to, templateKey, params) {
  if (!isConfigured()) {
    throw new Error("WhatsApp not configured — set WHATSAPP_ACCESS_TOKEN and WHATSAPP_PHONE_NUMBER_ID");
  }

  const template = TEMPLATES[templateKey];
  if (!template) throw new Error(`Unknown template key: ${templateKey}`);

  const phone = normalizePhone(to);
  if (!phone) throw new Error(`Invalid phone number: ${to}`);

  const body = JSON.stringify({
    messaging_product: "whatsapp",
    to: phone,
    type: "template",
    template: {
      name: template.name,
      language: { code: template.language },
      components: [
        {
          type: "body",
          parameters: params.map((p) => ({ type: "text", text: String(p) })),
        },
      ],
    },
  });

  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_ACCESS_TOKEN;

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "graph.facebook.com",
        path: `/${GRAPH_API_VERSION}/${phoneNumberId}/messages`,
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data);
            if (res.statusCode >= 200 && res.statusCode < 300 && parsed.messages?.[0]?.id) {
              resolve({ messageId: parsed.messages[0].id });
            } else {
              const errMsg = parsed.error?.message || `HTTP ${res.statusCode}: ${data}`;
              reject(new Error(errMsg));
            }
          } catch {
            reject(new Error(`Non-JSON response: ${data.slice(0, 200)}`));
          }
        });
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ─── Phone number normalisation ───────────────────────────────────────────────

function normalizePhone(raw) {
  if (!raw) return null;
  // Strip all non-digits
  const digits = String(raw).replace(/\D/g, "");
  if (!digits) return null;
  // Indian numbers: if 10 digits, add country code
  if (digits.length === 10) return `91${digits}`;
  // Already has country code (10+ digits)
  if (digits.length >= 11) return digits;
  return null;
}

// ─── Public helpers ───────────────────────────────────────────────────────────

/**
 * Send + log a WhatsApp message with up to 3 retries (with exponential backoff).
 * Fire-and-forget safe — call without await in non-critical paths.
 */
async function sendWhatsApp({ to, templateKey, templateParams, orderId, userId, eventType }) {
  if (!isConfigured()) {
    console.warn("[WhatsApp] Not configured — skipping notification");
    return;
  }

  const template = TEMPLATES[templateKey];
  const log = await WhatsAppLog.create({
    to,
    userId,
    orderId,
    templateName: template?.name || templateKey,
    variables: templateParams.map(String),
    status: "pending",
    eventType,
    attempts: 0,
    maxAttempts: 3,
  });

  const attempt = async (retryCount) => {
    log.attempts = retryCount + 1;
    try {
      const { messageId } = await sendTemplateMessage(to, templateKey, templateParams);
      log.status = "sent";
      log.messageId = messageId;
      await log.save();
      console.log(`[WhatsApp] ✓ Sent ${templateKey} → ${to} (msgId: ${messageId})`);
    } catch (err) {
      console.error(`[WhatsApp] ✗ Attempt ${retryCount + 1} failed for ${to}:`, err.message);
      if (retryCount + 1 < log.maxAttempts) {
        const delay = Math.pow(2, retryCount) * 5000; // 5s, 10s, 20s
        log.nextRetryAt = new Date(Date.now() + delay);
        await log.save();
        setTimeout(() => attempt(retryCount + 1), delay);
      } else {
        log.status = "failed";
        log.error = err.message;
        await log.save();
        console.error(`[WhatsApp] ✗ All ${log.maxAttempts} attempts failed for ${to}`);
      }
    }
  };

  attempt(0);
}

// ─── Notification triggers ────────────────────────────────────────────────────

/**
 * Notify admin when a customer places a new order.
 */
async function notifyAdminNewOrder(order, user) {
  const adminPhone = process.env.WHATSAPP_ADMIN_PHONE;
  if (!adminPhone) {
    console.warn("[WhatsApp] WHATSAPP_ADMIN_PHONE not set — skipping admin notification");
    return;
  }

  const shortId = order._id.toString().slice(-6).toUpperCase();
  const customerName = user?.username || user?.name || "Customer";
  const customerPhone = order.shippingAddress?.phone || user?.phone || "N/A";
  const products = order.items
    .map((i) => `${i.product?.name || "Product"} ×${i.quantity}`)
    .join(", ");
  const total = (order.totalAmount || 0).toFixed(2);
  const paymentStatus = order.paymentStatus === "completed" ? "Paid ✓" : "Pending";
  const addr = order.shippingAddress
    ? `${order.shippingAddress.street}, ${order.shippingAddress.city}, ${order.shippingAddress.state} - ${order.shippingAddress.zipCode}`
    : "N/A";
  const time = new Date(order.createdAt || Date.now()).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    dateStyle: "medium",
    timeStyle: "short",
  });

  const template = TEMPLATES.order_placed_admin;
  const params = template.buildParams({ shortId, customerName, customerPhone, products, total, paymentStatus, address: addr, time });

  await sendWhatsApp({
    to: adminPhone,
    templateKey: "order_placed_admin",
    templateParams: params,
    orderId: order._id,
    userId: user?._id,
    eventType: "order_placed_admin",
  });
}

/**
 * Notify customer when admin updates their order status.
 */
async function notifyCustomerStatusChange(order, user, newStatus) {
  const templateKey = STATUS_TEMPLATE_MAP[newStatus];
  if (!templateKey) return; // No template for this status (e.g. "pending")

  const phone = order.shippingAddress?.phone || user?.phone;
  if (!phone) {
    console.warn(`[WhatsApp] No phone for user ${user?._id} — skipping customer notification`);
    return;
  }

  const shortId = order._id.toString().slice(-6).toUpperCase();
  const customerName = user?.username || user?.name || "Customer";
  const eta = order.estimatedDelivery
    ? new Date(order.estimatedDelivery).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium" })
    : "2–5 business days";

  const template = TEMPLATES[templateKey];
  const params = template.buildParams({ customerName, shortId, total: (order.totalAmount || 0).toFixed(2), eta });

  await sendWhatsApp({
    to: phone,
    templateKey,
    templateParams: params,
    orderId: order._id,
    userId: user?._id,
    eventType: templateKey,
  });
}

/**
 * Retry all failed/pending logs that are due.
 * Call this from a cron job or startup sweep.
 */
async function retryFailedNotifications() {
  const due = await WhatsAppLog.find({
    status: { $in: ["pending", "failed"] },
    attempts: { $lt: 3 },
    $or: [{ nextRetryAt: { $lte: new Date() } }, { nextRetryAt: null }],
  }).limit(50);

  for (const log of due) {
    const template = Object.values(TEMPLATES).find((t) => t.name === log.templateName);
    if (!template) continue;
    const templateKey = Object.keys(TEMPLATES).find((k) => TEMPLATES[k].name === log.templateName);
    if (!templateKey) continue;
    await sendWhatsApp({
      to: log.to,
      templateKey,
      templateParams: log.variables,
      orderId: log.orderId,
      userId: log.userId,
      eventType: log.eventType,
    });
  }

  return due.length;
}

module.exports = {
  notifyAdminNewOrder,
  notifyCustomerStatusChange,
  retryFailedNotifications,
  sendWhatsApp,
  normalizePhone,
  isConfigured,
  STATUS_TEMPLATE_MAP,
  TEMPLATES,
};
