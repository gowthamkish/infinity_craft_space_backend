const mongoose = require("mongoose");

const NewsletterSubscriberSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true, maxlength: 254 },
    status: { type: String, enum: ["subscribed", "unsubscribed"], default: "subscribed", index: true },
    source: { type: String, enum: ["home", "footer", "other"], default: "other" },
    // Random, unguessable token used by the one-click unsubscribe link in every email
    unsubscribeToken: { type: String, required: true, unique: true },
    subscribedAt: { type: Date, default: Date.now },
    unsubscribedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

module.exports = mongoose.model("NewsletterSubscriber", NewsletterSubscriberSchema);
