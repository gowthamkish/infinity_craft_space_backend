/**
 * Renders a campaign's email draft as safe, email-client-friendly HTML (inline styles, table layout, everything
 * escaped). Used for the preview and the "send me a test" button. This module never sends to customers.
 */
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const site = () => (process.env.SITE_URL || "https://infinitycraftspace.com").replace(/\/+$/, "").replace(/^(https?:\/\/)www\./i, "$1");
const inr = (n) => `₹${Number(n || 0).toLocaleString("en-IN")}`;

/**
 * @param {object} campaign  the saved campaign content
 * @param {{ test?: boolean, unsubscribeUrl?: string }} opts
 */
function renderCampaignEmail(campaign, { test = false, unsubscribeUrl = null } = {}) {
  const e = campaign.email;
  const byId = new Map((campaign.products || []).map((p) => [p.id, p]));
  const products = (e.productIds || []).map((id) => byId.get(id)).filter(Boolean);
  const link = (path) => `${site()}${path}`;
  const cta = link(e.ctaUrl || "/products");

  const cards = products.map((p) => `
    <td width="${Math.floor(100 / Math.min(products.length, 2))}%" valign="top" style="padding:8px;">
      <a href="${esc(link(`/product/${p.slug || p.id}`))}" style="text-decoration:none;color:#232420;">
        ${p.image ? `<img src="${esc(p.image)}" alt="${esc(p.name)}" width="250" style="width:100%;max-width:250px;border-radius:10px;display:block;" />` : ""}
        <div style="font-weight:700;font-size:14px;margin-top:8px;">${esc(p.name)}</div>
        <div style="font-size:13px;color:#5b5d58;">${esc(inr(p.price))}</div>
      </a>
    </td>`);
  const rows = [];
  for (let i = 0; i < cards.length; i += 2) rows.push(`<tr>${cards.slice(i, i + 2).join("")}</tr>`);

  return `<!doctype html><html><body style="margin:0;background:#f7f4ee;">
  <span style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(e.preheader)}</span>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f7f4ee;"><tr><td align="center" style="padding:24px 12px;">
    <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:14px;font-family:Arial,Helvetica,sans-serif;color:#232420;">
      <tr><td style="background:#1f1a17;color:#f7dc8a;padding:18px 24px;border-radius:14px 14px 0 0;font-size:18px;font-weight:700;">Infinity Craft Space</td></tr>
      <tr><td style="padding:24px;font-size:15px;line-height:1.65;">
        ${(e.paragraphs || []).map((p) => `<p style="margin:0 0 14px;">${esc(p)}</p>`).join("")}
        ${rows.length ? `<table width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0 12px;">${rows.join("")}</table>` : ""}
        <p style="text-align:center;margin:22px 0 6px;"><a href="${esc(cta)}" style="background:#e8623d;color:#ffffff;padding:13px 28px;border-radius:8px;text-decoration:none;font-weight:700;display:inline-block;">${esc(e.ctaLabel)}</a></p>
      </td></tr>
      <tr><td style="padding:16px 24px 22px;font-size:12px;color:#8a8c85;border-top:1px solid #eee;">
        ${test ? "<strong>This is a TEST email.</strong> In a real send, an unsubscribe link appears here for every recipient." : unsubscribeUrl ? `You're receiving this because you subscribed to Infinity Craft Space updates. <a href="${esc(unsubscribeUrl)}" style="color:#8a8c85;">Unsubscribe</a>` : ""}
        <br/>Infinity Craft Space · Bangalore, India
      </td></tr>
    </table>
  </td></tr></table></body></html>`;
}

module.exports = { renderCampaignEmail };
