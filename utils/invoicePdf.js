/**
 * "Bill of Supply" PDF for orders. The shop is NOT GST-registered, so by law the document:
 *  - is titled "Bill of Supply" (never "Tax Invoice"),
 *  - shows no CGST/SGST/IGST or "0% GST" line,
 *  - carries no HSN/SAC codes.
 * Optional env: SHOP_PAN (defaults to the shop PAN), SHOP_PHONE, SHOP_EMAIL (defaults to the shop email).
 */
const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");

const LOGO_PATH = path.join(__dirname, "..", "assets", "ics-logo.jpg");
const LOGO = fs.existsSync(LOGO_PATH) ? fs.readFileSync(LOGO_PATH) : null; // read once, reused for every invoice

const SHOP = {
  name: "Infinitycraftspace",
  address: [
    "17 Beladingalu, Manipal County Road,",
    "Aishwarya Crystal Layout, MJ Infrastructure Road,",
    "Bangalore, Karnataka - 560068",
  ],
  pan: process.env.SHOP_PAN || "CMXPG8307F",
  email: process.env.SHOP_EMAIL || "infinitycraftspacejsag@gmail.com",
};

const EMBER = "#e8623d";
const INK = "#232420";
const MUTED = "#6b6d66";
const LINE = "#e4e0d6";

// PDFKit's built-in Helvetica has no ₹ glyph — print "Rs." so the amount never renders as junk.
const money = (n) => `Rs. ${Number(n || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtDate = (d) => new Date(d).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });

function invoiceNumber(order) {
  const d = new Date(order.createdAt);
  const ym = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}`;
  return `ICS-${ym}-${String(order._id).slice(-6).toUpperCase()}`;
}

function buildInvoicePdf(order, customer = {}) {
  const doc = new PDFDocument({ size: "A4", margin: 48, info: { Title: `Bill of Supply ${invoiceNumber(order)}`, Author: SHOP.name } });
  const W = doc.page.width - 96;
  const L = 48;
  const R = L + W;

  // ── Header ──
  const LOGO_SIZE = 66;
  const tx = LOGO ? L + LOGO_SIZE + 14 : L; // text column starts after the logo
  if (LOGO) doc.image(LOGO, L, 48, { width: LOGO_SIZE, height: LOGO_SIZE });
  doc.fillColor(EMBER).font("Helvetica-Bold").fontSize(20).text(SHOP.name, tx, 48);
  doc.fillColor(MUTED).font("Helvetica").fontSize(9);
  SHOP.address.forEach((line) => doc.text(line, tx, doc.y));
  if (process.env.SHOP_PHONE) doc.text(`Phone: ${process.env.SHOP_PHONE}`, tx, doc.y);
  doc.text(`Email: ${SHOP.email}`, tx, doc.y);
  if (SHOP.pan) doc.text(`PAN: ${SHOP.pan}`, tx, doc.y);
  const leftBottom = Math.max(doc.y, 48 + (LOGO ? LOGO_SIZE : 0));

  doc.fillColor(INK).font("Helvetica-Bold").fontSize(18).text("BILL OF SUPPLY", L, 48, { width: W, align: "right" });
  doc.font("Helvetica").fontSize(9).fillColor(MUTED);
  doc.text(`Invoice no: ${invoiceNumber(order)}`, L, 74, { width: W, align: "right" });
  doc.text(`Date: ${fmtDate(order.createdAt)}`, { width: W, align: "right" });
  doc.text(`Order ID: ${order._id}`, { width: W, align: "right" });
  if (order.razorpayPaymentId) doc.text(`Payment ref: ${order.razorpayPaymentId}`, { width: W, align: "right" });
  doc.text(`Payment: ${order.paymentMethod === "cod" ? "Cash on delivery" : "Paid online"}`, { width: W, align: "right" });

  let y = Math.max(leftBottom, doc.y) + 18;
  doc.moveTo(L, y).lineTo(R, y).strokeColor(LINE).stroke();
  y += 14;

  // ── Bill to / Ship to ──
  const a = order.shippingAddress || {};
  doc.fillColor(EMBER).font("Helvetica-Bold").fontSize(8).text("BILLED / SHIPPED TO", L, y);
  doc.fillColor(INK).font("Helvetica-Bold").fontSize(10).text(customer.username || "Customer", L, doc.y + 3);
  doc.font("Helvetica").fontSize(9).fillColor(MUTED);
  [a.street, [a.city, a.state].filter(Boolean).join(", ") + (a.zipCode ? ` - ${a.zipCode}` : ""), a.country, a.phone && `Phone: ${a.phone}`, customer.email && `Email: ${customer.email}`]
    .filter(Boolean).forEach((line) => doc.text(line, L, doc.y));
  y = doc.y + 18;

  // ── Items table ──
  const cols = { n: L, item: L + 28, qty: L + 300, rate: L + 356, amt: L + 436 };
  const header = () => {
    doc.rect(L, y, W, 22).fill("#f7f4ee");
    doc.fillColor(INK).font("Helvetica-Bold").fontSize(8.5);
    doc.text("#", cols.n + 6, y + 7, { width: 20 });
    doc.text("ITEM", cols.item, y + 7);
    doc.text("QTY", cols.qty, y + 7, { width: 40, align: "right" });
    doc.text("RATE", cols.rate, y + 7, { width: 70, align: "right" });
    doc.text("AMOUNT", cols.amt, y + 7, { width: R - cols.amt - 6, align: "right" });
    y += 26;
  };
  header();

  (order.items || []).forEach((it, i) => {
    const variant = [it.variant?.color, it.variant?.size, it.variant?.material].filter(Boolean).join(" · ");
    const name = it.product?.name || "Item";
    const h = doc.font("Helvetica-Bold").fontSize(9.5).heightOfString(name, { width: 255 }) + (variant ? 12 : 0) + 12;
    if (y + h > doc.page.height - 150) { doc.addPage(); y = 48; header(); }
    doc.fillColor(MUTED).font("Helvetica").fontSize(9).text(String(i + 1), cols.n + 6, y, { width: 20 });
    doc.fillColor(INK).font("Helvetica-Bold").fontSize(9.5).text(name, cols.item, y, { width: 255 });
    if (variant) doc.fillColor(MUTED).font("Helvetica").fontSize(8).text(variant, cols.item, doc.y + 1, { width: 255 });
    doc.fillColor(INK).font("Helvetica").fontSize(9.5);
    doc.text(String(it.quantity), cols.qty, y, { width: 40, align: "right" });
    doc.text(money(it.product?.price), cols.rate, y, { width: 70, align: "right" });
    doc.text(money(it.totalPrice), cols.amt, y, { width: R - cols.amt - 6, align: "right" });
    y += h;
    doc.moveTo(L, y - 6).lineTo(R, y - 6).strokeColor(LINE).stroke();
  });

  // ── Totals (no tax lines — not GST registered) ──
  if (y > doc.page.height - 190) { doc.addPage(); y = 48; }
  y += 6;
  const row = (label, value, opts = {}) => {
    doc.fillColor(opts.bold ? INK : MUTED).font(opts.bold ? "Helvetica-Bold" : "Helvetica").fontSize(opts.bold ? 11 : 9.5);
    doc.text(label, L + 300, y, { width: 120 });
    doc.text(value, cols.amt - 20, y, { width: R - cols.amt + 14, align: "right" });
    y += opts.bold ? 22 : 17;
  };
  row("Subtotal", money(order.subtotal));
  if (order.discount?.amount > 0) row(`Discount${order.discount.code ? ` (${order.discount.code})` : ""}`, `- ${money(order.discount.amount)}`);
  row("Shipping", order.shipping > 0 ? money(order.shipping) : "Free");
  doc.moveTo(L + 300, y).lineTo(R, y).strokeColor(INK).stroke();
  y += 8;
  row("Total", money(order.totalAmount), { bold: true });

  // ── Footer ──
  y += 14;
  doc.fillColor(MUTED).font("Helvetica").fontSize(8.5);
  doc.text("Bill of Supply issued by a supplier not registered under GST. No tax is charged or collected on this bill.", L, y, { width: W });
  doc.text("This is a computer-generated document and does not require a signature.", L, doc.y + 3, { width: W });
  doc.fillColor(EMBER).font("Helvetica-Bold").fontSize(10).text("Thank you for shopping with Infinitycraftspace!", L, doc.y + 12, { width: W, align: "center" });
  return doc;
}

module.exports = { buildInvoicePdf, invoiceNumber };
