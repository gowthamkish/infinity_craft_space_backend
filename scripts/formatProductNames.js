// One-off: Title-Case the names of existing products.
//   node scripts/formatProductNames.js          → dry run (prints changes)
//   node scripts/formatProductNames.js --apply  → saves them
require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });
const mongoose = require("mongoose");
const Product = require("../models/Product");
const { formatProductName } = require("../utils/formatProductName");

(async () => {
  const apply = process.argv.includes("--apply");
  await mongoose.connect(process.env.MONGO_URI);
  const products = await Product.find({}, "name").lean();
  let changed = 0;
  for (const p of products) {
    const next = formatProductName(p.name);
    if (next === p.name) continue;
    changed++;
    console.log(`"${p.name}" → "${next}"`);
    if (apply) await Product.collection.updateOne({ _id: p._id }, { $set: { name: next } });
  }
  console.log(`${changed} of ${products.length} products ${apply ? "updated" : "would change (dry run — pass --apply)"}`);
  await mongoose.disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
