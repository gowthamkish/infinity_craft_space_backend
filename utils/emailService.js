const nodemailer = require("nodemailer");

// Configure email transporter
const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST || "smtp.gmail.com",
  port: process.env.EMAIL_PORT || 587,
  secure: false,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASSWORD,
  },
});

// Email templates
const emailTemplates = {
  orderConfirmation: (order, user) => ({
    subject: `Order Confirmation - #${order._id}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px;">
        <h2>Order Confirmed!</h2>
        <p>Hi ${user.username},</p>
        <p>Thank you for your order. Here are the details:</p>
        
        <div style="background: #f5f5f5; padding: 15px; border-radius: 5px; margin: 20px 0;">
          <p><strong>Order ID:</strong> #${order._id}</p>
          <p><strong>Date:</strong> ${new Date(order.createdAt).toLocaleDateString()}</p>
          <p><strong>Total Amount:</strong> ₹${order.totalAmount}</p>
        </div>

        <h3>Items Ordered:</h3>
        <ul>
          ${order.items.map((item) => `<li>${item.product.name} x${item.quantity} - ₹${item.totalPrice}</li>`).join("")}
        </ul>

        <h3>Shipping Address:</h3>
        <p>
          ${order.shippingAddress.street}<br/>
          ${order.shippingAddress.city}, ${order.shippingAddress.state} ${order.shippingAddress.zipCode}<br/>
          ${order.shippingAddress.country}
        </p>

        <p style="margin-top: 30px; color: #666; font-size: 12px;">
          We'll send you tracking information once your order ships.
        </p>
      </div>
    `,
  }),

  shippingUpdate: (order, trackingNumber, estimatedDelivery) => ({
    subject: `Your Order is On Its Way - Order #${order._id}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px;">
        <h2>Your Package is Shipping!</h2>
        <p>Great news! Your order has been dispatched.</p>
        
        <div style="background: #f5f5f5; padding: 15px; border-radius: 5px; margin: 20px 0;">
          <p><strong>Order ID:</strong> #${order._id}</p>
          <p><strong>Tracking Number:</strong> ${trackingNumber}</p>
          <p><strong>Estimated Delivery:</strong> ${new Date(estimatedDelivery).toLocaleDateString()}</p>
        </div>

        <p>You can track your package using the tracking number above.</p>
        <p style="margin-top: 30px; color: #666; font-size: 12px;">
          Thank you for shopping with us!
        </p>
      </div>
    `,
  }),

  deliveryConfirmation: (order) => ({
    subject: `Delivery Confirmed - Order #${order._id}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px;">
        <h2>Order Delivered! 🎉</h2>
        <p>Your order has been successfully delivered.</p>
        
        <div style="background: #f5f5f5; padding: 15px; border-radius: 5px; margin: 20px 0;">
          <p><strong>Order ID:</strong> #${order._id}</p>
          <p><strong>Delivered Date:</strong> ${new Date().toLocaleDateString()}</p>
        </div>

        <p>We'd love to hear your feedback! Please review your purchase and let us know your experience.</p>
        <p style="margin-top: 30px; color: #666; font-size: 12px;">
          Thank you for your business!
        </p>
      </div>
    `,
  }),

  abandonedCartReminder: (cartItems, recoveryLink, user) => ({
    subject: "Don't miss out! Complete your purchase",
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px;">
        <h2>Remember Your Cart?</h2>
        <p>Hi ${user.username},</p>
        <p>You left ${cartItems.length} item(s) in your cart. Your order awaits!</p>
        
        <h3>Items in Your Cart:</h3>
        <ul>
          ${cartItems.map((item) => `<li>${item.productName} x${item.quantity}</li>`).join("")}
        </ul>

        <p style="margin: 20px 0;">
          <a href="${recoveryLink}" style="background: #e8623d; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; display: inline-block;">
            Complete Your Purchase
          </a>
        </p>

        <p style="color: #666; font-size: 12px;">
          This link will expire in 24 hours.
        </p>
      </div>
    `,
  }),

  reviewReminder: (order, productName) => ({
    subject: "Share Your Experience - Review Your Purchase",
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px;">
        <h2>How was your experience?</h2>
        <p>We'd love to hear what you think about <strong>${productName}</strong>!</p>
        <p>Your review helps other customers make informed decisions.</p>
        
        <p style="margin: 20px 0;">
          <a href="${process.env.FRONTEND_URL}/products/${order.items[0].product._id}?tab=reviews" style="background: #0f9488; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; display: inline-block;">
            Write a Review
          </a>
        </p>
      </div>
    `,
  }),

  returnApproved: (returnRequest, user) => ({
    subject: `Return Request Approved - Request #${returnRequest._id}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px;">
        <h2>Return Approved ✓</h2>
        <p>Hi ${user.username},</p>
        <p>Your return request has been approved.</p>
        
        <div style="background: #f5f5f5; padding: 15px; border-radius: 5px; margin: 20px 0;">
          <p><strong>Refund Amount:</strong> ₹${returnRequest.refundAmount}</p>
          <p><strong>Refund Method:</strong> ${returnRequest.refundMethod}</p>
          <p><strong>Return Address:</strong></p>
          <p>
            ${returnRequest.returnAddress.street}<br/>
            ${returnRequest.returnAddress.city}, ${returnRequest.returnAddress.state}
          </p>
        </div>

        <p>Please arrange for pickup or ship the item back to the address above. Once received and inspected, your refund will be processed.</p>
      </div>
    `,
  }),
};

// ── Delivery ─────────────────────────────────────────────────────────────────
// Brevo's HTTPS API is used when BREVO_API_KEY is set (works on hosts that block SMTP, e.g. Render free tier).
// Otherwise falls back to SMTP via nodemailer (EMAIL_USER / EMAIL_PASSWORD).
const SHOP_EMAIL = () => process.env.SHOP_EMAIL || "infinitycraftspacejsag@gmail.com";

function senderIdentity() {
  return {
    email: process.env.BREVO_SENDER_EMAIL || SHOP_EMAIL(),
    name: process.env.BREVO_SENDER_NAME || "Infinity Craft Space",
  };
}

async function sendViaBrevo({ to, subject, html, text, replyTo }) {
  const recipients = (Array.isArray(to) ? to : [to]).filter(Boolean).map((email) => ({ email }));
  const res = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { "api-key": process.env.BREVO_API_KEY, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      sender: senderIdentity(),
      to: recipients,
      subject,
      htmlContent: html,
      ...(text ? { textContent: text } : {}),
      ...(replyTo ? { replyTo: { email: replyTo } } : {}),
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Brevo ${res.status}: ${body.slice(0, 300)}`);
  }
}

// Why the most recent send failed (shown to the admin when an order email can't be delivered)
let lastEmailError = null;
exports.getLastEmailError = () => lastEmailError;

// Send email — returns true on success, false otherwise (never throws)
exports.sendEmail = async (email, template, variables = {}) => {
  lastEmailError = null;
  try {
    if (!email || (Array.isArray(email) && email.length === 0)) return false;

    if (process.env.BREVO_API_KEY) {
      await sendViaBrevo({ to: email, ...template });
      return true;
    }

    if (!process.env.EMAIL_USER) {
      lastEmailError = "Email is not configured on the server: BREVO_API_KEY is missing";
      console.warn(`[Email] ${lastEmailError}`);
      return false;
    }

    const { replyTo, ...rest } = template;
    await transporter.sendMail({
      from: process.env.EMAIL_FROM || process.env.EMAIL_USER,
      to: email,
      ...(replyTo ? { replyTo } : {}),
      ...rest,
    });
    return true;
  } catch (error) {
    lastEmailError = error.message || String(error);
    console.error("[Email] Send failed:", lastEmailError);
    return false;
  }
};

// ── Order emails (customer confirmation + shop notifications) ───────────────
const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const inr = (n) => `₹${Number(n || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const shortId = (order) => String(order._id).slice(-6).toUpperCase();
const istTime = (d) =>
  new Date(d || Date.now()).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" });

function itemsTable(order) {
  const rows = (order.items || []).map((i) => `
    <tr>
      <td style="padding:8px;border-bottom:1px solid #eee;">
        <strong>${esc(i.product?.name || "Product")}</strong>
        ${i.selectedStringSize ? `<br/><small style="color:#666;">Size: ${esc(i.selectedStringSize)} inch</small>` : ""}
        ${i.customNote ? `<br/><small style="color:#b45309;"><b>Customisation:</b> ${esc(i.customNote)}</small>` : ""}
      </td>
      <td style="padding:8px;border-bottom:1px solid #eee;text-align:center;">${esc(i.quantity)}</td>
      <td style="padding:8px;border-bottom:1px solid #eee;text-align:right;">${inr(i.product?.price)}</td>
      <td style="padding:8px;border-bottom:1px solid #eee;text-align:right;">${inr(i.totalPrice)}</td>
    </tr>`).join("");
  const d = order.discount?.amount > 0
    ? `<tr><td colspan="3" style="padding:4px 8px;text-align:right;">Coupon${order.discount.code ? ` (${esc(order.discount.code)})` : ""}</td><td style="padding:4px 8px;text-align:right;color:#15803d;">−${inr(order.discount.amount)}</td></tr>`
    : "";
  return `
  <table style="width:100%;border-collapse:collapse;font-size:14px;">
    <thead><tr style="background:#f5f5f5;">
      <th style="padding:8px;text-align:left;">Item</th><th style="padding:8px;">Qty</th>
      <th style="padding:8px;text-align:right;">Price</th><th style="padding:8px;text-align:right;">Total</th>
    </tr></thead>
    <tbody>${rows}</tbody>
    <tfoot>
      <tr><td colspan="3" style="padding:8px 8px 4px;text-align:right;">Subtotal</td><td style="padding:8px 8px 4px;text-align:right;">${inr(order.subtotal)}</td></tr>
      ${d}
      <tr><td colspan="3" style="padding:4px 8px;text-align:right;">Shipping</td><td style="padding:4px 8px;text-align:right;">${order.shipping ? inr(order.shipping) : "FREE"}</td></tr>
      <tr><td colspan="3" style="padding:8px;text-align:right;font-weight:bold;font-size:16px;">Total paid</td><td style="padding:8px;text-align:right;font-weight:bold;font-size:16px;">${inr(order.totalAmount)}</td></tr>
    </tfoot>
  </table>`;
}

function addressBlock(order) {
  const a = order.shippingAddress || {};
  return `${esc(a.street)}<br/>${esc(a.city)}, ${esc(a.state)} – ${esc(a.zipCode)}<br/>${esc(a.country || "India")}${a.phone ? `<br/>📞 ${esc(a.phone)}` : ""}`;
}

const orderShell = (title, inner) => `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:640px;margin:0 auto;color:#222;">
    <div style="background:#1f1a17;color:#f7dc8a;padding:16px 20px;border-radius:8px 8px 0 0;">
      <strong style="font-size:18px;">Infinity Craft Space</strong><br/><span style="color:#fff;">${title}</span>
    </div>
    <div style="border:1px solid #eee;border-top:0;padding:20px;border-radius:0 0 8px 8px;">${inner}</div>
  </div>`;

const orderEmails = {
  customerConfirmation: (order, user) => {
    const frontendUrl = process.env.FRONTEND_URL || "https://www.infinitycraftspace.com";
    return {
      subject: `Order confirmed – #${shortId(order)} | Infinity Craft Space`,
      replyTo: SHOP_EMAIL(),
      html: orderShell("Thank you for your order!", `
        <p>Hi ${esc(user.username || user.name || "there")},</p>
        <p>We've received your payment and your order is confirmed. Here are the details:</p>
        <p><strong>Order:</strong> #${shortId(order)}<br/><strong>Placed on:</strong> ${istTime(order.createdAt)}</p>
        ${itemsTable(order)}
        <h3 style="margin-top:24px;">Shipping to</h3>
        <p>${addressBlock(order)}</p>
        <p style="margin:24px 0;">
          <a href="${frontendUrl}/orders" style="background:#e8623d;color:#fff;padding:10px 20px;text-decoration:none;border-radius:5px;">View my order</a>
        </p>
        <p style="color:#666;font-size:12px;">We'll let you know when it ships. Questions? Just reply to this email.</p>`),
    };
  },

  adminNewOrder: (order, user) => {
    const p = order.razorpayPaymentId ? `Razorpay · ${esc(order.razorpayPaymentId)}` : esc(order.paymentMethod || "prepaid");
    const hasCustom = (order.items || []).some((i) => i.customNote);
    return {
      subject: `🛍️ New order #${shortId(order)} – ${inr(order.totalAmount)} – ${user?.username || user?.name || "Customer"}`,
      ...(user?.email ? { replyTo: user.email } : {}),
      html: orderShell(`New order received${hasCustom ? " · contains customisation" : ""}`, `
        <table style="width:100%;font-size:14px;margin-bottom:16px;">
          <tr><td style="color:#666;width:140px;">Order ID</td><td><strong>#${shortId(order)}</strong> <small style="color:#999;">(${esc(order._id)})</small></td></tr>
          <tr><td style="color:#666;">Placed on</td><td>${istTime(order.createdAt)} IST</td></tr>
          <tr><td style="color:#666;">Payment</td><td>${p} – <strong style="color:#15803d;">Paid</strong></td></tr>
        </table>
        <h3>Customer</h3>
        <table style="width:100%;font-size:14px;margin-bottom:16px;">
          <tr><td style="color:#666;width:140px;">Name</td><td>${esc(user?.username || user?.name || "—")}</td></tr>
          <tr><td style="color:#666;">Email</td><td>${user?.email ? `<a href="mailto:${esc(user.email)}">${esc(user.email)}</a>` : "—"}</td></tr>
          <tr><td style="color:#666;">Phone</td><td>${esc(order.shippingAddress?.phone || user?.phone || "—")}</td></tr>
        </table>
        <h3>Ship to</h3>
        <p>${addressBlock(order)}</p>
        <h3>Items</h3>
        ${itemsTable(order)}
        <p style="color:#666;font-size:12px;margin-top:20px;">Reply to this email to contact the customer directly.</p>`),
    };
  },

  adminCancelled: (order, user) => {
    const rs = order.cancellation?.refundStatus;
    const refund = order.paymentStatus === "refunded"
      ? `<strong style="color:#15803d;">Refund initiated</strong> (${esc(order.cancellation?.refundId || "")})`
      : rs === "failed"
        ? `<strong style="color:#b91c1c;">Refund FAILED – please refund ${inr(order.totalAmount)} manually in the Razorpay dashboard</strong>`
        : esc(rs || "—");
    return {
      subject: `❌ Order #${shortId(order)} cancelled by customer – ${inr(order.totalAmount)}`,
      ...(user?.email ? { replyTo: user.email } : {}),
      html: orderShell("Order cancelled by customer", `
        <p><strong>Order:</strong> #${shortId(order)}<br/>
           <strong>Customer:</strong> ${esc(user?.username || user?.name || "—")} (${esc(user?.email || "—")}, ${esc(order.shippingAddress?.phone || "—")})<br/>
           <strong>Cancelled at:</strong> ${istTime(order.cancellation?.at)} IST<br/>
           <strong>Reason:</strong> ${esc(order.cancellation?.reason || "Not given")}<br/>
           <strong>Refund:</strong> ${refund}</p>
        ${itemsTable(order)}
        <p style="color:#666;font-size:12px;">Stock for these items has been restored.</p>`),
    };
  },
};

// Order-related emails
exports.sendOrderConfirmation = async (order, user) => {
  if (!user?.email) return false;
  return exports.sendEmail(user.email, orderEmails.customerConfirmation(order, user));
};

/** New paid order → shop inbox (SHOP_EMAIL), with full order + customer details. */
exports.sendAdminNewOrderEmail = async (order, user) =>
  exports.sendEmail(SHOP_EMAIL(), orderEmails.adminNewOrder(order, user));

/** Customer cancelled an order → shop inbox, with refund status. */
exports.sendAdminOrderCancelledEmail = async (order, user) =>
  exports.sendEmail(SHOP_EMAIL(), orderEmails.adminCancelled(order, user));

exports.sendShippingUpdate = async (
  order,
  user,
  trackingNumber,
  estimatedDelivery,
) => {
  const template = emailTemplates.shippingUpdate(
    order,
    trackingNumber,
    estimatedDelivery,
  );
  return exports.sendEmail(user.email, template);
};

exports.sendDeliveryConfirmation = async (order, user) => {
  const template = emailTemplates.deliveryConfirmation(order);
  return exports.sendEmail(user.email, template);
};

// Marketing emails
exports.sendAbandonedCartReminder = async (user, cartItems, recoveryLink) => {
  const template = emailTemplates.abandonedCartReminder(
    cartItems,
    recoveryLink,
    user,
  );
  return exports.sendEmail(user.email, template);
};

exports.sendReviewReminder = async (user, order, productName) => {
  const template = emailTemplates.reviewReminder(order, productName);
  return exports.sendEmail(user.email, template);
};

exports.sendReturnApproved = async (user, returnRequest) => {
  const template = emailTemplates.returnApproved(returnRequest, user);
  return exports.sendEmail(user.email, template);
};

exports.sendStockAlertEmail = async (email, product) => {
  const frontendUrl = process.env.FRONTEND_URL || "https://www.infinitycraftspace.com";
  const template = {
    subject: `Back in Stock: ${product.name}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px;">
        <h2>Good news! It's back in stock 🎉</h2>
        <p>A product you were watching is available again:</p>
        <div style="background: #f5f5f5; padding: 15px; border-radius: 5px; margin: 20px 0;">
          <p><strong>${product.name}</strong></p>
          ${product.price ? `<p>Price: ₹${product.price}</p>` : ""}
        </div>
        <p style="margin: 20px 0;">
          <a href="${frontendUrl}/product/${product._id}" style="background: #e8623d; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; display: inline-block;">
            Shop Now
          </a>
        </p>
        <p style="color: #666; font-size: 12px;">
          Stock is limited — grab yours before it sells out again!
        </p>
      </div>
    `,
  };
  return exports.sendEmail(email, template);
};

exports.sendNewsletterWelcome = async (email, unsubscribeUrl) => {
  const frontendUrl = process.env.FRONTEND_URL || "https://www.infinitycraftspace.com";
  const template = {
    subject: "Welcome to InfinityCraftSpace ✨",
    html: `
      <div style="background:#f7f4ee;padding:32px 16px;font-family:Inter,Arial,sans-serif;color:#232420;">
        <div style="max-width:560px;margin:0 auto;background:#fffdf9;border:1px solid #e4dfd6;border-radius:20px;padding:36px 32px;">
          <h2 style="margin:0 0 12px;font-size:24px;">Welcome to the community 🎉</h2>
          <p style="color:#5b5d58;line-height:1.6;margin:0 0 20px;">
            Thanks for subscribing! You'll be the first to hear about new handcrafted collections,
            festive launches and subscriber-only offers.
          </p>
          <p style="margin:0 0 28px;">
            <a href="${frontendUrl}/products" style="background:#d24e33;color:#fff;padding:12px 24px;text-decoration:none;border-radius:12px;display:inline-block;font-weight:600;">
              Explore the collection
            </a>
          </p>
          <p style="color:#8a8c85;font-size:12px;margin:0;">
            Changed your mind? <a href="${unsubscribeUrl}" style="color:#8a8c85;">Unsubscribe in one click</a>.
          </p>
        </div>
      </div>
    `,
  };
  return exports.sendEmail(email, template);
};

// ── Launch emails (dark red / black / gold, matching the launch banner) ─────────
const LAUNCH_DATE_TEXT = "20 November 2026";
const launchShell = (inner, unsubscribeUrl) => `
  <div style="background:#0b0505;padding:32px 16px;font-family:Inter,Arial,sans-serif;">
    <div style="max-width:560px;margin:0 auto;background:linear-gradient(160deg,#1a0707,#3a0a0a);border:1px solid #c8932c;border-radius:20px;padding:36px 32px;text-align:center;color:#fff;">
      ${inner}
      <p style="color:#b9a98f;font-size:12px;margin:28px 0 0;">
        Changed your mind? <a href="${unsubscribeUrl}" style="color:#e2b04a;">Unsubscribe in one click</a>.
      </p>
    </div>
  </div>`;

// Sent right after someone taps "Notify me" on the pre-launch banner
exports.sendLaunchWaitlistConfirmation = async (email, unsubscribeUrl) => {
  const template = {
    subject: "You're on the list — InfinityCraftSpace launches 20 November 2026 ✨",
    html: launchShell(`
      <p style="margin:0 0 8px;color:#e2b04a;font-size:12px;letter-spacing:.14em;text-transform:uppercase;font-weight:700;">You're invited</p>
      <h2 style="margin:0 0 12px;font-size:26px;color:#f7dc8a;">Grand Website Launch</h2>
      <p style="color:#e9dcc5;line-height:1.6;margin:0 0 18px;">
        Thank you for signing up! We'll email you the moment InfinityCraftSpace goes live on
        <strong style="color:#f7dc8a;">${LAUNCH_DATE_TEXT}, 8:00 AM IST</strong> — handcrafted gifts made with love and delivered across India.
      </p>
      <p style="color:#b9a98f;margin:0;">Keep an eye on your inbox. 💛</p>`, unsubscribeUrl),
  };
  return exports.sendEmail(email, template);
};

// Launch-day announcement (sent by scripts/sendLaunchEmail.js)
exports.sendLaunchAnnouncement = async (email, unsubscribeUrl) => {
  const frontendUrl = process.env.FRONTEND_URL || "https://www.infinitycraftspace.com";
  const template = {
    subject: "We're live! InfinityCraftSpace is open 🎉",
    html: launchShell(`
      <p style="margin:0 0 8px;color:#e2b04a;font-size:12px;letter-spacing:.14em;text-transform:uppercase;font-weight:700;">It's here</p>
      <h2 style="margin:0 0 12px;font-size:26px;color:#f7dc8a;">InfinityCraftSpace is live!</h2>
      <p style="color:#e9dcc5;line-height:1.6;margin:0 0 24px;">
        You asked us to tell you — the doors are open. Explore handcrafted gifts, custom pieces and more.
      </p>
      <p style="margin:0;">
        <a href="${frontendUrl}/products" style="background:linear-gradient(180deg,#ffe9a3,#e2b04a);color:#1b1203;padding:14px 30px;text-decoration:none;border-radius:999px;display:inline-block;font-weight:800;">
          Start shopping
        </a>
      </p>`, unsubscribeUrl),
  };
  return exports.sendEmail(email, template);
};

// Batch send emails (admin notifications)
exports.sendAdminNotification = async (subject, html) => {
  try {
    return exports.sendEmail(SHOP_EMAIL(), { subject, html });
  } catch (error) {
    console.error("Error sending admin notification:", error);
    return false;
  }
};
