// Builds question/answer pairs for a product from its own data (AEO: answer engines and
// FAQ rich results want direct answers). Only states facts that exist on the product.
// A copy lives in the frontend (src/utils/productFaq.js) — keep the two in sync.
const inr = (n) => `₹${Number(n).toLocaleString("en-IN")}`;

function buildProductFaq(p) {
  const faq = [];
  const name = p.name;
  const sizes = p.showStringSizePicker && p.stringSizes?.length ? [...p.stringSizes].sort((a, b) => a.inches - b.inches) : [];

  if (sizes.length) {
    faq.push({
      q: `How much does ${name} cost?`,
      a: `${name} is priced by length: ${sizes.map((s) => `${s.inches} inch ${inr(s.price)}`).join(", ")}.`,
    });
    faq.push({
      q: `What lengths does ${name} come in?`,
      a: `${name} is available in ${sizes.map((s) => `${s.inches}"`).join(", ")}.`,
    });
  } else if (p.price != null) {
    faq.push({ q: `How much does ${name} cost?`, a: `${name} costs ${inr(p.price)} at Infinity Craft Space. Shipping is calculated at checkout.` });
  }

  const inStock = p.trackInventory === false || p.stock > 0;
  faq.push({
    q: `Is ${name} in stock?`,
    a: inStock ? `Yes, ${name} is currently available.` : `${name} is currently out of stock. You can ask to be notified when it returns.`,
  });

  if (p.isCustomizable) {
    faq.push({
      q: `Can ${name} be customised?`,
      a: `Yes. ${name} is made to order and can be personalised. Please allow ${p.processingDaysMin}–${p.processingDaysMax} business days before it is dispatched.`,
    });
  }

  const colors = (p.colors || []).filter((c) => c.visibleToUsers !== false).map((c) => c.name);
  if (p.showColorPickerToUsers && colors.length) {
    faq.push({ q: `What colours does ${name} come in?`, a: `${name} is available in ${colors.join(", ")}.` });
  }
  if (p.showHoopSizePicker && p.hoopSizes?.length) {
    faq.push({ q: `What sizes does ${name} come in?`, a: `Available sizes: ${[...p.hoopSizes].sort((a, b) => a - b).map((s) => `${s}"`).join(", ")}.` });
  }

  if (p.estimatedDelivery && !p.isCustomizable) {
    faq.push({
      q: `How long does delivery take for ${name}?`,
      a: `Estimated delivery is about ${p.estimatedDelivery} days. Enter your pincode on the product page for a more accurate date.`,
    });
  }

  const desc = String(p.description || "").replace(/\s+/g, " ").trim();
  if (desc) {
    faq.push({ q: `What is ${name}?`, a: desc.length > 300 ? `${desc.slice(0, 297)}…` : desc });
  }
  return faq;
}

const faqJsonLd = (faq) =>
  faq.length
    ? {
        "@type": "FAQPage",
        mainEntity: faq.map(({ q, a }) => ({ "@type": "Question", name: q, acceptedAnswer: { "@type": "Answer", text: a } })),
      }
    : null;

module.exports = { buildProductFaq, faqJsonLd };
