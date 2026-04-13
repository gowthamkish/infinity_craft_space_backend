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
          <a href="${recoveryLink}" style="background: #2563eb; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; display: inline-block;">
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
          <a href="${process.env.FRONTEND_URL}/products/${order.items[0].product._id}?tab=reviews" style="background: #10b981; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; display: inline-block;">
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

// Send email
exports.sendEmail = async (email, template, variables = {}) => {
  try {
    if (!process.env.EMAIL_USER) {
      console.warn("Email service not configured");
      return false;
    }

    const mailOptions = {
      from: process.env.EMAIL_FROM || process.env.EMAIL_USER,
      to: email,
      ...template,
    };

    await transporter.sendMail(mailOptions);
    return true;
  } catch (error) {
    console.error("Error sending email:", error);
    return false;
  }
};

// Order-related emails
exports.sendOrderConfirmation = async (order, user) => {
  const template = emailTemplates.orderConfirmation(order, user);
  return exports.sendEmail(user.email, template);
};

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

// Batch send emails (admin notifications)
exports.sendAdminNotification = async (subject, html) => {
  try {
    return exports.sendEmail(process.env.ADMIN_EMAIL, { subject, html });
  } catch (error) {
    console.error("Error sending admin notification:", error);
    return false;
  }
};
