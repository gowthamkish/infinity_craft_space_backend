/**
 * Seed policy / FAQ text into the KnowledgeChunk collection.
 *
 * Usage:
 *   node scripts/seedKnowledge.js
 *
 * After running, create the Atlas Vector Search index (UI → Search → JSON):
 *
 *   Collection: knowledgechunks
 *   Index name: knowledge_embedding_index
 *   {
 *     "fields": [{
 *       "numDimensions": 1024,
 *       "path": "embedding",
 *       "similarity": "cosine",
 *       "type": "vector"
 *     }]
 *   }
 *
 * Re-run this script whenever policy text changes — it replaces all chunks.
 */

require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });
const mongoose = require("mongoose");
const KnowledgeChunk = require("../models/KnowledgeChunk");
const { embedBatch } = require("../utils/embeddings");

// ── Policy text ──────────────────────────────────────────────────────────────
// Keep each chunk ≤ ~400 words so it fits cleanly in a tool result.
// Use plain text — HTML is stripped by the embedding helper anyway.
const CHUNKS = [
  {
    topic: "return_policy",
    title: "Return & Refund Policy",
    content: `Infinity Craft Space accepts returns within 7 days of delivery for most products.
To be eligible: items must be unused, in original packaging, with all tags intact.
Non-returnable items: customized/personalized products, earrings (hygiene), items on sale.
Defective or wrong items: we cover return shipping and offer a full refund or free replacement.
How to initiate: go to My Orders → select the item → click Return/Refund. Our team responds within 24 hours.
Refunds are processed within 5-7 business days after we receive the returned item.
Refund method: same as original payment (UPI/card) or store credit (your choice).
COD orders: refunds are issued as store credit or NEFT transfer (provide bank details).`,
  },
  {
    topic: "shipping",
    title: "Shipping & Delivery",
    content: `Infinity Craft Space ships across India via reputed couriers (Delhivery, BlueDart, Shiprocket network).
Standard delivery: 4-7 business days depending on your location.
Metro cities (Mumbai, Delhi, Bangalore, Chennai, Hyderabad, Kolkata): typically 3-5 days.
North-east and remote areas: up to 10 business days.
Free shipping on orders above ₹999. Below ₹999, flat ₹59 shipping fee.
Tracking: once shipped you receive a tracking link via SMS and email. You can also track in My Orders.
COD (Cash on Delivery): available on orders up to ₹3000.
We ship Monday to Saturday, excluding public holidays.`,
  },
  {
    topic: "customization",
    title: "Customized & Personalized Products",
    content: `Many products on Infinity Craft Space can be personalized — look for the "Customizable" badge on the product page.
What can be customized: name engraving, color choice, size, material, embroidery text, monogram, photo print (product-specific).
How to order: select your options on the product page and add to cart. A text box or upload field appears for your requirements.
Processing time: customized products take 10-12 business days before dispatch (on top of delivery time).
Returns: customized items cannot be returned unless they arrive defective or incorrect.
Bulk / wedding orders: contact us via WhatsApp or email for special pricing and dedicated support.
Changes after order: we cannot modify customization details once production has started (usually within 24 hours of placing the order).`,
  },
  {
    topic: "payment",
    title: "Payment Options & Security",
    content: `Infinity Craft Space accepts: UPI (PhonePe, GPay, Paytm), Credit/Debit cards (Visa, Mastercard, RuPay), Net Banking, EMI (on orders above ₹3000), and Cash on Delivery (up to ₹3000).
Payments are processed securely via Razorpay — your card details are never stored on our servers.
EMI options available: 3, 6, 9, 12 months (bank-specific interest rates apply).
Failed payment: if your payment fails but money was deducted, it is automatically reversed within 5-7 business days by your bank.
Coupon codes: apply at checkout. One coupon per order. Coupons cannot be combined.`,
  },
  {
    topic: "general",
    title: "About Infinity Craft Space",
    content: `Infinity Craft Space is an Indian handcraft and ethnic jewellery brand specializing in kundan, meenakari, oxidized silver, resin art, embroidery, and artisanal craft products.
All products are handmade or handcrafted in India, supporting local artisans.
We believe every piece tells a story — our products are designed for festivals, weddings, gifting, and everyday ethnic wear.
Loyalty program: earn points on every purchase, redeemable on future orders (1 point = ₹1). Tiers: Bronze, Silver, Gold based on annual spend.
Referral program: share your referral code with friends — both you and your friend get store credit when they make their first purchase.
For bulk/corporate gifting, contact us at hello@infinitycraftspace.com.`,
  },
  {
    topic: "contact",
    title: "Contact & Support",
    content: `Customer support: available Monday to Saturday, 9 AM to 7 PM IST.
Email: hello@infinitycraftspace.com (response within 24 hours)
WhatsApp: click the WhatsApp button on the website for quick support.
For order issues, always quote your Order ID.
Social media: Instagram @infinitycraftspace — DMs are monitored but may take longer than email/WhatsApp.
For returns/exchanges, use the My Orders section in your account for fastest processing.`,
  },
  {
    topic: "general",
    title: "Product Care & Material Info",
    content: `Kundan jewellery: avoid contact with water, perfume, and chemicals. Store in a soft pouch. Clean with a dry soft cloth.
Oxidized silver: natural blackening will deepen over time — this is a feature, not a defect. Polish gently with a soft cloth if desired.
Resin products: keep away from direct sunlight for extended periods. Wipe with a damp cloth.
Embroidery/fabric: dry clean recommended. Do not machine wash.
Most metal jewellery is nickel-free and lead-free. If you have metal allergies, check the material section on each product page.`,
  },
];

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log("Connected to MongoDB");

  console.log("Embedding chunks...");
  const texts = CHUNKS.map((c) => `${c.title}. ${c.content}`);
  const embeddings = await embedBatch(texts);

  const docs = CHUNKS.map((c, i) => ({
    ...c,
    embedding: embeddings[i],
    updatedAt: new Date(),
  }));

  await KnowledgeChunk.deleteMany({});
  await KnowledgeChunk.insertMany(docs);
  console.log(`Seeded ${docs.length} knowledge chunks.`);

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
